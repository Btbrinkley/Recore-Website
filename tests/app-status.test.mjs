// node --test tests/app-status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {hubCloudState, nodeState, filterNodes, sortNodes, toChartReadings, timeAgo} from "../app/status.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const H = 3600e3;
const hubs = {A: {lastSeenAt: NOW - 10 * 60e3}, B: {lastSeenAt: NOW - 5 * H}, R: {status: "revoked", lastSeenAt: NOW}};

test("hub cloud state", () => {
  assert.equal(hubCloudState(hubs.A, NOW).state, "online");
  assert.equal(hubCloudState(hubs.B, NOW).state, "offline");
  assert.equal(hubCloudState({}, NOW).state, "never");
  assert.equal(hubCloudState(hubs.R, NOW).state, "revoked");
  assert.equal(hubCloudState({lastSeenAt: NOW - 70 * 60e3}, NOW).state, "online", "hourly hub with slack");
  assert.equal(hubCloudState({lastSeenAt: NOW - 30 * 60e3, expectedIntervalMin: 1}, NOW).state, "offline");
});

test("node state separates battery, freshness and hub outage", () => {
  const ok = nodeState({lastMeasuredMs: NOW - 20 * 60e3, latest: {status: "NORMAL", voltage: 12.6}, lastHubId: "A"}, hubs, NOW);
  assert.deepEqual([ok.battery, ok.freshness, ok.reason, ok.severity], ["OK", "fresh", null, 0]);
  const hubDown = nodeState({lastMeasuredMs: NOW - 5 * H, latest: {status: "NORMAL"}, lastHubId: "B"}, hubs, NOW);
  assert.deepEqual([hubDown.freshness, hubDown.reason], ["stale", "hub-offline"]);
  const silent = nodeState({lastMeasuredMs: NOW - 5 * H, latest: {status: "NORMAL"}, lastHubId: "A"}, hubs, NOW);
  assert.equal(silent.reason, "node-silent");
  const crit = nodeState({lastMeasuredMs: NOW - 5 * H, latest: {status: "CRITICAL"}, lastHubId: "A"}, hubs, NOW);
  assert.deepEqual([crit.battery, crit.freshness, crit.severity], ["CRITICAL", "stale", 3], "old critical is still shown, flagged stale");
  assert.equal(nodeState({}, hubs, NOW).freshness, "never");
  assert.equal(nodeState({lastMeasuredMs: NOW - 2 * 60e3, expectedIntervalMin: 1, latest: {status: "NORMAL"}}, hubs, NOW).freshness, "fresh");
  assert.equal(nodeState({lastMeasuredMs: NOW - 40 * 60e3, expectedIntervalMin: 1, latest: {status: "NORMAL"}}, hubs, NOW).freshness, "stale");
});

test("filters and sorting", () => {
  const nodes = [
    {id: "1", name: "B", locationId: "home", primaryHubId: "A", lastMeasuredMs: NOW, latest: {status: "NORMAL"}},
    {id: "2", name: "A", locationId: "dad", primaryHubId: "B", lastHubId: "B", lastMeasuredMs: NOW, latest: {status: "LOW"}},
    {id: "3", name: "C", locationId: "home", primaryHubId: "A", heardBy: {B: {}}, lastMeasuredMs: NOW, latest: {status: "CRITICAL"}},
  ];
  assert.deepEqual(filterNodes(nodes, {locationId: "home"}).map((n) => n.id), ["1", "3"]);
  assert.deepEqual(filterNodes(nodes, {hubId: "B"}).map((n) => n.id), ["2", "3"]);
  assert.deepEqual(sortNodes(nodes, hubs, NOW).map((n) => n.id), ["3", "2", "1"]);
});

test("chart mapping uses measurement time", () => {
  const r = toChartReadings([{id: "x", measuredMs: NOW, voltage: 12.5, rssi: -70}, {id: "bad", measuredMs: NOW}]);
  assert.equal(r.length, 1);
  assert.equal(r[0].recordedAt, new Date(NOW).toISOString());
  assert.equal(timeAgo(NOW - 90e3, NOW), "2 min ago");
});
