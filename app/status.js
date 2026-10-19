// Pure status logic for the customer dashboard (no DOM, no Firebase) so it can
// be unit-tested with plain Node: node --test tests/app-status.test.mjs
//
// Three separate conditions are reported, never merged into one "offline":
//   hub cloud  — has the hub uploaded anything recently?
//   freshness  — is this node's last ACTUAL MEASUREMENT recent?
//   battery    — the node's own status (NORMAL / LOW / CRITICAL) from that measurement.

export const DEFAULT_INTERVAL_MIN = 60;

export function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : null;
}

// A hub uploads only when it hears nodes, so "offline" means: silent for longer
// than its slowest expected node interval plus slack.
export function hubCloudState(hub, now) {
  const last = toMs(hub && hub.lastSeenAt);
  if (hub && (hub.status === "revoked" || hub.status === "released")) return {state: "revoked", lastMs: last};
  if (last === null) return {state: "never", lastMs: null};
  const interval = (hub.expectedIntervalMin || DEFAULT_INTERVAL_MIN) * 60000;
  const limit = Math.max(interval * 1.5, interval + 20 * 60000);
  return {state: now - last > limit ? "offline" : "online", lastMs: last};
}

export function nodeState(node, hubsById, now) {
  const measured = typeof node.lastMeasuredMs === "number" ? node.lastMeasuredMs : toMs(node.lastMeasuredAt);
  const interval = (node.expectedIntervalMin || DEFAULT_INTERVAL_MIN) * 60000;
  const staleAfter = Math.max(interval * 2.5, interval + 30 * 60000);
  const latest = node.latest || {};
  const status = typeof latest.status === "string" ? latest.status : null;
  let battery = "UNKNOWN";
  if (status === "CRITICAL") battery = "CRITICAL";
  else if (status === "LOW") battery = "LOW";
  else if (status) battery = "OK";
  const freshness = measured === null ? "never" : (now - measured > staleAfter ? "stale" : "fresh");
  const hubId = node.lastHubId || node.primaryHubId;
  const hub = hubId && hubsById ? hubsById[hubId] : null;
  const hubCloud = hub ? hubCloudState(hub, now).state : "unknown";
  // Explain staleness: if the hub that normally reports this node is itself
  // silent, the node is probably fine and the hub's internet is the problem.
  let reason = null;
  if (freshness === "stale") reason = hubCloud === "offline" ? "hub-offline" : "node-silent";
  const severity = battery === "CRITICAL" ? 3 : battery === "LOW" ? 2 : freshness !== "fresh" ? 1 : 0;
  return {battery, freshness, reason, hubCloud, measuredMs: measured, severity,
    voltage: typeof latest.voltage === "number" ? latest.voltage : null};
}

export function displayName(node) {
  return node.name || node.hubName || node.deviceUid || node.id || "Unnamed node";
}

export function timeAgo(ms, now) {
  if (ms === null || ms === undefined) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function filterNodes(nodes, {locationId = "", hubId = ""} = {}) {
  return nodes.filter((n) =>
    (!locationId || n.locationId === locationId) &&
    (!hubId || n.primaryHubId === hubId || n.lastHubId === hubId ||
      (n.heardBy && Object.prototype.hasOwnProperty.call(n.heardBy, hubId))));
}

// Worst first, then by name: problems surface at the top on a phone.
export function sortNodes(nodes, hubsById, now) {
  return nodes.slice().sort((a, b) =>
    nodeState(b, hubsById, now).severity - nodeState(a, hubsById, now).severity ||
    displayName(a).localeCompare(displayName(b)));
}

export const RANGES = {
  "24h": 24 * 3600e3,
  "7d": 7 * 86400e3,
  "30d": 30 * 86400e3,
};
export const RANGE_LIMIT = {"24h": 1500, "7d": 2500, "30d": 4000};

// Firestore reading docs -> the shape SentinelChart already renders.
export function toChartReadings(docs) {
  return docs.map((d) => ({
    readingId: d.id,
    recordedAt: new Date(typeof d.measuredMs === "number" ? d.measuredMs : toMs(d.measuredAt)).toISOString(),
    voltage: d.voltage,
    temperatureF: d.temperatureF ?? null,
    internalTemperatureF: d.internalTemperatureF ?? null,
    externalTemperatureF: d.externalTemperatureF ?? null,
    rssi: d.rssi ?? null,
    sequence: d.sequence ?? null,
    hubUid: d.hubUid || null,
  })).filter((r) => typeof r.voltage === "number" && Number.isFinite(Date.parse(r.recordedAt)));
}
