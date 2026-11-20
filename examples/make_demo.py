"""Generate deterministic, explicitly synthetic InSAR and hazard-context inputs."""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
height, width = 37, 60
row, col = np.indices((height, width))
river = 24 + 7 * np.sin(col / 8)
plume = np.exp(-((row - 12 + (col - 35) / 6) ** 2 / 24 + (col - 35) ** 2 / 180))
uplift = np.exp(-((row - 29) ** 2 / 40 + (col - 48) ** 2 / 70))
signal = -3.9 * plume + 1.8 * uplift + 0.2 * np.sin(col / 3) * np.cos(row / 4)
rng = np.random.default_rng(19)
grid = from_origin(84.915, 28.038, 0.001, 0.001)


def tif(name, array):
    with rasterio.open(root / name, "w", driver="GTiff", width=width, height=height,
                       count=1, dtype="float32", crs="EPSG:4326", transform=grid,
                       nodata=-9999) as ds:
        ds.write(array.astype("float32"), 1)
    return name


terrain = 490 + 740 * (1 - np.exp(-((row - river) / 8) ** 2))
terrain += 380 * (0.5 + 0.5 * np.cos(col / 10 + row / 12)) * (1 - np.exp(-((row - river) / 7) ** 2))
terrain_file = tif("synthetic-terrain.tif", terrain)
products = []
for key, label, mode, unit, sign in [
    ("s1", "Sentinel-1 · simulated stack", "cumulative", "m", 1),
    ("ni", "NISAR · simulated pairs", "pair", "radian", -1),
]:
    product = dict(name=label, mode=mode, unit=unit, toward_sign=sign,
                   terrain=terrain_file, wavelength_m=0.24, reference_pixel=[4, 4], min_coherence=0.35,
                   source="Deterministic synthetic rasters near Trishuli, Nepal",
                   corrections="Simulation only. No satellite acquisitions or field observations.",
                   frames=[])
    for i in range(6):
        baseline = date(2026, 1, 1)
        end = baseline + timedelta(days=12 * (i + 1))
        start = baseline if mode == "cumulative" else end - timedelta(days=12)
        mm = signal * (i + 1 if mode == "cumulative" else 2.1 + 0.4 * i)
        mm += rng.normal(0, 0.22, signal.shape)
        coherence = 0.81 - 0.60 * np.exp(-(row - river) ** 2 / 4) + rng.normal(0, 0.045, signal.shape)
        scale = 1000 if unit == "m" else -0.24 * 1000 / (4 * np.pi)
        frame = dict(start=start.isoformat(), end=end.isoformat(), id=f"synthetic-{key}-{i+1}",
                     signal=tif(f"{key}-{i}.tif", mm / scale),
                     coherence=tif(f"{key}-coh-{i}.tif", np.clip(coherence, 0, 1)))
        if unit == "radian":
            frame["components"] = tif("components.tif", np.where((row > 30) & (col < 8), 2, 1))
        product["frames"].append(frame)
    products.append(product)


def context(name, coords):
    coordinates = [[float(84.915 + c * 0.001), float(28.038 - r * 0.001)] for c, r in coords]
    geometry = {"type": "Polygon", "coordinates": [coordinates]}
    path = f"{name}.geojson"
    feature = {"type": "Feature", "geometry": geometry, "properties": {}}
    (root / path).write_text(json.dumps({"type": "FeatureCollection", "features": [feature]}))
    return dict(name=name, path=path, source="Simulated context footprint")


context_layers = [
    context("Landslide inventory", [(22, 8), (47, 4), (49, 14), (38, 18), (24, 15), (22, 8)]),
    context("Flood extent", [(0, 20), (11, 29), (23, 21), (34, 15), (47, 21), (59, 28), (59, 32),
                             (47, 25), (34, 19), (23, 25), (11, 33), (0, 24), (0, 20)]),
]
(root / "config.json").write_text(json.dumps(dict(title="Trishuli Valley", synthetic=True,
                                                products=products, context=context_layers), indent=2))
