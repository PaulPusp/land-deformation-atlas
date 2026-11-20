"use strict";
const el = id => document.getElementById(id);
let data;
const map = el("map");
const chart = el("chart");
const ctx = map.getContext("2d");
const plot = chart.getContext("2d");
const productSelect = el("product");
const metric = el("metric");
const start = el("start"), end = el("end"), view = el("view");
const overlays = [];
const overlayColors = ["#ffd866", "#74e6ee", "#ecabdb"];
const diverging = [[40, 106, 181], [241, 242, 225], [190, 61, 33]];
const sequential = [[28, 46, 58], [38, 111, 102], [218, 242, 165]];
let product, selected, centers, interval, aoi, picking, firstCorner;

function loadAtlas(dataset, selection) {
  data = dataset;
  aoi = selection?.box ?? null;
  picking = false;
  firstCorner = null;
  for (const id of ["west","south","east","north"]) el(id).value = aoi ? aoi[["west","south","east","north"].indexOf(id)] : "";
  productSelect.replaceChildren();
  el("context").replaceChildren();
  overlays.length = 0;
  el("context-group").hidden = data.context.length === 0;
  el("status").textContent = data.synthetic ? "Synthetic data" : "Loaded grid";
  el("title").textContent = data.title;
  for (const [i, p] of data.products.entries()) productSelect.add(new Option(p.name, i));
  for (const [i, layer] of data.context.entries()) {
    const label = document.createElement("label");
    label.className = "opt";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = true;
    toggle.addEventListener("change", draw);
    const caption = document.createElement("span");
    caption.textContent = layer.name;
    caption.style.borderBottom = "3px " + (i % 2 ? "dashed " : "solid ") + overlayColors[i % overlayColors.length];
    label.append(toggle, caption);
    label.title = layer.source;
    overlays.push(toggle);
    el("context").append(label);
  }
  productSelect.value = selection?.productIndex ?? 0;
  view.value = "3d";
  setProduct();
  if (selection) {
    start.value = selection.start;
    end.value = selection.end;
    setAOI(selection.box);
    applyDates();
  }
}

function color(t, palette) {
  const x = Math.max(0, Math.min(2, 2 * t));
  const i = Math.min(1, Math.floor(x));
  return "rgb(" + palette[i].map((c, k) => Math.round(c + (palette[i + 1][k] - c) * (x - i))).join(",") + ")";
}

function setProduct() {
  product = data.products[Number(productSelect.value)];
  selected = product.reference;
  const earliest = product.frames.reduce((min, f) => f.start < min ? f.start : min, product.frames[0].start);
  const latest = product.frames.at(-1).end;
  for (const field of [start, end]) {
    field.min = earliest;
    field.max = latest;
  }
  start.value = product.frames.at(-1).start;
  end.value = latest;
  el("method").replaceChildren(...[
    "Coverage: " + earliest + " to " + latest + ". Select two distinct acquisition dates.",
    product.mode === "pair"
      ? "Pair mode requires an exact listed interval. Available spans: " + [...new Set(product.frames.map(f => days(f.start, f.end)))].sort((a,b) => a-b).join(", ") + " days."
      : "Common-baseline mode subtracts the two selected LOS grids. The baseline is zero. Shortest available gap: " + Math.min(...product.frames.map((f, i) => days(i ? product.frames[i-1].end : earliest, f.end))) + " days.",
    "Dates are never interpolated. Positive LOS is toward the satellite. Pixels must pass the source masks and coherence threshold (" + product.threshold + "). Pair quality is coherence. For differenced dates, the view shows the lower endpoint coherence.",
    "Velocity uses the full cumulative stack. Relief is an elevation surface with exaggerated height. Color carries the LOS measurement. A rectangle filters the loaded footprint. Hazard overlays are available in top-down view."
  ].map(message => Object.assign(document.createElement("p"), {textContent:message})));
  el("interval-list").replaceChildren(...product.frames.map(f =>
    Object.assign(document.createElement("li"), {textContent:f.start + " → " + f.end})));
  view.options[0].disabled = !product.terrain?.some(Number.isFinite);
  if (view.options[0].disabled) view.value = "2d";
  const velocityAvailable = product.velocity.some(value => value !== null);
  metric.options[2].disabled = !velocityAvailable;
  if (!velocityAvailable && metric.value === "velocity") metric.value = "los";
  el("source").textContent = product.source;
  el("corrections").textContent = product.corrections;
  el("provenance").textContent = "Reference pixel " + product.reference + " · Minimum coherence " + product.threshold;
  applyDates();
}

function days(a,b) { return (Date.parse(b) - Date.parse(a)) / 86400000; }

function applyDates() {
  const a = start.value, b = end.value;
  const last = product.frames.find(f => f.end === b);
  const first = product.frames.find(f => f.end === a);
  interval = null;
  if (a && b && a < b && last) {
    if (last.start === a) interval = last;
    else if (product.mode === "cumulative" && first) {
      interval = {start:a, end:b, id:first.id + " → " + last.id,
        los:last.los.map((value,i) => value === null || first.los[i] === null ? null : value - first.los[i]),
        quality:last.quality.map((value,i) => value === null || first.quality[i] === null ? null : Math.min(value, first.quality[i]))};
    }
  }
  el("feedback").textContent = interval ? "" : "No observation for these dates. Check the acquisition list and select a supported interval.";
  metric.value = "los";
  draw();
}

function inAOI(lon,lat) {
  return !aoi || (lon >= aoi[0] && lat >= aoi[1] && lon <= aoi[2] && lat <= aoi[3]);
}

function setAOI(bounds) {
  aoi = bounds;
  picking = false;
  firstCorner = null;
  ["west","south","east","north"].forEach((id,i) => el(id).value = bounds ? bounds[i] : "");
  const inside = product.lon.findIndex((lon,i) => inAOI(lon,product.lat[i]));
  if (inside >= 0 && !inAOI(product.lon[selected],product.lat[selected])) selected = inside;
  draw();
}

function geometry(shape, project) {
  const path = (coordinates, close) => {
    coordinates.forEach((p, i) => {
      const xy = project(...p);
      if (i === 0) ctx.moveTo(...xy);
      else ctx.lineTo(...xy);
    });
    if (close) ctx.closePath();
  };
  const c = shape.coordinates;
  switch (shape.type) {
    case "Point": {
      const [x, y] = project(...c);
      ctx.moveTo(x + 4, y);
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      break;
    }
    case "LineString": path(c, false); break;
    case "Polygon": c.forEach(ring => path(ring, true)); break;
    case "MultiPoint": c.forEach(p => geometry({type:"Point",coordinates:p}, project)); break;
    case "MultiLineString": c.forEach(line => path(line, false)); break;
    case "MultiPolygon": c.forEach(poly => poly.forEach(ring => path(ring, true))); break;
    case "GeometryCollection": shape.geometries.forEach(g => geometry(g, project)); break;
  }
}

function draw() {
  const frame = interval;
  el("dates").textContent = frame ? frame.start + " → " + frame.end + " · " + days(frame.start, frame.end) + " days" : "";
  el("dates").title = frame?.id ?? "";
  const mode = metric.value;
  const isQuality = mode === "quality";
  const palette = isQuality ? sequential : diverging;
  const raw = !frame ? product.lon.map(() => null) : mode === "velocity" ? product.velocity : frame[mode];
  const inside = product.lon.map((lon,i) => inAOI(lon,product.lat[i]));
  const values = raw.map((value,i) => inside[i] ? value : null);
  const count = inside.filter(Boolean).length;
  el("aoi-status").textContent = picking ? (firstCorner ? "Pick the opposite corner." : "Pick the first corner on the map.") :
    count ? (aoi ? "Selected rectangle · " + count + " pixel centers" : "Full loaded footprint") : "No coverage within this AOI.";
  const domain = mode === "velocity" ? [values] : [...product.frames.map(item => item[mode]), values];
  const limit = isQuality ? 1 : Math.max(1, ...domain.map(series => series.reduce((max, x) => Math.max(max, Math.abs(x ?? 0)), 0)));
  const name = metric.selectedOptions[0].text;
  el("map-title").textContent = name;
  el("legend-title").textContent = name + (isQuality ? " (0–1)" : mode === "velocity" ? " (mm/year)" : " (mm)");
  el("legend-note").textContent = isQuality ? "Coherence measures phase consistency." : "Negative is away from the sensor. Positive is toward it.";
  el("coverage").textContent = Math.round(100 * values.filter(x => x !== null).length / (count || 1)) + "% displayed";
  el("gradient").style.background = "linear-gradient(90deg," + palette.map((_c, i) => color(i / 2, palette)).join(",") + ")";
  el("scale").replaceChildren(...(isQuality ? [0, 0.5, 1] : [-limit, 0, limit]).map(x => {
    const span = document.createElement("span");
    span.textContent = Number(x.toFixed(1));
    return span;
  }));

  const w = map.width, h = map.height;
  const west = Math.min(...product.edge_lon), east = Math.max(...product.edge_lon);
  const south = Math.min(...product.edge_lat), north = Math.max(...product.edge_lat);
  const relief = view.value === "3d" && product.terrain?.some(Number.isFinite);
  const radians = Math.PI / 180;
  const angle = Number(el("rotation").value) * radians;
  const tilt = Number(el("tilt").value) * radians;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const ratio = Math.max(0.008, Math.cos((north + south) / 2 * radians)) * (east-west);
  const extent = Math.max(ratio, north-south);
  const factor = relief ? Math.min(w,h) * 0.78 : Math.min(w,h) * 0.86;
  const floor = relief ? product.terrain.reduce((min,v) => v === null ? min : Math.min(min,v), Infinity) : 0;
  function project(lon, lat, elevation = floor) {
    const x = (lon - (west+east)/2) * ratio / (east-west || 1) / extent * factor;
    const y = ((north+south)/2 - lat) / extent * factor;
    const depth = x * sin + y * cos;
    const z = ((elevation ?? floor) - floor) * 1.6 / (extent * 111195) * factor;
    return relief
      ? [w/2 + x*cos - y*sin, h/2 + depth*Math.cos(tilt) - z*Math.sin(tilt), depth*Math.sin(tilt)+z*Math.cos(tilt)]
      : [w/2 + x, h/2 + y, 0];
  }
  el("rotation").disabled = el("tilt").disabled = !relief;
  overlays.forEach(toggle => { toggle.disabled = Boolean(relief); });
  el("orientation").textContent = relief ? "3D · 1.6× height" : "↑ N";
  centers = product.lon.map((lon, i) => project(lon, product.lat[i], product.terrain?.[i]));
  ctx.fillStyle = "#121c31";
  ctx.fillRect(0, 0, w, h);
  const stride = product.width + 1;
  const edge = product.edge_lon.map((lon, i) => {
    let height = floor;
    if (relief) {
      const row = Math.floor(i / stride), col = i % stride;
      const adjacent = [];
      for (const r of [row-1,row]) for (const c of [col-1,col]) {
        if (r >= 0 && r < product.height && c >= 0 && c < product.width) {
          const z = product.terrain[r*product.width+c];
          if (Number.isFinite(z)) adjacent.push(z);
        }
      }
      if (adjacent.length) height = adjacent.reduce((sum,z) => sum+z,0) / adjacent.length;
    }
    return project(lon, product.edge_lat[i], height);
  });
  const order = values.map((_value,i) => i).sort((a,b) => centers[a][2] - centers[b][2]);
  order.forEach(i => {
    const value = values[i];
    const upper = i + Math.floor(i / product.width);
    const corners = [edge[upper], edge[upper+1], edge[upper+stride+1], edge[upper+stride]];
    ctx.fillStyle = !inside[i] ? "#172830" : value === null ? "#2d4850" : color(isQuality ? value : (value / limit + 1) / 2, palette);
    ctx.beginPath();
    ctx.moveTo(...corners[0]);
    corners.slice(1).forEach(corner => ctx.lineTo(...corner));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    if (value === null && inside[i]) {
      ctx.strokeStyle = "#48626a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(...corners[3]);
      ctx.lineTo(...corners[1]);
      ctx.stroke();
    }
  });
  if (!relief) data.context.forEach((layer, i) => {
    if (!overlays[i].checked) return;
    ctx.strokeStyle = overlayColors[i % overlayColors.length];
    ctx.lineWidth = 2.5;
    ctx.setLineDash(i % 2 ? [7, 5] : []);
    for (const feature of layer.data.features) {
      if (!feature.geometry) continue;
      ctx.beginPath();
      geometry(feature.geometry, (lon, lat) => project(lon, lat));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  });
  if (!relief && (aoi || firstCorner)) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    if (aoi) {
      const [x,y] = project(aoi[0],aoi[3]);
      const [right,bottom] = project(aoi[2],aoi[1]);
      ctx.strokeRect(x,y,right-x,bottom-y);
    }
    if (firstCorner) {
      const [x,y] = project(...firstCorner);
      ctx.strokeRect(x-4,y-4,8,8);
    }
  }
  ctx.font = "14px system-ui";
  ctx.fillStyle = "#e0eeeb";
  ctx.fillText(west.toFixed(3) + "°", 15, h - 7);
  ctx.fillText(east.toFixed(3) + "°", w - 80, h - 7);
  ctx.fillText(north.toFixed(3) + "°", 15, 16);
  ctx.fillText(south.toFixed(3) + "°", 90, h - 7);
  for (const [index, size, ink] of [[product.reference, 6, "#173d35"], [selected, 10, "#fff"]]) {
    ctx.beginPath();
    if (!inside[index]) continue;
    ctx.arc(...centers[index].slice(0,2), size, 0, 2 * Math.PI);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  inspect(frame);
}

function inspect(frame) {
  const available = frame && inAOI(product.lon[selected], product.lat[selected]);
  if (!available) {
    el("point").textContent = "No observation";
    el("point-value").textContent = "";
    el("chart-note").textContent = "";
    el("download").removeAttribute("href");
    plot.clearRect(0,0,chart.width,chart.height);
    return;
  }
  el("point").textContent = product.lat[selected].toFixed(4) + "°, " + product.lon[selected].toFixed(4) + "°";
  const format = (value, units) => value === null ? "Missing" : value.toFixed(2) + units;
  el("point-value").textContent = format(frame.los[selected], " mm LOS") + " · Coherence " + format(frame.quality[selected], "");
  el("chart-note").textContent = product.mode === "pair"
    ? "Each dot is an independent interferogram interval." : "Common-baseline series · Velocity " + format(product.velocity[selected], " mm/year");
  const rows = product.frames.map(f => [f.start, f.end, f.los[selected], f.quality[selected]]);
  const csv = "start,end,los_mm,coherence\n" + [[frame.start,frame.end,frame.los[selected],frame.quality[selected]]].map(row => row.join(",")).join("\n");
  el("download").href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
  const w = chart.width, h = chart.height;
  plot.clearRect(0, 0, w, h);
  const range = Math.max(1, ...rows.map(row => Math.abs(row[2] ?? 0)));
  const t = rows.map(row => Date.parse(row[1]));
  const selectedTime = product.frames.findIndex(f => f.end === frame.end);
  const x = i => 62 + (t[i] - t[0]) / (t.at(-1) - t[0] || 1) * (w - 156);
  const y = n => (h - 26) / 2 - n / range * (h - 63) / 2;
  plot.font = "14px system-ui";
  plot.strokeStyle = "#dce7e2";
  plot.fillStyle = "#3b5758";
  for (const v of [range, 0, -range]) {
    plot.fillText(v.toFixed(1), 6, y(v) + 5);
    plot.beginPath();
    plot.moveTo(59, y(v));
    plot.lineTo(w - 26, y(v));
    plot.stroke();
  }
  plot.fillText("LOS mm", w - 80, 15);
  plot.fillText(rows[0][1], 61, h - 8);
  if (rows.length > 1) plot.fillText(rows.at(-1)[1], w - 97, h - 8);
  rows.forEach((row, i) => {
    if (row[2] === null) return;
    if (product.mode === "cumulative" && i && rows[i-1][2] !== null) {
      plot.strokeStyle = "#217f6e";
      plot.lineWidth = 2;
      plot.beginPath();
      plot.moveTo(x(i-1), y(rows[i-1][2]));
      plot.lineTo(x(i), y(row[2]));
      plot.stroke();
    }
    plot.beginPath();
    plot.arc(x(i), y(row[2]), i === selectedTime ? 6 : 4, 0, 2 * Math.PI);
    plot.fillStyle = i === selectedTime ? "#ae502c" : "#217f6e";
    plot.fill();
  });
}

map.addEventListener("click", event => {
  const bounds = map.getBoundingClientRect();
  const x = (event.clientX - bounds.left) * map.width / bounds.width;
  const y = (event.clientY - bounds.top) * map.height / bounds.height;
  let best = Infinity;
  let nearest = selected;
  centers.forEach(([cx, cy], i) => {
    const distance = (cx - x) ** 2 + (cy - y) ** 2;
    if (distance < best) {
      best = distance;
      nearest = i;
    }
  });
  if (picking) {
    const point = [product.lon[nearest], product.lat[nearest]];
    if (!firstCorner) firstCorner = point;
    else {
      const [lon,lat] = firstCorner;
      if (lon !== point[0] && lat !== point[1]) {
        setAOI([Math.min(lon,point[0]),Math.min(lat,point[1]),Math.max(lon,point[0]),Math.max(lat,point[1])]);
        return;
      }
    }
  } else if (inAOI(product.lon[nearest],product.lat[nearest])) selected = nearest;
  draw();
});
map.addEventListener("keydown", event => {
  const offsets = {ArrowDown:[1,0], ArrowUp:[-1,0], ArrowLeft:[0,-1], ArrowRight:[0,1]};
  if (!(event.key in offsets)) return;
  event.preventDefault();
  const [dr, dc] = offsets[event.key];
  const row = Math.max(0, Math.min(product.height - 1, Math.floor(selected / product.width) + dr));
  const col = Math.max(0, Math.min(product.width - 1, selected % product.width + dc));
  const next = row * product.width + col;
  if (inAOI(product.lon[next],product.lat[next])) selected = next;
  draw();
});
productSelect.addEventListener("change", setProduct);
metric.addEventListener("change", draw);
el("apply").addEventListener("click", applyDates);
el("view").addEventListener("change", () => {
  if (view.value === "3d") { picking = false; firstCorner = null; }
  draw();
});
for (const id of ["tilt","rotation"]) el(id).addEventListener("input",draw);
el("aoi-pick").addEventListener("click", () => {
  picking = true;
  firstCorner = null;
  view.value = "2d";
  draw();
});
el("aoi-reset").addEventListener("click", () => setAOI(null));
el("aoi-apply").addEventListener("click", () => {
  const bounds = ["west","south","east","north"].map(id => el(id).valueAsNumber);
  const [w,s,e,n] = bounds;
  if (!bounds.every(Number.isFinite) || w >= e || s >= n || w < -180 || e > 180 || s < -90 || n > 90) {
    el("aoi-status").textContent = "Use valid coordinates with west < east and south < north.";
    return;
  }
  setAOI(bounds);
});
window.loadDeformationAtlas = loadAtlas;
