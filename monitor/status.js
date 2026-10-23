// ReCore Sentinel Monitor — pure status logic (no DOM, no Firebase).
// Unit-tested with plain Node: node --test tests/monitor-status.test.mjs
//
// Four separate questions are answered separately and never merged:
//   battery     the node's own LOW / CRITICAL status from its latest measurement
//   reporting   is the node's latest MEASUREMENT on time for its reporting mode?
//   hub         has the hub that relays it uploaded anything recently?
//   app data    is this app currently connected to the cloud (see appFreshness)?
//
// Reporting thresholds are the hub's own (sentinel-hub/src/config.h):
//   late    = 1.5 x interval + 30 s
//   offline = max(3 x interval + 60 s, 15 min)
// so an hourly node is late after ~91 min and offline after ~3 h, never after minutes.

// Seconds between reports per mode, as the hub uses (sleep + ~15 s awake).
export const MODE_SECONDS = Object.freeze({LIVE: 25, DIAGNOSTIC: 75, NORMAL: 3615, STORAGE: 21615});
export const MODE_LABEL = Object.freeze({LIVE: "Live", DIAGNOSTIC: "Diagnostic", NORMAL: "Normal (hourly)", STORAGE: "Storage (6-hourly)"});
export const DEFAULT_MODE = "NORMAL";
const MIN_OFFLINE_S = 15 * 60;

export function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : null;
}

export function nearestMode(seconds) {
  let best = DEFAULT_MODE;
  let bestDiff = Infinity;
  for (const [mode, s] of Object.entries(MODE_SECONDS)) {
    const diff = Math.abs(Math.log(Math.max(1, seconds) / s));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = mode;
    }
  }
  return best;
}

// Median gap of the most recent reports, snapped to a mode. Needs >= 3 reports.
export function inferMode(timesMs) {
  const t = (timesMs || []).filter(Number.isFinite).slice().sort((a, b) => a - b).slice(-20);
  if (t.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < t.length; i++) gaps.push((t[i] - t[i - 1]) / 1000);
  gaps.sort((a, b) => a - b);
  return nearestMode(gaps[Math.floor(gaps.length / 2)]);
}

// The hub does not upload the reporting mode, so: the interval an admin set for
// the device ("configured"), else inferred from report timing, else assume hourly.
export function reportingInterval(node, timesMs) {
  const min = node && Number(node.expectedIntervalMin);
  if (Number.isFinite(min) && min > 0) {
    const seconds = Math.round(min * 60);
    return {seconds, mode: nearestMode(seconds), source: "configured"};
  }
  const mode = inferMode(timesMs);
  if (mode) return {seconds: MODE_SECONDS[mode], mode, source: "inferred"};
  return {seconds: MODE_SECONDS[DEFAULT_MODE], mode: DEFAULT_MODE, source: "assumed"};
}

export function thresholds(intervalS) {
  return {lateS: intervalS * 1.5 + 30, offlineS: Math.max(intervalS * 3 + 60, MIN_OFFLINE_S)};
}

export function reportingState(ageS, intervalS) {
  if (!Number.isFinite(ageS)) return "never";
  const {lateS, offlineS} = thresholds(intervalS);
  if (ageS >= offlineS) return "offline";
  if (ageS >= lateS) return "late";
  return "reporting";
}

const STATUS_CODES = {0: "OK", 1: "LOW", 2: "CRITICAL"};
export function batteryStatus(latest) {
  if (!latest) return "UNKNOWN";
  if (Number.isInteger(latest.statusCode) && STATUS_CODES[latest.statusCode]) return STATUS_CODES[latest.statusCode];
  if (latest.status === "LOW" || latest.status === "CRITICAL") return latest.status;
  if (typeof latest.status === "string" && latest.status) return "OK";
  return "UNKNOWN";
}

// --- Estimated state of charge. Same table and profiles as the hub gauges
// (GAUGE_PROFILES / SOC_TABLE in hub-dashboard-core.js; a test keeps them equal).
// Resting lead-acid voltage only: while charging or right after, it reads high.
export const GAUGE_PROFILES = Object.freeze({
  "5V": {nominal: 5, high: 5.5, soc: false},
  "12V": {nominal: 12, charge: 13, high: 14.8, soc: true},
  "24V": {nominal: 24, charge: 26, high: 29.6, soc: true},
});
export const SOC_TABLE = Object.freeze([[10.5, 0], [11.51, 10], [11.66, 20], [11.81, 30], [11.96, 40], [12.1, 50],
  [12.24, 60], [12.37, 70], [12.5, 80], [12.62, 90], [12.73, 100]]);

export function voltageProfile(volts) {
  if (!Number.isFinite(volts)) return "12V";
  return volts < 8 ? "5V" : volts > 18 ? "24V" : "12V";
}

export function estimateSoc(volts, profile) {
  const g = GAUGE_PROFILES[profile];
  if (!g || !g.soc || !Number.isFinite(volts)) return null;
  const v = volts * (12 / g.nominal);
  if (v <= SOC_TABLE[0][0]) return 0;
  for (let i = 1; i < SOC_TABLE.length; i++) {
    const [v1, s1] = SOC_TABLE[i];
    const [v0, s0] = SOC_TABLE[i - 1];
    if (v <= v1) return Math.round(s0 + (s1 - s0) * (v - v0) / (v1 - v0));
  }
  return 100;
}

// {kind: "percent", pct} | {kind: "charging"} | {kind: "high"} | {kind: "none"}
export function chargeEstimate(volts) {
  if (!Number.isFinite(volts)) return {kind: "none"};
  const profile = voltageProfile(volts);
  const g = GAUGE_PROFILES[profile];
  if (volts >= g.high) return {kind: "high", profile};
  if (g.soc && volts >= g.charge) return {kind: "charging", profile};
  const pct = estimateSoc(volts, profile);
  return pct === null ? {kind: "none", profile} : {kind: "percent", pct, profile};
}

export function chargeText(est) {
  if (est.kind === "percent") return `${est.pct}% est.`;
  if (est.kind === "charging") return "Charging (no estimate)";
  if (est.kind === "high") return "High voltage";
  return "No estimate";
}

// --- Per-node evaluation (without the hub) --------------------------------
export function evaluateNode(node, now, timesMs) {
  const measuredMs = typeof node.lastMeasuredMs === "number" ? node.lastMeasuredMs : toMs(node.lastMeasuredAt);
  const latest = node.latest || {};
  const voltage = typeof latest.voltage === "number" && Number.isFinite(latest.voltage) ? latest.voltage : null;
  const interval = reportingInterval(node, timesMs);
  const ageS = measuredMs === null ? null : Math.max(0, (now - measuredMs) / 1000);
  const reporting = reportingState(ageS ?? NaN, interval.seconds);
  return {
    uid: node.id || node.deviceUid, measuredMs, ageS, interval, reporting,
    battery: batteryStatus(node.latest), voltage, charge: chargeEstimate(voltage),
    hubUid: node.lastHubId || node.primaryHubId || null,
  };
}

// --- Hub upload health -----------------------------------------------------
// A hub uploads only when it hears a node; there is no heartbeat. It counts as
// "silent" once it has gone longer than the offline time of its fastest node.
export function evaluateHub(hub, nodeEvals, now) {
  const lastMs = hub ? toMs(hub.lastSeenAt) : null;
  if (!hub) return {state: "unknown", lastMs: null, silentAfterS: null};
  if (hub.status === "revoked" || hub.status === "released") return {state: "revoked", lastMs, silentAfterS: null};
  const mine = (nodeEvals || []).filter((e) => e.hubUid === hub.id);
  const fastest = mine.length ? Math.min(...mine.map((e) => e.interval.seconds)) : MODE_SECONDS[DEFAULT_MODE];
  const silentAfterS = thresholds(fastest).offlineS;
  if (lastMs === null) return {state: "never", lastMs, silentAfterS};
  return {state: (now - lastMs) / 1000 >= silentAfterS ? "silent" : "online", lastMs, silentAfterS};
}

// Why is a late/offline node quiet?
//   "node"    the hub uploaded after this node was due -> the hub works; this node wasn't heard
//   "hub"     every node on this hub is overdue and the hub is silent -> hub/Wi-Fi/internet likely
//   "revoked" the hub's cloud access was revoked
//   "unknown" not enough evidence (e.g. the only node on its hub)
export function attribute(ev, hubEv, siblings) {
  if (ev.reporting === "reporting") return null;
  if (!hubEv || hubEv.state === "unknown") return "unknown";
  if (hubEv.state === "revoked") return "revoked";
  const dueMs = ev.measuredMs === null ? null : ev.measuredMs + thresholds(ev.interval.seconds).lateS * 1000;
  if (hubEv.lastMs !== null && dueMs !== null && hubEv.lastMs > dueMs) return "node";
  const others = (siblings || []).filter((s) => s.uid !== ev.uid && s.hubUid === ev.hubUid);
  if (others.length && others.every((s) => s.reporting !== "reporting") && hubEv.state !== "online") return "hub";
  if (others.length && others.some((s) => s.reporting === "reporting")) return "node";
  return "unknown";
}

// One headline category per node, worst first. Battery categories are only
// asserted from a reasonably current reading; an offline node keeps its
// last-known battery status as a note instead.
export function category(ev) {
  if (ev.reporting === "never") return "never";
  if (ev.reporting === "offline") return "offline";
  if (ev.battery === "CRITICAL") return "critical";
  if (ev.battery === "LOW") return "low";
  if (ev.reporting === "late") return "late";
  if (ev.battery === "UNKNOWN") return "unknown";
  return "ok";
}
export const SEVERITY = Object.freeze({critical: 6, offline: 5, low: 4, late: 3, never: 2, unknown: 1, ok: 0});

export function summarize(evals) {
  const out = {critical: 0, low: 0, late: 0, offline: 0, never: 0, ok: 0, unknown: 0, total: evals.length};
  for (const e of evals) out[category(e)]++;
  return out;
}

export function sortEvals(evals, nameOf) {
  return evals.slice().sort((a, b) => SEVERITY[category(b)] - SEVERITY[category(a)] ||
    String(nameOf(a)).localeCompare(String(nameOf(b))));
}

// --- This app's own connection to the cloud --------------------------------
// state: {loading, error, online, fromCache, paused, lastSyncMs}
export function appFreshness(s, now) {
  if (s.error) return {state: "error", lastSyncMs: s.lastSyncMs ?? null};
  if (s.loading && !s.lastSyncMs) return {state: "loading", lastSyncMs: null};
  if (s.online === false || s.fromCache) return {state: "disconnected", lastSyncMs: s.lastSyncMs ?? null};
  if (s.paused) return {state: "paused", lastSyncMs: s.lastSyncMs ?? null};
  return {state: "live", lastSyncMs: s.lastSyncMs ?? now};
}

// --- Formatting -------------------------------------------------------------
export function ageText(ageS) {
  if (!Number.isFinite(ageS)) return "never";
  const s = Math.round(ageS);
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) {
    const h = s / 3600;
    return `${h < 10 ? h.toFixed(1) : Math.round(h)} h ago`;
  }
  return `${Math.round(s / 86400)} d ago`;
}

export function intervalText(seconds) {
  if (seconds < 120) return `every ${Math.round(seconds)} s`;
  if (seconds < 5400) return `every ${Math.round(seconds / 60)} min`;
  return `every ${Math.round(seconds / 3600)} h`;
}

export function signalQuality(rssi) {
  if (!Number.isFinite(rssi)) return null;
  if (rssi >= -70) return "Excellent";
  if (rssi >= -85) return "Good";
  if (rssi >= -100) return "Fair";
  if (rssi >= -115) return "Weak";
  return "Very weak";
}

export const RANGES = Object.freeze({"24h": 24 * 3600e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3});
export const RANGE_LIMIT = Object.freeze({"24h": 300, "7d": 1200, "30d": 2000});
export const RECENT_LIMIT = 60; // list sparklines: newest readings within 24 h

// Firestore reading doc -> compact reading. Returns null for unusable docs.
export function readingFromDoc(d) {
  const t = typeof d.measuredMs === "number" ? d.measuredMs : toMs(d.measuredAt);
  if (!Number.isFinite(t) || typeof d.voltage !== "number" || !Number.isFinite(d.voltage)) return null;
  const onboard = d.internalTemperatureF !== undefined ? d.internalTemperatureF : d.temperatureF;
  return {
    t, volts: d.voltage,
    tempF: typeof onboard === "number" && Number.isFinite(onboard) ? onboard : null,
    probeF: typeof d.externalTemperatureF === "number" && Number.isFinite(d.externalTemperatureF) ? d.externalTemperatureF : null,
    rssi: Number.isInteger(d.rssi) ? d.rssi : null,
    sequence: Number.isInteger(d.sequence) ? d.sequence : 0,
    status: batteryStatus(d) === "UNKNOWN" ? "OK" : batteryStatus(d),
  };
}

// Merge newly fetched readings (any order) into a sorted cache, newest `keep`.
export function mergeReadings(have, incoming, keep) {
  const byT = new Map();
  for (const r of have || []) byT.set(r.t, r);
  for (const r of incoming || []) if (r) byT.set(r.t, r);
  const all = [...byT.values()].sort((a, b) => a.t - b.t);
  return keep ? all.slice(-keep) : all;
}
