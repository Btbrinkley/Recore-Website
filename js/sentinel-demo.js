/*
 * Sample data for the Control Center (?demo=1), in the same shape as the cloud
 * dashboard API (/dashboard/nodes, /dashboard/history). Used for demos and tests.
 */
'use strict';

const SentinelDemo = (() => {
  // name, nodeId, report interval (s), base volts, daily swing, onboard °F, rssi, minutes since last report, status
  const NODES = [
    ['Kubota tractor', 'node001', 75, 12.64, 0.05, 74, -71, 0.6, 'NORMAL'],
    ['Backhoe', 'node002', 3615, 12.18, 0.04, 69, -104, 22, 'LOW'],
    ['Golf cart', 'node003', 75, 13.42, 0.12, 78, -62, 0.3, 'NORMAL'],
    ['Pump house', 'node004', 3615, 12.52, 0.03, 66, -88, 41, 'NORMAL'],
    ['Generator', 'node005', 21615, 11.71, 0.02, 63, -96, 180, 'CRITICAL'],
    ['Shop truck', 'node006', 3615, 12.47, 0.06, 71, -79, 300, 'NORMAL'],
    ['Range tester', 'node007', 25, 5.06, 0.02, 81, -55, 0.2, 'NORMAL'],
  ];
  const STATUS_CODE = { NORMAL: 0, LOW: 1, CRITICAL: 2 };

  // Deterministic wobble so screenshots and tests are stable.
  const wave = (t, seed) => Math.sin(t / 3.6e6 + seed) * 0.5 + Math.sin(t / 8.64e7 * 2 * Math.PI + seed) * 0.5;

  function reading(node, t, i) {
    const [, , , base, swing, temp, rssi, , status] = node;
    const seed = node[1].charCodeAt(6);
    return {
      voltage: +(base + swing * wave(t, seed)).toFixed(3),
      temperatureF: +(temp + 6 * Math.sin(t / 8.64e7 * 2 * Math.PI - 1.8 + seed)).toFixed(1),
      rssi: Math.round(rssi + 4 * wave(t, seed + 1)),
      statusCode: STATUS_CODE[status], status, sequence: 1000 + i,
      firmwareVersion: '0.9.0-lora-ota', recordedAt: new Date(t).toISOString(),
    };
  }

  function lastTime(node, now) { return now - node[7] * 60000; }

  function history(node, rangeMs, limit, now) {
    const interval = node[2] * 1000, end = lastTime(node, now), out = [];
    const count = Math.min(limit, Math.floor(rangeMs / interval) + 1);
    // Like the cloud: oldest rows first, stopping at the cap.
    const start = Math.max(now - rangeMs, end - (Math.floor(rangeMs / interval)) * interval);
    for (let i = 0; i < count; i++) {
      const t = start + i * interval;
      if (t > end) break;
      out.push(reading(node, t, i));
    }
    return out;
  }

  const RANGES = { live: [3600e3, 500], '24h': [86400e3, 2000], '7d': [604800e3, 5000], '30d': [2592000e3, 10000] };

  function get(endpoint, params) {
    const now = Date.now();
    if (endpoint === '/dashboard/nodes') {
      return Promise.resolve({
        siteId: params.siteId, hubId: params.hubId,
        nodes: NODES.map((n, i) => ({
          nodeId: n[1], displayName: n[0], assetName: null,
          lastSeenAt: new Date(lastTime(n, now)).toISOString(), latest: reading(n, lastTime(n, now), 5000 + i),
        })),
      });
    }
    if (endpoint === '/dashboard/history') {
      const node = NODES.find(n => n[1] === params.nodeId);
      const [ms, limit] = RANGES[params.range] || RANGES['24h'];
      return Promise.resolve({ ...params, readings: node ? history(node, ms, limit, now) : [] });
    }
    return Promise.reject(new Error('Unknown demo endpoint ' + endpoint));
  }

  return { get, NODES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SentinelDemo;
