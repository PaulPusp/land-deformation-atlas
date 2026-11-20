"""Convert geocoded InSAR rasters to a small, self-contained browser dataset."""
import argparse
import json
import math
from datetime import date
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.warp import transform


def build(config_path, destination):
    config = json.loads(config_path.read_text())
    products = config["products"]
    if not products:
        raise ValueError("Provide at least one product")
    root = config_path.parent
    output = {"title": config["title"], "synthetic": config.get("synthetic", False),
              "products": [], "context": []}
    for product in products:
        grid = None

        def read(filename):
            nonlocal grid
            with rasterio.open(root / filename) as ds:
                if not ds.crs or ds.transform.b or ds.transform.d or ds.transform.a <= 0 or ds.transform.e >= 0:
                    raise ValueError(f"Expected a north-up geocoded grid: {filename}")
                if ds.width * ds.height > 20000:
                    raise ValueError("Crop to a pilot AOI of at most 20,000 pixels per grid")
                current = ds.crs, ds.transform, ds.shape
                if grid is not None and grid != current:
                    raise ValueError(f"Rasters must share a common grid: {filename}")
                grid = current
                return ds.read(1, masked=True).astype("float64").filled(np.nan)

        mode = product["mode"]
        if mode not in {"pair", "cumulative"}:
            raise ValueError("mode must be pair or cumulative")
        threshold = float(product.get("min_coherence", 0.35))
        if not 0 <= threshold <= 1:
            raise ValueError("Coherence threshold must be between zero and one")
        row, col = product["reference_pixel"]
        frames = sorted(product["frames"], key=lambda item: item["end"])
        terms = product["unit"]
        sign = product["toward_sign"]
        if sign not in {-1, 1}:
            raise ValueError("toward_sign must be +1 or -1")
        scale = {"m": 1000, "mm": 1}.get(terms)
        if terms == "radian":
            wavelength = float(product["wavelength_m"])
            if not math.isfinite(wavelength) or wavelength <= 0:
                raise ValueError("wavelength_m must be finite and positive")
            scale = 1000 * wavelength / (4 * math.pi)
        if scale is None:
            raise ValueError("unit must be m, mm or radian")
        ends = [date.fromisoformat(frame["end"]) for frame in frames]
        starts = [date.fromisoformat(frame["start"]) for frame in frames]
        if not frames or len(set(ends)) != len(ends) or any(s >= e for s, e in zip(starts, ends)):
            raise ValueError("Frames need unique end dates and positive intervals")
        if mode == "cumulative" and len(set(starts)) != 1:
            raise ValueError("Cumulative dates must share one baseline")

        values, quality = [], []
        for frame in frames:
            displacement = read(frame["signal"])
            coherence = read(frame["coherence"])
            valid = np.isfinite(displacement) & np.isfinite(coherence) & (coherence >= threshold) & (coherence <= 1)
            if "valid_mask" in frame:
                valid &= read(frame["valid_mask"]) == 1
            if not (0 <= row < valid.shape[0] and 0 <= col < valid.shape[1]) or not valid[row, col]:
                raise ValueError(f"Reference pixel fails QA for {frame['end']}")
            if terms == "radian" or "components" in frame:
                components = read(frame["components"])
                if not np.isfinite(components[row, col]) or components[row, col] <= 0:
                    raise ValueError("Reference pixel must be in a positive connected component")
                valid &= components == components[row, col]
            values.append(np.where(valid, (displacement - displacement[row, col]) * sign * scale, np.nan))
            quality.append(np.where((coherence >= 0) & (coherence <= 1), coherence, np.nan))

        terrain = read(product["terrain"]) if product.get("terrain") else None
        crs, affine, (height, width) = grid
        rows, cols = np.indices((height, width))
        xs, ys = affine * (cols.ravel() + 0.5, rows.ravel() + 0.5)
        lon, lat = transform(crs, "EPSG:4326", xs.tolist(), ys.tolist())
        edge_rows, edge_cols = np.indices((height + 1, width + 1))
        edge_x, edge_y = affine * (edge_cols.ravel(), edge_rows.ravel())
        edge_lon, edge_lat = transform(crs, "EPSG:4326", edge_x.tolist(), edge_y.tolist())
        if max(edge_lon) - min(edge_lon) > 10 or max(edge_lat) - min(edge_lat) > 10:
            raise ValueError("Viewer requires a local AOI outside the antimeridian")
        stack = np.asarray(values).reshape(len(frames), -1)
        rates = np.full(stack.shape[1], np.nan)
        if mode == "cumulative" and len(ends) >= 3:
            days = np.array([(end - starts[0]).days for end in ends], dtype=float) / 365.2425
            valid_pixels = np.isfinite(stack).all(axis=0)
            centered = days - days.mean()
            rates[valid_pixels] = centered @ stack[:, valid_pixels] / (centered @ centered)

        def numbers(array):
            return [round(float(value), 3) if np.isfinite(value) else None for value in array.ravel()]

        output["products"].append({
            "name": product["name"], "mode": mode, "source": product["source"],
            "corrections": product["corrections"], "reference": row * width + col,
            "threshold": threshold, "width": width, "height": height,
            "lon": lon, "lat": lat, "edge_lon": edge_lon, "edge_lat": edge_lat,
            "velocity": numbers(rates), "terrain": numbers(terrain) if terrain is not None else None,
            "frames": [{"start": f["start"], "end": f["end"], "id": f["id"],
                        "los": numbers(v), "quality": numbers(q)}
                       for f, v, q in zip(frames, stack, quality)],
        })
    for layer in config.get("context", []):
        features = gpd.read_file(root / layer["path"])
        if not features.crs or not features.geometry.is_valid.all() or features.geometry.is_empty.any():
            raise ValueError(f"Invalid CRS or geometry in {layer['name']}")
        output["context"].append({"name": layer["name"], "source": layer["source"],
                                  "data": json.loads(features.to_crs(4326).to_json(drop_id=True))})
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(output, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    destination.write_text("window.ATLAS = " + payload + ";\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.config, args.destination)
