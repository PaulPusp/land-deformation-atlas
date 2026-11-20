"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const collections = [
    ["s1", "Sentinel-1 ARIA", "ARIA_S1_GUNW"],
    ["nisar", "NISAR validated", "NISAR_L2_GUNW_V1"],
    ["nisar", "NISAR provisional", "NISAR_L2_GUNW_PROVISIONAL_V1"]
  ];
  const fields = ["west", "south", "east", "north"].map(id => $("search-" + id));
  const today = new Date();
  $("search-end").value = today.toISOString().slice(0, 10);
  today.setUTCMonth(today.getUTCMonth() - 3);
  $("search-start").value = today.toISOString().slice(0, 10);

  let activeSelection;
  let stage = 1;
  let loadSequence = 0;
  function showStep(step) {
    stage = step;
    $("catalog-step").hidden = step !== 1;
    $("displacement-step").hidden = step !== 2;
    $("search-step").removeAttribute("aria-current");
    $("viewer-step").removeAttribute("aria-current");
    $(step === 1 ? "search-step" : "viewer-step").setAttribute("aria-current", "step");
    $(step === 1 ? "archive-title" : "viewer-title").focus();
    if (step === 1) map?.invalidateSize({pan:false});
    window.scrollTo(0,0);
  }

  function openViewer(selection) {
    activeSelection = selection;
    loadSequence++;
    $("viewer-step").disabled = false;
    $("grid-view").hidden = true;
    $("import-grid").value = "";
    $("import-status").textContent = "";
    $("selected-source").hidden = !selection;
    $("selection-summary").textContent = selection
      ? selection.label + " · " + selection.start + " → " + selection.end + " · AOI " + selection.box.map(x => Number(x.toFixed(4))).join(", ")
      : "Open a geocoded dataset prepared for your study area.";
    if (selection) $("selected-source").href = selection.url;
    $("grid-instructions").textContent = selection
      ? "Load a grid prepared for this granule. Use its product ID as the frame id in your atlas config."
      : "Choose a file produced by build.py. Include a same-grid DEM to use 3D relief.";
    showStep(2);
  }

  $("search-step").addEventListener("click", () => showStep(1));
  $("back-search").addEventListener("click", () => showStep(1));
  $("viewer-step").addEventListener("click", () => showStep(2));
  $("local-step").addEventListener("click", () => openViewer(null));

  let map, rectangle, corner, footprints;
  const coords = () => fields.map(field => field.valueAsNumber);
  const valid = ([w,s,e,n]) => w >= -180 && w < e && e <= 180 && s >= -90 && s < n && n <= 90;
  function outline() {
    const [w,s,e,n] = coords();
    if (!map || !valid([w,s,e,n])) return;
    const bounds = [[s,w],[n,e]];
    if (rectangle) rectangle.setBounds(bounds);
    else rectangle = L.rectangle(bounds, {color:"#166b62",interactive:false}).addTo(map);
  }
  if (window.L) {
    map = L.map("world", {worldCopyJump:true}).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    footprints = L.layerGroup().addTo(map);
    outline();
    map.on("click", event => {
      const {lat,lng} = event.latlng.wrap();
      if (!corner) {
        corner = [lng,lat];
        $("search-status").textContent = "Choose the opposite corner.";
        return;
      }
      const box = [Math.min(lng,corner[0]),Math.min(lat,corner[1]),Math.max(lng,corner[0]),Math.max(lat,corner[1])];
      corner = null;
      if (!valid(box)) {
        $("search-status").textContent = "Choose two distinct corners.";
        return;
      }
      fields.forEach((field,i) => field.value = box[i].toFixed(5));
      outline();
      $("search-status").textContent = "AOI selected. Choose a date range and find products.";
    });
  } else {
    $("world").textContent = "The basemap could not load. Enter bounds to search the archive.";
  }
  fields.forEach(field => field.addEventListener("change",outline));

  function addFootprints(entry) {
    if (!map) return;
    const options = {interactive:false, color:"#4e698d", weight:1, fillOpacity:0.05};
    for (const group of entry.polygons ?? []) {
      for (const polygon of group) {
        const numbers = polygon.trim().split(/\s+/).map(Number);
        if (numbers.length < 6 || numbers.length % 2 || !numbers.every(Number.isFinite)) continue;
        const points = numbers.filter((_x,i) => i % 2 === 0).map((lat,i) => [lat,numbers[2*i+1]]);
        if (Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1])) <= 180) {
          L.polygon(points, options).addTo(footprints);
        }
      }
    }
  }

  $("coverage-form").addEventListener("submit", async event => {
    event.preventDefault();
    const box = coords();
    const start = $("search-start").value, end = $("search-end").value;
    if (!valid(box) || !start || !end || start > end) {
      $("search-status").textContent = "Enter valid bounds and an ordered date range. Split an AOI that crosses the antimeridian into two searches.";
      return;
    }
    const chosen = collections.filter(([mission]) => $("mission").value === "all" || mission === $("mission").value);
    outline();
    footprints?.clearLayers();
    $("search-results").replaceChildren();
    $("search-coverage").disabled = true;
    $("search-status").textContent = "Searching NASA Earthdata…";
    try {
      const outcomes = await Promise.allSettled(chosen.map(async ([_mission,label,shortName]) => {
        const query = new URLSearchParams({
          provider:"ASF", short_name:shortName, bounding_box:box.join(","),
          temporal:start + "T00:00:00Z," + end + "T23:59:59Z", page_size:"15",
          sort_key:"-start_date"
        });
        const response = await fetch("https://cmr.earthdata.nasa.gov/search/granules.json?" + query, {signal:AbortSignal.timeout(20000)});
        if (!response.ok) throw new Error("Catalog HTTP " + response.status);
        return {label, entries:(await response.json()).feed.entry};
      }));
      for (const [i,outcome] of outcomes.entries()) {
        const section = document.createElement("section");
        const heading = document.createElement("h3");
        section.append(heading);
        const label = chosen[i][1];
        if (outcome.status === "rejected") heading.textContent = label + " · search unavailable";
        else {
          const entries = outcome.value.entries;
          heading.textContent = label + " · " + (entries.length === 15 ? "latest 15 returned" : entries.length + " returned");
          const list = document.createElement("ul");
          for (const entry of entries) {
            addFootprints(entry);
            const li = document.createElement("li");
            li.className = "result";
            const name = entry.producer_granule_id ?? entry.title;
            const intervalStart = (entry.time_start ?? "").slice(0,10);
            const intervalEnd = (entry.time_end ?? "").slice(0,10);
            const url = "https://search.earthdata.nasa.gov/search/granules?p=" + encodeURIComponent(entry.collection_concept_id) + "&q=" + encodeURIComponent(name);
            const description = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = intervalStart + " → " + intervalEnd;
            const id = document.createElement("small");
            id.textContent = name;
            description.append(title,id);
            const choose = document.createElement("button");
            choose.type = "button";
            choose.textContent = "Select product";
            choose.setAttribute("aria-label", "Select " + name);
            choose.addEventListener("click", () => openViewer({name, label, start:intervalStart, end:intervalEnd, box, url}));
            li.append(description, choose);
            list.append(li);
          }
          section.append(list);
        }
        $("search-results").append(section);
      }
      $("search-status").textContent = "Results intersect the selected bounds and date window. Verify the exact acquisition pair and footprint before preparing a displacement grid.";
    } finally {
      $("search-coverage").disabled = false;
    }
  });

  const numbers = (values, length, nullable = false) => Array.isArray(values) && values.length === length &&
    values.every(n => Number.isFinite(n) || (nullable && n === null));
  function validProduct(p) {
    const size = p?.width * p?.height;
    const edges = (p?.width + 1) * (p?.height + 1);
    return Number.isInteger(p?.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 &&
      size <= 20000 && Number.isInteger(p.reference) && p.reference >= 0 && p.reference < size &&
      ["pair","cumulative"].includes(p.mode) && numbers(p.lon,size) && numbers(p.lat,size) &&
      numbers(p.edge_lon,edges) && numbers(p.edge_lat,edges) && numbers(p.velocity,size,true) &&
      (p.terrain == null || numbers(p.terrain,size,true)) && Array.isArray(p.frames) && p.frames.length > 0 &&
      p.frames.every(f => typeof f.start === "string" && typeof f.end === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(f.start) && /^\d{4}-\d{2}-\d{2}$/.test(f.end) &&
        f.start < f.end && numbers(f.los,size,true) && numbers(f.quality,size,true));
  }
  $("import-grid").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    const status = $("import-status");
    const selection = activeSelection;
    const generation = ++loadSequence;
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error("Use a prepared atlas file under 40 MB.");
      const raw = (await file.text()).trim();
      if (generation !== loadSequence) return;
      const dataset = JSON.parse(raw.replace(/^window\.ATLAS\s*=\s*/, "").replace(/;$/, ""));
      if (!Array.isArray(dataset?.products) || !dataset.products.length || !dataset.products.every(validProduct) ||
          !Array.isArray(dataset.context) || dataset.context.some(layer => !Array.isArray(layer?.data?.features))) {
        throw new Error("Use a compatible atlas dataset produced by build.py.");
      }
      let binding;
      if (selection) {
        const canonical = id => String(id).replace(/\.(?:h5|nc|zip)$/i,"");
        const matches = [];
        dataset.products.forEach((product, index) => {
          const frame = product.frames.find(f => canonical(f.id) === canonical(selection.name));
          if (frame) matches.push({product,index,frame});
        });
        if (dataset.synthetic || !matches.length) throw new Error("This file does not contain the selected Earthdata granule.");
        const [west,south,east,north] = selection.box;
        const match = matches.find(({product}) => product.lon.some((lon,i) =>
          lon >= west && lon <= east && product.lat[i] >= south && product.lat[i] <= north));
        if (!match) throw new Error("The prepared granule has no pixel centers in the selected AOI.");
        binding = {productIndex:match.index,start:match.frame.start,end:match.frame.end,box:selection.box};
      }
      window.loadDeformationAtlas(dataset,binding);
      $("grid-view").hidden = false;
      status.textContent = "Loaded " + file.name + ".";
      if (stage === 2) $("grid-view").scrollIntoView({block:"start"});
    } catch (error) {
      if (generation === loadSequence) status.textContent = "Could not load the dataset. " + error.message;
    } finally {
      if (generation === loadSequence) $("import-grid").value = "";
    }
  });
})();
