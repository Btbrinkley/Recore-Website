// node --test tests/monitor-status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {fileURLToPath} from "node:url";
import * as S from "../monitor/status.js";

const NOW = Date.parse("2026-10-23T18:00:00Z");
const min = 60e3;
const hr = 3600e3;
const node = (o) => ({id: "AAAAAAAAAAA1", latest: {voltage: 12.6, status: "NORMAL", statusCode: 0}, lastHubId: "RC-H1", ...o});
const hourlyTimes = (lastMs, n = 6) => Array.from({length: n}, (_, i) => lastMs - (n - 1 - i) * 3615e3);

test("hourly node is not late or offline after a few minutes", () => {
  for (const ageMin of [5, 30, 60, 89]) {
    const t = NOW - ageMin * min;
    const ev = S.evaluateNode(node({lastMeasuredMs: t}), NOW, hourlyTimes(t));
    assert.equal(ev.interval.mode, "NORMAL");
    assert.equal(ev.reporting, "reporting", `${ageMin} min`);
  }
});

test("hourly node: late after ~1.5 intervals, offline after ~3 intervals", () => {
  const at = (ageMin) => {
    const t = NOW - ageMin * min;
    return S.evaluateNode(node({lastMeasuredMs: t}), NOW, hourlyTimes(t)).reporting;
  };
  assert.equal(at(92), "late");
  assert.equal(at(170), "late");
  assert.equal(at(182), "offline");
});

test("storage-mode (6 h) node stays reporting for 8 h", () => {
  const t = NOW - 8 * hr;
  const times = Array.from({length: 5}, (_, i) => t - (4 - i) * 21615e3);
  const ev = S.evaluateNode(node({lastMeasuredMs: t}), NOW, times);
  assert.equal(ev.interval.mode, "STORAGE");
  assert.equal(ev.reporting, "reporting");
});

test("configured interval wins over inferred timing", () => {
  const t = NOW - 30 * min;
  const ev = S.evaluateNode(node({lastMeasuredMs: t, expectedIntervalMin: 1}), NOW, hourlyTimes(t));
  assert.equal(ev.interval.source, "configured");
  assert.equal(ev.reporting, "offline"); // 1-min diagnostic node silent 30 min (offline floor 15 min)
});

test("fast diagnostic node uses the 15-minute offline floor", () => {
  const times = Array.from({length: 10}, (_, i) => NOW - 10 * min - (9 - i) * 75e3);
  const t = times[times.length - 1];
  const ev = S.evaluateNode(node({lastMeasuredMs: t}), NOW, times);
  assert.equal(ev.interval.mode, "DIAGNOSTIC");
  assert.equal(ev.reporting, "late"); // 10 min: past 1.5x75s+30s, not yet 15 min
});

test("too little history: assume hourly and say so", () => {
  const ev = S.evaluateNode(node({lastMeasuredMs: NOW - 20 * min}), NOW, [NOW - 20 * min]);
  assert.equal(ev.interval.source, "assumed");
  assert.equal(ev.reporting, "reporting");
});

test("never measured", () => {
  const ev = S.evaluateNode(node({latest: null}), NOW, []);
  assert.equal(ev.reporting, "never");
  assert.equal(ev.battery, "UNKNOWN");
  assert.equal(S.category(ev), "never");
});

test("Firestore Timestamp measuredAt is accepted", () => {
  const ev = S.evaluateNode(node({lastMeasuredAt: {toMillis: () => NOW - 10 * min}}), NOW, []);
  assert.equal(Math.round(ev.ageS), 600);
});

test("battery status: statusCode first, then status name", () => {
  assert.equal(S.batteryStatus({statusCode: 2, status: "NORMAL"}), "CRITICAL");
  assert.equal(S.batteryStatus({status: "LOW"}), "LOW");
  assert.equal(S.batteryStatus({status: "NORMAL"}), "OK");
  assert.equal(S.batteryStatus({}), "UNKNOWN");
  assert.equal(S.batteryStatus(null), "UNKNOWN");
});

test("categories: battery only asserted from a current reading", () => {
  const t = NOW - 10 * hr;
  const ev = S.evaluateNode(node({lastMeasuredMs: t, latest: {voltage: 11.2, statusCode: 2}}), NOW, hourlyTimes(t));
  assert.equal(ev.battery, "CRITICAL");
  assert.equal(S.category(ev), "offline");
  const fresh = S.evaluateNode(node({lastMeasuredMs: NOW - min, latest: {voltage: 11.2, statusCode: 2}}), NOW, []);
  assert.equal(S.category(fresh), "critical");
});

test("summary counts and worst-first order", () => {
  const mk = (id, ageMin, code) => S.evaluateNode(node({id, lastMeasuredMs: NOW - ageMin * min,
    latest: {voltage: 12, statusCode: code}}), NOW, hourlyTimes(NOW - ageMin * min));
  const evs = [mk("a", 5, 0), mk("b", 5, 1), mk("c", 5, 2), mk("d", 100, 0), mk("e", 400, 0)];
  assert.deepEqual(S.summarize(evs), {critical: 1, low: 1, late: 1, offline: 1, never: 0, ok: 1, unknown: 0, total: 5});
  assert.deepEqual(S.sortEvals(evs, (e) => e.uid).map((e) => e.uid), ["c", "e", "b", "d", "a"]);
});

test("hub: silent hub with all nodes overdue -> hub problem, nodes may be fine", () => {
  const t = NOW - 5 * hr;
  const a = S.evaluateNode(node({id: "a", lastMeasuredMs: t}), NOW, hourlyTimes(t));
  const b = S.evaluateNode(node({id: "b", lastMeasuredMs: t - 10 * min}), NOW, hourlyTimes(t - 10 * min));
  const hub = S.evaluateHub({id: "RC-H1", lastSeenAt: {toMillis: () => t}}, [a, b], NOW);
  assert.equal(hub.state, "silent");
  assert.equal(S.attribute(a, hub, [a, b]), "hub");
});

test("hub still uploading others -> this node is the problem", () => {
  const t = NOW - 5 * hr;
  const a = S.evaluateNode(node({id: "a", lastMeasuredMs: t}), NOW, hourlyTimes(t));
  const b = S.evaluateNode(node({id: "b", lastMeasuredMs: NOW - 5 * min}), NOW, hourlyTimes(NOW - 5 * min));
  const hub = S.evaluateHub({id: "RC-H1", lastSeenAt: {toMillis: () => NOW - 5 * min}}, [a, b], NOW);
  assert.equal(hub.state, "online");
  assert.equal(S.attribute(a, hub, [a, b]), "node");
  assert.equal(S.attribute(b, hub, [a, b]), null);
});

test("only node on a silent hub -> uncertain", () => {
  const t = NOW - 5 * hr;
  const a = S.evaluateNode(node({id: "a", lastMeasuredMs: t}), NOW, hourlyTimes(t));
  const hub = S.evaluateHub({id: "RC-H1", lastSeenAt: {toMillis: () => t}}, [a], NOW);
  assert.equal(S.attribute(a, hub, [a]), "unknown");
  assert.equal(S.attribute(a, S.evaluateHub(null, [], NOW), [a]), "unknown");
  assert.equal(S.attribute(a, S.evaluateHub({id: "RC-H1", status: "revoked"}, [a], NOW), [a]), "revoked");
});

test("hub with a 6-hour node is not called silent after 2 h", () => {
  const t = NOW - 2 * hr;
  const times = Array.from({length: 5}, (_, i) => t - (4 - i) * 21615e3);
  const a = S.evaluateNode(node({id: "a", lastMeasuredMs: t}), NOW, times);
  assert.equal(S.evaluateHub({id: "RC-H1", lastSeenAt: {toMillis: () => t}}, [a], NOW).state, "online");
});

test("charge estimate is labelled and matches the hub gauge code exactly", () => {
  // Load the hub's generated gauge code and compare across a voltage sweep.
  const core = fs.readFileSync(fileURLToPath(new URL("../js/hub-dashboard-core.js", import.meta.url)), "utf8");
  const ctx = {localStorage: {getItem: () => null}, document: {}, window: {}};
  vm.createContext(ctx);
  vm.runInContext(core + ";this.__est=estimateSoc;", ctx);
  for (let v = 10.0; v <= 13.0; v += 0.01) {
    assert.equal(S.estimateSoc(v, "12V"), ctx.__est(v, "12V"), `12V at ${v.toFixed(2)}`);
    assert.equal(S.estimateSoc(v * 2, "24V"), ctx.__est(v * 2, "24V"), `24V at ${(v * 2).toFixed(2)}`);
  }
  assert.equal(S.chargeText(S.chargeEstimate(12.5)), "80% est.");
  assert.equal(S.chargeEstimate(13.4).kind, "charging");
  assert.equal(S.chargeEstimate(15.0).kind, "high");
  assert.equal(S.chargeEstimate(5.1).kind, "none"); // 5 V supplies have no SOC
  assert.equal(S.chargeEstimate(null).kind, "none");
});

test("app freshness distinguishes loading, live, paused, disconnected and error", () => {
  assert.equal(S.appFreshness({loading: true}, NOW).state, "loading");
  assert.equal(S.appFreshness({lastSyncMs: NOW - min, online: true}, NOW).state, "live");
  assert.equal(S.appFreshness({lastSyncMs: NOW - min, online: false}, NOW).state, "disconnected");
  assert.equal(S.appFreshness({lastSyncMs: NOW - min, fromCache: true}, NOW).state, "disconnected");
  assert.equal(S.appFreshness({lastSyncMs: NOW - min, paused: true}, NOW).state, "paused");
  assert.equal(S.appFreshness({error: "x", lastSyncMs: 5}, NOW).state, "error");
});

test("readings: unusable docs dropped, merge dedups and bounds", () => {
  assert.equal(S.readingFromDoc({voltage: "x", measuredMs: 1}), null);
  assert.equal(S.readingFromDoc({voltage: 12}), null);
  const r = S.readingFromDoc({voltage: 12.4, measuredMs: 5, temperatureF: 70, externalTemperatureF: null, rssi: -80});
  assert.deepEqual([r.tempF, r.probeF, r.rssi], [70, null, -80]);
  const merged = S.mergeReadings([{t: 1}, {t: 2}], [{t: 2}, {t: 3}, null, {t: 4}], 3);
  assert.deepEqual(merged.map((x) => x.t), [2, 3, 4]);
});

test("formatting", () => {
  assert.equal(S.ageText(30), "30 s ago");
  assert.equal(S.ageText(600), "10 min ago");
  assert.equal(S.ageText(5400), "1.5 h ago");
  assert.equal(S.ageText(3 * 86400), "3 d ago");
  assert.equal(S.ageText(NaN), "never");
  assert.equal(S.intervalText(3615), "every 60 min");
  assert.equal(S.intervalText(21615), "every 6 h");
  assert.equal(S.signalQuality(-90), "Fair");
  assert.equal(S.signalQuality(null), null);
});
