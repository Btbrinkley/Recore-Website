// Small dependency-free SVG charts for the Sentinel Monitor.
// - sparkline(): one series, no axes, for list rows.
// - lineChart(): one measure per chart (never two y-scales), up to two series of the
//   same unit (onboard + probe temperature), crosshair + tooltip on pointer/keyboard.
const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function extent(vals, minSpan) {
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < minSpan) {
    const pad = (minSpan - (hi - lo)) / 2;
    lo -= pad;
    hi += pad;
  } else {
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
  }
  return [lo, hi];
}

// Break the path where readings are more than `gapMs` apart (missed reports).
function pathFor(points, x, y, gapMs) {
  let d = "";
  let prev = null;
  for (const p of points) {
    const cmd = prev === null || p.t - prev > gapMs ? "M" : "L";
    d += `${cmd}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    prev = p.t;
  }
  return d;
}

function typicalGap(ts) {
  if (ts.length < 3) return Infinity;
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  gaps.sort((a, b) => a - b);
  return Math.max(gaps[Math.floor(gaps.length / 2)] * 3.5, 120e3);
}

export function sparkline(readings, {width = 120, height = 30, color = "#38d996", label = "Voltage trend"} = {}) {
  width = Math.max(60, Math.round(width));
  const pts = (readings || []).filter((r) => Number.isFinite(r.volts)).map((r) => ({t: r.t, v: r.volts}));
  const svg = el("svg", {viewBox: `0 0 ${width} ${height}`, width, height, role: "img", class: "spark"});
  if (pts.length < 2) {
    svg.setAttribute("aria-label", `${label}: not enough readings`);
    el("line", {x1: 2, x2: width - 2, y1: height / 2, y2: height / 2, stroke: "currentColor", "stroke-opacity": ".25", "stroke-dasharray": "3 4"}, svg);
    return svg;
  }
  const [lo, hi] = extent(pts.map((p) => p.v), 0.1);
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t) => 2 + ((t - t0) / Math.max(1, t1 - t0)) * (width - 4);
  const y = (v) => height - 3 - ((v - lo) / (hi - lo)) * (height - 6);
  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  svg.setAttribute("aria-label", `${label}: ${first.toFixed(2)} V to ${last.toFixed(2)} V over ${pts.length} readings`);
  el("path", {d: pathFor(pts, x, y, typicalGap(pts.map((p) => p.t))), fill: "none", stroke: color, "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round"}, svg);
  el("circle", {cx: x(t1), cy: y(last), r: 2.6, fill: color}, svg);
  return svg;
}

const fmtTime = (t, spanMs) => new Date(t).toLocaleString([], spanMs > 2 * 86400e3 ?
  {month: "short", day: "numeric"} : {hour: "numeric", minute: "2-digit"});
const fmtFull = (t) => new Date(t).toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});

// series: [{name, color, unit, decimals, points: [{t, v}]}]; bands: [{from, to, color, label}]
// Charts are drawn at their real pixel width (no stretched text) and redrawn on resize.
const drawn = new Set();
let resizeTimer = null;
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const host of drawn) {
        if (!host.isConnected) drawn.delete(host);
        else if (host.__chartArgs && host.clientWidth !== host.__chartWidth) lineChart(host, host.__chartArgs);
      }
    }, 150);
  });
}

export function lineChart(host, args) {
  const {series, title, unit, minSpan = 1, bands = [], height = 180} = args;
  host.__chartArgs = args;
  host.__chartWidth = host.clientWidth;
  drawn.add(host);
  host.replaceChildren();
  const live = series.filter((s) => s.points.length);
  const all = live.flatMap((s) => s.points);
  if (!all.length) {
    const p = document.createElement("p");
    p.className = "mon-muted mon-chart-empty";
    p.textContent = `No ${title.toLowerCase()} readings in this range.`;
    host.appendChild(p);
    return;
  }
  const W = Math.max(260, (host.clientWidth || 640) - 22);
  const H = Math.round(height * (W < 480 ? 0.85 : 1));
  const L = 40;
  const R = 12;
  const T = 12;
  const B = H - 24;
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const [lo, hi] = extent(all.map((p) => p.v), minSpan);
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);

  const fig = document.createElement("figure");
  fig.className = "mon-chart";
  const cap = document.createElement("figcaption");
  cap.textContent = title;
  fig.appendChild(cap);
  if (live.length > 1) {
    const leg = document.createElement("div");
    leg.className = "mon-legend";
    for (const s of live) {
      const i = document.createElement("span");
      const sw = document.createElement("i");
      sw.style.background = s.color;
      i.append(sw, document.createTextNode(s.name));
      leg.appendChild(i);
    }
    fig.appendChild(leg);
  }
  const wrap = document.createElement("div");
  wrap.className = "mon-chart-wrap";
  const svg = el("svg", {viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0",
    "aria-label": `${title} chart, ${fmtFull(t0)} to ${fmtFull(t1)}. Use arrow keys to read values.`});
  // threshold bands (status context, labelled)
  for (const b of bands) {
    const a = Math.max(lo, b.from);
    const z = Math.min(hi, b.to);
    if (z <= a) continue;
    el("rect", {x: L, width: W - L - R, y: y(z), height: y(a) - y(z), fill: b.color, "fill-opacity": ".10"}, svg);
    const tx = el("text", {x: W - R - 4, y: y(z) + 12, "text-anchor": "end", class: "mon-band-label", fill: b.color}, svg);
    tx.textContent = b.label;
  }
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    el("line", {x1: L, x2: W - R, y1: y(v), y2: y(v), class: "mon-grid"}, svg);
    const tx = el("text", {x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "mon-axis"}, svg);
    tx.textContent = v.toFixed(unit === "V" ? 2 : 0);
  }
  const span = t1 - t0;
  for (let i = 0; i <= 3; i++) {
    const t = t0 + (span * i) / 3;
    const tx = el("text", {x: x(t), y: H - 6, "text-anchor": i === 0 ? "start" : i === 3 ? "end" : "middle", class: "mon-axis"}, svg);
    tx.textContent = fmtTime(t, span);
  }
  for (const s of live) {
    const gap = typicalGap(s.points.map((p) => p.t));
    el("path", {d: pathFor(s.points, x, y, gap), fill: "none", stroke: s.color, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke"}, svg);
    if (s.points.length < Math.min(40, W / 12)) {
      for (const p of s.points) el("circle", {cx: x(p.t), cy: y(p.v), r: 3, fill: s.color, stroke: "var(--bg-card)", "stroke-width": 1.5}, svg);
    }
  }
  const hair = el("line", {y1: T, y2: B, class: "mon-hair", visibility: "hidden"}, svg);
  wrap.appendChild(svg);
  const tip = document.createElement("div");
  tip.className = "mon-tip";
  tip.hidden = true;
  wrap.appendChild(tip);
  fig.appendChild(wrap);
  host.appendChild(fig);

  // Crosshair snaps to the nearest timestamp across all series.
  const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  const valueAt = (s, t) => {
    let best = null;
    for (const p of s.points) if (best === null || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best && Math.abs(best.t - t) < 90e3 ? best : null;
  };
  let idx = times.length - 1;
  const showAt = (i) => {
    idx = Math.max(0, Math.min(times.length - 1, i));
    const t = times[idx];
    const px = x(t);
    hair.setAttribute("x1", px);
    hair.setAttribute("x2", px);
    hair.setAttribute("visibility", "visible");
    tip.replaceChildren();
    const when = document.createElement("div");
    when.className = "mon-tip-time";
    when.textContent = fmtFull(t);
    tip.appendChild(when);
    for (const s of live) {
      const p = valueAt(s, t);
      const row = document.createElement("div");
      const key = document.createElement("i");
      key.style.background = s.color;
      const val = document.createElement("b");
      val.textContent = p ? `${p.v.toFixed(s.decimals)} ${s.unit}` : "—";
      row.append(key, val, document.createTextNode(" " + s.name));
      tip.appendChild(row);
    }
    tip.hidden = false;
    const frac = (px - 0) / W;
    tip.style.left = `${Math.min(Math.max(frac * 100, 4), 70)}%`;
  };
  const hide = () => {
    hair.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  const fromEvent = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((px - L) / (W - L - R)) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    showAt(best);
  };
  svg.addEventListener("pointermove", fromEvent);
  svg.addEventListener("pointerdown", fromEvent);
  svg.addEventListener("pointerleave", (ev) => ev.pointerType === "mouse" && hide());
  svg.addEventListener("focus", () => showAt(idx));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft") showAt(idx - 1);
    else if (ev.key === "ArrowRight") showAt(idx + 1);
    else if (ev.key === "Escape") hide();
    else return;
    ev.preventDefault();
  });
}
