"use strict";
const el = id => document.getElementById(id);
const data = window.ATLAS;
const map = el("map");
const chart = el("chart");
const ctx = map.getContext("2d");
const plot = chart.getContext("2d");
const productSelect = el("product");
const metric = el("metric");
const epoch = el("epoch");
const overlays = [];
const overlayColors = ["#ffd866", "#74e6ee", "#ecabdb"];
const diverging = [[40, 106, 181], [241, 242, 225], [190, 61, 33]];
const sequential = [[28, 46, 58], [38, 111, 102], [218, 242, 165]];
let product, selected, centers;

el("status").textContent = data.synthetic ? "SYNTHETIC DEMO" : "INSAR PRODUCT";
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

function color(t, palette) {
  const x = Math.max(0, Math.min(2, 2 * t));
  const i = Math.min(1, Math.floor(x));
  return "rgb(" + palette[i].map((c, k) => Math.round(c + (palette[i + 1][k] - c) * (x - i))).join(",") + ")";
}

function setProduct() {
  product = data.products[Number(productSelect.value)];
  selected = product.reference;
  epoch.max = product.frames.length - 1;
  epoch.value = epoch.max;
  const velocityAvailable = product.velocity.some(value => value !== null);
  metric.options[2].disabled = !velocityAvailable;
  if (!velocityAvailable && metric.value === "velocity") metric.value = "los";
  el("source").textContent = product.source;
  el("corrections").textContent = product.corrections;
  el("provenance").textContent = "Reference pixel " + product.reference + " · Minimum coherence " + product.threshold;
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
  const frame = product.frames[Number(epoch.value)];
  el("dates").textContent = frame.start + " → " + frame.end;
  el("dates").title = frame.id;
  const mode = metric.value;
  const isQuality = mode === "quality";
  const palette = isQuality ? sequential : diverging;
  const values = mode === "velocity" ? product.velocity : frame[mode];
  const domain = mode === "velocity" ? [values] : product.frames.map(item => item[mode]);
  const limit = isQuality ? 1 : Math.max(1, ...domain.map(series => series.reduce((max, x) => Math.max(max, Math.abs(x ?? 0)), 0)));
  const name = metric.selectedOptions[0].text;
  el("map-title").textContent = name;
  el("legend-title").textContent = name + (isQuality ? " (0–1)" : mode === "velocity" ? " (mm/year)" : " (mm)");
  el("legend-note").textContent = isQuality ? "Coherence measures phase consistency." : "Negative is away from the sensor. Positive is toward it.";
  el("coverage").textContent = Math.round(100 * values.filter(x => x !== null).length / values.length) + "% displayed";
  el("gradient").style.background = "linear-gradient(90deg," + palette.map((_c, i) => color(i / 2, palette)).join(",") + ")";
  el("scale").replaceChildren(...(isQuality ? [0, 0.5, 1] : [-limit, 0, limit]).map(x => {
    const span = document.createElement("span");
    span.textContent = Number(x.toFixed(1));
    return span;
  }));

  const w = map.width, h = map.height;
  const west = Math.min(...product.edge_lon), east = Math.max(...product.edge_lon);
  const south = Math.min(...product.edge_lat), north = Math.max(...product.edge_lat);
  const pad = 36;
  const px = lon => pad + (lon - west) / (east - west || 1) * (w - 2 * pad);
  const py = lat => pad + (north - lat) / (north - south || 1) * (h - 2 * pad);
  centers = product.lon.map((lon, i) => [px(lon), py(product.lat[i])]);
  ctx.fillStyle = "#213840";
  ctx.fillRect(0, 0, w, h);
  const edge = product.edge_lon.map((lon, i) => [px(lon), py(product.edge_lat[i])]);
  const stride = product.width + 1;
  values.forEach((value, i) => {
    const upper = i + Math.floor(i / product.width);
    const corners = [edge[upper], edge[upper + 1], edge[upper + stride + 1], edge[upper + stride]];
    ctx.fillStyle = value === null ? "#2d4850" : color(isQuality ? value : (value / limit + 1) / 2, palette);
    ctx.beginPath();
    ctx.moveTo(...corners[0]);
    corners.slice(1).forEach(corner => ctx.lineTo(...corner));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    if (value === null) {
      ctx.strokeStyle = "#48626a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(...corners[3]);
      ctx.lineTo(...corners[1]);
      ctx.stroke();
    }
  });
  data.context.forEach((layer, i) => {
    if (!overlays[i].checked) return;
    ctx.strokeStyle = overlayColors[i % overlayColors.length];
    ctx.lineWidth = 2.5;
    ctx.setLineDash(i % 2 ? [7, 5] : []);
    for (const feature of layer.data.features) {
      if (!feature.geometry) continue;
      ctx.beginPath();
      geometry(feature.geometry, (lon, lat) => [px(lon), py(lat)]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  });
  ctx.font = "14px system-ui";
  ctx.fillStyle = "#e0eeeb";
  ctx.fillText(west.toFixed(3) + "°", 15, h - 7);
  ctx.fillText(east.toFixed(3) + "°", w - 80, h - 7);
  ctx.fillText(north.toFixed(3) + "°", 15, 16);
  ctx.fillText(south.toFixed(3) + "°", 90, h - 7);
  for (const [index, size, ink] of [[product.reference, 6, "#173d35"], [selected, 10, "#fff"]]) {
    ctx.beginPath();
    ctx.arc(...centers[index], size, 0, 2 * Math.PI);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  inspect(frame);
}

function inspect(frame) {
  el("point").textContent = product.lat[selected].toFixed(4) + "°, " + product.lon[selected].toFixed(4) + "°";
  const format = (value, units) => value === null ? "Missing" : value.toFixed(2) + units;
  el("point-value").textContent = format(frame.los[selected], " mm LOS") + " · Coherence " + format(frame.quality[selected], "");
  el("chart-note").textContent = product.mode === "pair"
    ? "Each dot is an independent interferogram interval." : "Common-baseline series · Velocity " + format(product.velocity[selected], " mm/year");
  const rows = product.frames.map(f => [f.start, f.end, f.los[selected], f.quality[selected]]);
  const csv = "start,end,los_mm,coherence\n" + rows.map(row => row.join(",")).join("\n");
  el("download").href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
  const w = chart.width, h = chart.height;
  plot.clearRect(0, 0, w, h);
  const range = Math.max(1, ...rows.map(row => Math.abs(row[2] ?? 0)));
  const t = rows.map(row => Date.parse(row[1]));
  const selectedTime = Number(epoch.value);
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
  centers.forEach(([cx, cy], i) => {
    const distance = (cx - x) ** 2 + (cy - y) ** 2;
    if (distance < best) {
      best = distance;
      selected = i;
    }
  });
  draw();
});
map.addEventListener("keydown", event => {
  const offsets = {ArrowDown:[1,0], ArrowUp:[-1,0], ArrowLeft:[0,-1], ArrowRight:[0,1]};
  if (!(event.key in offsets)) return;
  event.preventDefault();
  const [dr, dc] = offsets[event.key];
  const row = Math.max(0, Math.min(product.height - 1, Math.floor(selected / product.width) + dr));
  const col = Math.max(0, Math.min(product.width - 1, selected % product.width + dc));
  selected = row * product.width + col;
  draw();
});
productSelect.addEventListener("change", setProduct);
metric.addEventListener("change", draw);
epoch.addEventListener("input", draw);
setProduct();
