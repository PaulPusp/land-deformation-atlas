# Land Deformation Atlas

An interactive browser viewer and reproducible Python pipeline for comparing geocoded SAR interferometry products with local landslide and flood context. Open [the live viewer](https://paulpusp.github.io/land-deformation-atlas/) to search for an InSAR product or load a prepared grid. A synthetic fixture is available for local testing.

## What the viewer shows

- Sentinel-1-style cumulative LOS displacement and NISAR-style individual interferogram intervals.
- Custom AOI rectangles, start and end date selection, coherence, valid-pixel coverage, and relative LOS velocity for a common-baseline series.
- Rotatable 3D relief from a same-grid elevation GeoTIFF specified as terrain in the product config. The Trishuli demo uses synthetic terrain. Switch to top-down to view overlays or pick AOI corners.
- Toggleable GeoJSON context, pixel inspection by click or arrow keys, and selected-pixel CSV export.

## Run it

Python 3.10 or later is required. The viewer itself needs no backend or external dependencies.

```bash
python -m pip install -r requirements.txt
python examples/make_demo.py inputs/demo
python build.py inputs/demo/config.json inputs/demo/data.js
python -m http.server 8000 --directory docs
```

Visit http://localhost:8000, select **Open prepared dataset**, and choose inputs/demo/data.js to load the synthetic fixture. For GitHub Pages, publish from the main branch and the /docs folder. Treat data.js as public when publishing. The output includes the coordinates and values of the displayed pixels.

## From satellite product to viewer

| Branch | Starting input | Analysis and checks |
|---|---|---|
| Sentinel-1 pair | ASF HyP3 GAMMA LOS displacement and correlation GeoTIFFs | Use the documented positive-toward convention for the LOS raster. Supply a valid-water or connected-component mask when available. Each pair retains its own start and end dates. |
| Sentinel-1 time series | Geocoded MintPy stack from a consistent Sentinel-1 track, or a verified common-baseline DISP-S1 stack where available | Export cumulative displacement, quality and applicable masks. Verify common reference date, track, sign and stable spatial reference before enabling a trend. Retain ascending and descending tracks separately. |
| NISAR pair | ASF NISAR L2 GUNW unwrapped phase, coherence magnitude and connected components | Export matching geocoded bands from the same polarization and frequency group. Record granule wavelength, phase convention, chronological direction and any applied corrections. Supply a reference point that is stable and lies in a valid component. |
| Flood and landslide context | Event extent, inventory, rainfall station or terrain barrier in a CRS-bearing vector file | Supply source, event date and resolution or positional accuracy. Use independently mapped context. Spatial overlap supports investigation. Causal interpretation needs stronger evidence. |

The builder consumes already geocoded and harmonized single-band rasters. For HyP3, use the optional LOS output, commonly named *_los_disp.tif, and the coherence raster, commonly *_corr.tif. For NISAR, inspect the product HDF5 with the ASF specification and use the crop exporter below. Inspect coordinate alignment and CRS after export. The exporter copies the source phase and does not apply ionospheric, tropospheric or other corrections. Record which corrections you apply upstream. Raw SLC coregistration, interferogram generation, correction and network inversion belong upstream in a processor such as HyP3 or MintPy paired with a supported InSAR production workflow.

```bash
python examples/export_nisar.py granule.h5 \
  /science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/HH \
  inputs/nisar/pair01 --window 400 500 80 120
```

Replace the polarization and window with values verified in the granule. The exporter writes unwrappedPhase.tif, coherenceMagnitude.tif and connectedComponents.tif. Use these as signal, coherence and components in the config.

Use the same crop and grid for all bands and dates within a dataset. Each dataset can have a different grid. Keep an AOI under 20,000 pixels for this static client. Crop using the same pixel window in each aligned product. Reprojection is generally best done upstream with continuous and categorical layers handled appropriately. Supply valid masks as 1 for accepted pixels and 0 elsewhere. Use connected-component labels with positive integer IDs and zero or nodata for unconnected pixels.

Start from [the Sentinel-1 config example](examples/sentinel1.config.json). Paths are relative to that config. The reference is a zero-based raster row/column. For unwrapped phase change the unit to radian, add wavelength_m and a components path for every frame, and set toward_sign to the sign that maps chronological phase differences to positive-toward LOS. Benchmark this convention on a published or surveyed example before interpreting a real NISAR result. Sentinel-1 and NISAR product labels, source IDs, corrections and acquisition dates come from user-supplied metadata and should be checked against the granules.

## Date and AOI selection

Use the available intervals in the side panel. Cumulative mode calculates the signed endpoint difference on the intersection of valid pixels. Pair mode requires the exact recorded start and end. A custom AOI is a lon/lat bounding box applied to the loaded pixels. The browser does not fetch new satellite acquisitions.

## Interpretation and acceptance

The pipeline intersects finite signal and quality, the coherence threshold, an optional validity mask, and the reference component when supplied. It subtracts the contemporaneous stable reference pixel. For phase inputs, it converts radians to mm using 1000 times wavelength divided by 4π and the explicit sign multiplier. Low coherence means missing or unreliable observations. The default threshold of 0.35 is exploratory. Report coverage and check sensitivity to threshold and reference-site choice.

The velocity is an exploratory ordinary least-squares slope in mm/year over three or more common-baseline endpoints and requires every epoch to be valid at the pixel. It has no uncertainty estimate and can be confounded by atmosphere, seasonality and autocorrelated errors. Pair observations are never summed or annualized by the viewer. For publication, include a longer observation window, trend uncertainty, independent reference or GNSS checks, and relevant terrain observability and atmospheric diagnostics.

For a Trishuli landslide pilot, check slope aspect against the satellite look vector and flag layover, shadow, vegetation decorrelation and rapid movement that can escape phase tracking. Cross-check coherent candidates with independent inventories, optical change or field evidence. For a GBM floodplain pilot, analyze coherent structures and embankments separately from water and seasonally flooded fields. Add a dated inundation footprint from a separate flood-mapping workflow. River and flood-mask pixels with missing LOS provide no evidence about motion.

Keep missions and look directions separate until intervals, reference and LOS geometry are compatible. Pair displacement is relative to the chosen reference and projected along the line of sight. Quantifying vertical or slope-parallel motion requires geometry and explicit assumptions or additional measurements.

### Sources

- [ASF HyP3 Sentinel-1 InSAR product guide](https://hyp3-docs.asf.alaska.edu/guides/insar_product_guide/)
- [ASF NISAR GUNW product guide](https://nisar-docs.asf.alaska.edu/gunw/)
- [NASA provisional NISAR GUNW collection](https://data.nasa.gov/dataset/nisar-provisional-geocoded-unwrapped-interferogram-product-version-1-cea8a)
- [JPL OPERA DISP-S1 product specification](https://d2pn8kiwq2w21t.cloudfront.net/documents/OPERA_DISP_S1_Final_Product_Spec.pdf)
- [Yunjun, Fattahi and Amelung (2019), small-baseline time-series analysis and error correction](https://doi.org/10.1016/j.cageo.2019.104331)

## Find data outside the demo

Draw a rectangle on the world map or type its geographic bounds. Choose a search window and select the Sentinel-1 ARIA or NISAR GUNW archive. NASA CMR returns products intersecting the bounds and overlapping the window. The site shows up to 15 results per collection. Footprint overlap does not imply complete coverage or usable coherence over the AOI. Choose **Select product** on a result to open the displacement workspace with its AOI and metadata. Use **Open in Earthdata** to inspect the source granule.

To render observations for that region, download an appropriate source product, prepare the rasters as described above, and run the build command with your AOI config. Set each frame id to its Earthdata granule ID, then choose the resulting data.js in **Choose prepared file**. The viewer checks the selected granule ID and AOI overlap and initializes the dates from the matching frame. The file is parsed as data on your device. Add a same-grid DEM for 3D relief. The static site searches metadata and renders prepared grids. It has no online granule processing service.

## Run the processing service

GitHub Pages serves the static interface. The Python worker needs a separate host. The Docker image serves both the interface and API on one origin. Configure EARTHDATA_TOKEN through the host secret manager. Confirm ASF accepts the configured authentication method before exposing the service.

```bash
docker build -t land-deformation-atlas .
docker run --rm -p 127.0.0.1:8000:8000 --env EARTHDATA_TOKEN land-deformation-atlas
```

With the service running, select a Sentinel-1 ARIA GUNW granule and click **Process selected AOI**. The worker resolves the granule ID using CMR, downloads its NetCDF, crops to native pixels, masks by coherence and connected component, and provides a relative LOS grid. It uses the two dates encoded in the ARIA product ID. It does not add a DEM. Automatic NISAR processing requires independent validation before release.

This implementation has a bounded, in-memory job queue and runs in a single process. Before public deployment, add account authentication and job ownership, durable job and result storage, per-user quotas, service monitoring, and real-granule validation for each supported mission. Keep Earthdata credentials out of the browser and repository.

### Hosted integration check

The Render Blueprint deploys the Docker service as a staging instance. Import this repository as a Blueprint in Render and set EARTHDATA_TOKEN in the service environment. Open the Render service URL directly, since it serves the dashboard and API together. The GitHub Pages address remains a static showcase.

Validate a small Sentinel-1 ARIA AOI from catalog selection through authenticated download and map rendering before offering the service to others. The staging plan is for integration checks. Public operation still requires account access controls, persistent jobs, monitoring, and NISAR validation.
