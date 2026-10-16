// Run: node tests/control-center.test.cjs
// Checks the cloud -> hub adapter in js/sentinel-dashboard.js, and that the
// generated hub code (js/hub-dashboard-core.js) loads and renders cards.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const el = () => ({ textContent: '', innerHTML: '', className: '', classList: { toggle() {} }, dataset: {} });
const els = {};
const ctx = vm.createContext({
  window: { SENTINEL_CONFIG: { apiUrl: 'https://example.invalid', defaultSiteId: 'Cotton', defaultHubId: 'Home' } },
  location: { search: '?demo=1' }, localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: id => (els[id] ||= el()), querySelectorAll: () => [], activeElement: null },
  setInterval() {}, setTimeout, console, URL, URLSearchParams, Date, Math, JSON, Promise,
});
for (const f of ['js/sentinel-demo.js', 'js/hub-dashboard-core.js', 'js/sentinel-dashboard.js']) vm.runInContext(read(f), ctx, { filename: f });
const run = code => vm.runInContext(code, ctx);

// Battery profile from voltage, unless the cloud sends one.
assert.equal(run("profileFor(5.05)"), '5V');
assert.equal(run("profileFor(12.6)"), '12V');
assert.equal(run("profileFor(25.1)"), '24V');
assert.equal(run("profileFor(12.6,'24V')"), '24V');
assert.equal(run("profileFor(NaN)"), '12V');

// Operating mode from report spacing.
const spaced = s => `Array.from({length:15},(_,i)=>({t:i*${s}*1000}))`;
assert.equal(run(`modeFor(${spaced(25)})`), 'LIVE');
assert.equal(run(`modeFor(${spaced(78)})`), 'DIAGNOSTIC');
assert.equal(run(`modeFor(${spaced(3600)})`), 'NORMAL');
assert.equal(run(`modeFor(${spaced(21600)})`), 'STORAGE');
assert.equal(run(`modeFor([{t:0}])`), 'NORMAL');
assert.equal(run(`modeFor(${spaced(25)},'STORAGE')`), 'STORAGE');

// Online / late with the hub's thresholds.
const h = (age, s) => JSON.parse(run(`JSON.stringify(healthFor(${age},${s}))`));
assert.deepEqual(h(60, 75), { online: true, late: false });
assert.deepEqual(h(200, 75), { online: true, late: true });      // past 1.5x + 30 s
assert.deepEqual(h(899, 75), { online: true, late: true });      // 15-minute floor
assert.deepEqual(h(901, 75), { online: false, late: false });
assert.deepEqual(h(5000, 3615), { online: true, late: false });
assert.deepEqual(h(6000, 3615), { online: true, late: true });
assert.deepEqual(h(11000, 3615), { online: false, late: false });
assert.deepEqual(h(null, 75), { online: false, late: false });

// Cloud readings: status names, temperatures, bad rows dropped.
const r = o => JSON.parse(run(`JSON.stringify(readingFromCloud(${JSON.stringify(o)}))`));
const at = '2026-10-16T10:00:00Z';
assert.equal(r({ voltage: 12.1, status: 'NORMAL', recordedAt: at }).status, 'OK');
assert.equal(r({ voltage: 12.1, statusCode: 1, status: 'NORMAL', recordedAt: at }).status, 'LOW');
assert.equal(r({ voltage: 12.1, temperatureF: 70, recordedAt: at }).tempF, 70);
assert.equal(r({ voltage: 12.1, temperatureF: 70, internalTemperatureF: null, externalTemperatureF: 61, recordedAt: at }).tempF, null);
assert.equal(r({ voltage: 12.1, externalTemperatureF: 61, recordedAt: at }).probeF, 61);
assert.equal(r({ voltage: null, recordedAt: at }), null);
assert.equal(r({ voltage: 12, recordedAt: 'bad' }), null);

// Hourly buckets: avg / min / max mV, °F -> °C x10, counts.
const hp = JSON.parse(run(`JSON.stringify(hourlyPayload([
  {t:Date.UTC(2026,9,16,10,5),volts:12.0,tempF:68,probeF:null,rssi:-80},
  {t:Date.UTC(2026,9,16,10,45),volts:12.4,tempF:72,probeF:null,rssi:-90},
  {t:Date.UTC(2026,9,16,12,0),volts:12.2,tempF:null,probeF:50,rssi:null}],'24h'))`));
assert.equal(hp.points.length, 2);
assert.deepEqual(hp.points[0], [Date.UTC(2026, 9, 16, 10) / 1000, 12200, 12000, 12400, 211, null, -85, 2]);   // 70 °F avg = 21.1 °C
assert.deepEqual(hp.points[1].slice(4), [null, 100, null, 1]);
assert.equal(run('fToCx10(32)'), 0);
assert.equal(run('fToCx10(null)'), null);

// Unique numeric ids for hub-style cards.
assert.equal(run("idFor('node007', new Set())"), 7);
assert.equal(run("idFor('node007', new Set([7]))"), 1);
assert.equal(run("idFor('pumphouse', new Set([1,2]))"), 3);

// Generated hub code renders a gauge card from an adapted node.
const card = run(`(()=>{const t=new Date(Date.now()-30000).toISOString();const n=hubNode(1,{nodeId:'node001',displayName:'Test',lastSeenAt:t,
  latest:{voltage:12.5,temperatureF:70,rssi:-80,statusCode:0,recordedAt:t}},Date.now());return miniCard(n)})()`);
assert.match(card, /<svg viewBox="0 0 120 120"/);
assert.match(card, /Test/);
assert.match(card, /NORMAL/);
assert.ok(!card.includes('NaN'));
assert.equal(typeof run('HUB.historyMeta'), 'function');
assert.notEqual(run('HUB.historyMeta'), run('historyMeta'));   // the page's wrapper doesn't call itself
console.log('PASS: profile and mode inference, hub online/late thresholds, cloud reading mapping, hourly buckets, ids, generated hub card rendering.');
