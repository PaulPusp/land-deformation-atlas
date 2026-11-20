"""Build an atlas grid from a NASA ASF Sentinel-1 ARIA GUNW catalog record."""
import json
import re
from pathlib import Path
from datetime import datetime
from urllib.parse import urlsplit

import earthaccess
import h5py
import numpy as np
import rasterio
import requests
from rasterio.transform import from_origin

from build import build

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
ASF_HOST = "cumulus.asf.earthdatacloud.nasa.gov"


def catalog_record(granule):
    response = requests.get(CMR, params={"concept_id": granule, "provider": "ASF"}, timeout=20)
    response.raise_for_status()
    records = response.json()["feed"]["entry"]
    if len(records) != 1 or records[0]["id"] != granule:
        raise ValueError("The selected ASF granule was not found.")
    return records[0]


def download_aria(record, destination):
    name = record.get("producer_granule_id", "")
    match = re.search(r"^S1-GUNW-.*?-tops-(\d{8})_(\d{8})-", name)
    if not match:
        raise ValueError("Automatic processing currently supports Sentinel-1 ARIA GUNW products.")
    urls = [link.get("href", "") for link in record.get("links", [])]
    candidates = [url for url in urls if urlsplit(url).hostname == ASF_HOST
                  and urlsplit(url).scheme == "https" and "/ARIA/ARIA_S1_GUNW/" in urlsplit(url).path
                  and urlsplit(url).path.endswith("/" + name.removesuffix(".nc") + ".nc")]
    if not candidates:
        raise ValueError("No approved ASF download was found for this product.")
    auth = earthaccess.login(strategy="environment")
    if not auth.authenticated:
        raise ValueError("The server could not authenticate with NASA Earthdata.")
    limit = 1024 * 1024 * 1024
    with earthaccess.get_requests_https_session() as session, session.get(
        candidates[0], stream=True, timeout=(15, 45)
    ) as response:
        if response.status_code in {401, 403} or urlsplit(response.url).hostname == "urs.earthdata.nasa.gov":
            raise ValueError("NASA Earthdata did not grant this server access to the ASF granule.")
        response.raise_for_status()
        if int(response.headers.get("Content-Length", 0)) > limit:
            raise ValueError("This granule exceeds the server download limit.")
        size = 0
        with destination.open("wb") as output:
            for block in response.iter_content(1024 * 1024):
                size += len(block)
                if size > limit:
                    raise ValueError("This granule exceeds the server download limit.")
                output.write(block)
    if not h5py.is_hdf5(destination):
        raise ValueError("ASF did not return a valid NetCDF-4 granule.")
    dates = [datetime.strptime(s, "%Y%m%d").date().isoformat() for s in match.groups()]
    return name, min(dates), max(dates)


def axis_slice(axis, lower, upper, increasing):
    delta = np.diff(axis)
    if (axis.ndim != 1 or not delta.size or not np.isfinite(axis).all()
            or not (np.all(delta > 0) or np.all(delta < 0))
            or not np.allclose(delta, delta[0], rtol=1e-4)):
        raise ValueError("The granule has an unsupported coordinate grid.")
    meters = float(abs(delta[0]))
    positions = np.flatnonzero((axis >= lower) & (axis <= upper))
    if not positions.size:
        raise ValueError("No native pixel centers fall inside the selected AOI. Enlarge the AOI.")
    keep_order = bool(delta[0] > 0) == increasing
    return slice(int(positions[0]), int(positions[-1]) + 1), meters, keep_order


def crop_aria(source, box, output):
    west, south, east, north = box
    with h5py.File(source, "r") as granule:
        grid = granule["science/grids/data"]
        lon = grid["longitude"][:]
        lat = grid["latitude"][:]
        cols, dx, keep_x = axis_slice(lon, west, east, True)
        rows, dy, keep_y = axis_slice(lat, south, north, False)
        width, height = cols.stop - cols.start, rows.stop - rows.start
        if width * height > 20000:
            raise ValueError("Select a smaller AOI with at most 20,000 native pixels.")
        affine = from_origin(min(lon[cols]) - dx / 2, max(lat[rows]) + dy / 2, dx, dy)
        bands = {}
        for name in ("unwrappedPhase", "coherence", "connectedComponents"):
            band = grid[name]
            if band.shape != (len(lat), len(lon)):
                raise ValueError("The granule bands do not share the expected grid.")
            values = band[rows, cols].astype("float64")
            if "_FillValue" in band.attrs:
                values[values == band.attrs["_FillValue"]] = np.nan
            values = values * float(np.asarray(band.attrs.get("scale_factor", 1)).item())
            values += float(np.asarray(band.attrs.get("add_offset", 0)).item())
            bands[name] = values[::1 if keep_y else -1, ::1 if keep_x else -1]
        wavelength = float(np.asarray(granule["science/radarMetaData/wavelength"][()]).item())
        if not .05 < wavelength < .06:
            raise ValueError("The granule wavelength is incompatible with Sentinel-1 C-band.")
    valid = np.isfinite(bands["unwrappedPhase"]) & (bands["coherence"] >= .35) & (bands["coherence"] <= 1)
    valid &= np.isfinite(bands["connectedComponents"]) & (bands["connectedComponents"] > 0)
    if not valid.any():
        raise ValueError("No connected pixels pass the coherence threshold in this AOI.")
    components, counts = np.unique(bands["connectedComponents"][valid], return_counts=True)
    largest = valid & (bands["connectedComponents"] == components[np.argmax(counts)])
    reference = np.unravel_index(np.argmax(np.where(largest, bands["coherence"], -1)), largest.shape)
    for name, values in bands.items():
        with rasterio.open(output / f"{name}.tif", "w", driver="GTiff", width=width,
                           height=height, count=1, dtype="float64", crs="EPSG:4326",
                           transform=affine, nodata=np.nan) as writer:
            writer.write(values, 1)
    return [int(v) for v in reference], wavelength


def process(granule_id, bounds, workdir, report=lambda stage: None):
    root = Path(workdir)
    source = root / "source.nc"
    report("Looking up the ASF granule…")
    record = catalog_record(granule_id)
    report("Downloading the source granule…")
    name, start, end = download_aria(record, source)
    report("Cropping the AOI and checking coherence…")
    reference, wavelength = crop_aria(source, bounds, root)
    config = {"title": "Sentinel-1 ARIA displacement", "products": [{
        "name": "Sentinel-1 ARIA GUNW", "mode": "pair", "unit": "radian", "toward_sign": 1,
        "wavelength_m": wavelength, "reference_pixel": reference, "min_coherence": .35,
        "source": name,
        "corrections": "Relative LOS. The highest-coherence pixel in the largest valid component is the reference; its stability has not been established. No additional atmospheric or ionospheric corrections were applied.",
        "frames": [{"start": start, "end": end, "id": name, "signal": "unwrappedPhase.tif",
                    "coherence": "coherence.tif", "components": "connectedComponents.tif"}]
    }]}
    path = root / "config.json"
    path.write_text(json.dumps(config))
    target = root / "data.js"
    report("Building the displacement map…")
    build(path, target)
    return json.loads(target.read_text().removeprefix("window.ATLAS = ").strip().removesuffix(";"))
