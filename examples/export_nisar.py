"""Export an AOI window from a geocoded NISAR GUNW polarization group."""
import argparse
from pathlib import Path

import h5py
import numpy as np
import rasterio
from rasterio.transform import from_origin


def export(product, group_path, window, destination):
    row, col, height, width = window
    if min(row, col) < 0 or min(height, width) < 1 or height * width > 20000:
        raise ValueError("Use a positive window with at most 20,000 cells")
    with h5py.File(product, "r") as f:
        group = f[group_path]
        grid = group.parent
        xs, ys = grid["xCoordinates"][:], grid["yCoordinates"][:]
        epsg = int(grid["projection"][()])
        dx, dy = float(grid["xCoordinateSpacing"][()]), float(grid["yCoordinateSpacing"][()])
        if dx <= 0 or dy >= 0 or not np.allclose(np.diff(xs), dx) or not np.allclose(np.diff(ys), dy):
            raise ValueError("Expected a regular north-up grid")
        if row + height > len(ys) or col + width > len(xs):
            raise ValueError("Window exceeds the product grid")
        affine = from_origin(xs[col] - dx / 2, ys[row] - dy / 2, dx, -dy)
        bands = {}
        for name in ["unwrappedPhase", "coherenceMagnitude", "connectedComponents"]:
            band = group[name]
            if band.shape != (len(ys), len(xs)):
                raise ValueError(f"{name} does not match the coordinate grid")
            values = band[row:row + height, col:col + width].astype("float64")
            fill = band.attrs.get("_FillValue")
            if fill is not None:
                values[values == fill] = np.nan
            bands[name] = values
    destination.mkdir(parents=True, exist_ok=True)
    for name, values in bands.items():
        with rasterio.open(destination / f"{name}.tif", "w", driver="GTiff", width=width,
                           height=height, count=1, dtype="float64", crs=f"EPSG:{epsg}",
                           transform=affine, nodata=np.nan) as writer:
            writer.write(values, 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", type=Path)
    parser.add_argument("group", help="Full HDF5 path to the polarization under unwrappedInterferogram")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--window", required=True, nargs=4, type=int, metavar=("ROW", "COL", "HEIGHT", "WIDTH"))
    args = parser.parse_args()
    export(args.product, args.group, args.window, args.destination)
