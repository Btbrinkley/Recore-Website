/*
 * Customer dashboard equipment view: the hub's own gauges, device cards and
 * charts (../js/hub-dashboard-core.js, generated from the hub firmware), fed
 * from the organization's Firestore data instead of the hub API.
 *
 * Same approach as ../js/sentinel-dashboard.js (public Control Center): this
 * classic script runs after hub-dashboard-core.js, reshapes data into the hub's
 * formats and replaces the few hub functions that talk to the hub itself.
 * app.js (module) drives it through window.OrgDash.
 */
'use strict';

const ORG = {
  items: [], idOf: new Map(), next: 1, raw: {}, rev: {}, notes: {}, pending: new Set(), gen: 0,
  loader: null,       // async (deviceUid, range, sinceMs) -> {readings, capped}
  onSelect: null,     // (deviceUid) -> void
  emptyText: 'No equipment has reported yet.',
};

// Report spacing per mode, matching the hub (sleep + ~15 s awake).
const ORG_MODE_INTERVALS = {LIVE: 25, DIAGNOSTIC: 75, NORMAL: 3615, STORAGE: 21615};
const orgNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const orgFToCx10 = (f) => (Number.isFinite(f) ? Math.round((f - 32) * 50 / 9) : null);

function orgStatus(r) {
  if (r && Number.isInteger(r.statusCode) && STATUS_CODES[r.statusCode]) return STATUS_CODES[r.statusCode];
  const s = r && r.status;
  if (s === 'LOW' || s === 'CRITICAL') return s;
  return s ? 'OK' : 'UNKNOWN';
}

function orgProfile(volts) {
  if (!Number.isFinite(volts)) return '12V';
  return volts < 8 ? '5V' : volts > 18 ? '24V' : '12V';
}

// Median spacing of recent reports, snapped to the nearest mode (as the Control Center does).
function orgMode(readings) {
  const recent = readings.slice(-20);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) gaps.push((recent[i].t - recent[i - 1].t) / 1000);
  if (gaps.length < 2) return 'NORMAL';
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  let best = 'NORMAL';
  let bestDiff = Infinity;
  for (const [mode, s] of Object.entries(ORG_MODE_INTERVALS)) {
    const diff = Math.abs(Math.log(Math.max(1, median) / s));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = mode;
    }
  }
  return best;
}

// Hub thresholds (config.h): late = 1.5 x interval + 30 s; offline = 3 x interval + 60 s, at least 15 min.
function orgHealth(ageSeconds, intervalSeconds) {
  if (!Number.isFinite(ageSeconds)) return {online: false, late: false};
  const late = intervalSeconds * 1.5 + 30;
  const offline = Math.max(intervalSeconds * 3 + 60, 15 * 60);
  return {online: ageSeconds < offline, late: ageSeconds >= late && ageSeconds < offline};
}

function orgHubNode(it, now) {
  const id = ORG.idOf.get(it.uid);
  const L = it.latest || {};
  const volts = orgNum(L.voltage);
  const ageSeconds = Number.isFinite(it.measuredMs) ? Math.max(0, Math.round((now - it.measuredMs) / 1000)) : null;
  const raw = ORG.raw[id] || [];
  const mode = orgMode(raw);
  const interval = it.expectedIntervalMin ? it.expectedIntervalMin * 60 : ORG_MODE_INTERVALS[mode];
  const health = orgHealth(ageSeconds, interval);
  const onboard = L.internalTemperatureF !== undefined ? orgNum(L.internalTemperatureF) : orgNum(L.temperatureF);
  const probe = orgNum(L.externalTemperatureF);
  return {
    id, uid: it.uid, rev: it.rev, name: it.name, location: it.location, via: it.via, hubCloud: it.hubCloud,
    measuredMs: it.measuredMs, online: health.online, late: health.late,
    // A silent node behind a hub whose internet is down shows as WAITING, not OFFLINE.
    waiting: !health.online && it.hubCloud === 'offline',
    expectedIntervalSeconds: interval, volts: volts === null ? NaN : volts, assetProfile: orgProfile(volts),
    operatingMode: mode, modeInferred: !it.expectedIntervalMin, status: orgStatus(L),
    rssi: Number.isInteger(L.rssi) ? L.rssi : null, ageSeconds, tempF: onboard, humidityRh: null,
    externalTempF: probe, externalTempStatus: probe === null ? 'NOT PRESENT' : 'OK',
    firmware: L.firmwareVersion || '', divider: null, dividerPending: false,
  };
}

// Hub "recent" format: [ageSeconds, mV, tempCx10, rhX10, probeCx10, probeStatus, rssi, sequence, statusCode]
function orgRecentPayload(id) {
  const now = Date.now();
  const codes = {OK: 0, LOW: 1, CRITICAL: 2};
  const points = (ORG.raw[id] || []).slice(-96).map((p) => [
    Math.max(0, Math.round((now - p.t) / 1000)), Math.round(p.volts * 1000), orgFToCx10(p.tempF), null,
    orgFToCx10(p.probeF), Number.isFinite(p.probeF) ? 1 : 0, p.rssi, p.sequence, codes[p.status] ?? 255]);
  return {nodeId: id, range: 'recent', points};
}

// Hub hourly format: [hourStartSeconds, mVavg, mVmin, mVmax, tempCx10, probeCx10, rssi, count]
function orgHourlyPayload(readings, range) {
  const buckets = new Map();
  for (const p of readings) {
    const hour = Math.floor(p.t / 3600000);
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour).push(p);
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([hour, ps]) => {
    const mv = ps.map((p) => p.volts * 1000);
    const temps = ps.map((p) => p.tempF).filter(Number.isFinite);
    const probes = ps.map((p) => p.probeF).filter(Number.isFinite);
    const rssis = ps.map((p) => p.rssi).filter(Number.isFinite);
    return [hour * 3600, Math.round(avg(mv)), Math.round(Math.min(...mv)), Math.round(Math.max(...mv)),
      temps.length ? orgFToCx10(avg(temps)) : null, probes.length ? orgFToCx10(avg(probes)) : null,
      rssis.length ? Math.round(avg(rssis)) : null, ps.length];
  });
  return {range, bucketSeconds: 3600, now: Math.floor(Date.now() / 1000), available: true, points};
}

function orgBuild() {
  const now = Date.now();
  latestNodes = ORG.items.map((it) => orgHubNode(it, now));
  for (const n of latestNodes) histories[n.id] = mapRecent(orgRecentPayload(n.id));
}

function orgRender() {
  const summaryEl = document.getElementById('dashboardSummary');
  const detailEl = document.getElementById('dashboardDetail');
  if (!summaryEl || !detailEl) return;
  if (!latestNodes.length) {
    summaryEl.innerHTML = '';
    detailEl.innerHTML = `<div class="empty">${esc(ORG.emptyText)}</div>`;
    return;
  }
  const before = selectedDashboardNode;
  const inspection = rememberChartInspection();
  renderDashboardCards();
  restoreChartInspection(inspection);
  if (selectedDashboardNode !== before && ORG.onSelect) {
    const n = latestNodes.find((x) => x.id === selectedDashboardNode);
    if (n) ORG.onSelect(n.uid);
  }
}

// ---------- Hub functions replaced for the customer dashboard ----------

// Hub function, replaced: history comes from Firestore instead of /api/history.
async function fetchHistory(id, range) {
  if (range === 'recent') return orgRecentPayload(id);
  const n = latestNodes.find((x) => x.id === id);
  const key = range + ':' + id;
  delete ORG.notes[key];
  const {readings, capped} = await ORG.loader(n.uid, range, 0);
  if (capped) ORG.notes[key] = 'Showing the most recent readings only for this range; older hours may be blank.';
  return orgHourlyPayload(readings, range);
}

async function orgRefreshSelectedRange() {
  if (chartRange === 'recent' || selectedDashboardNode === null) return;
  const n = latestNodes.find((x) => x.id === selectedDashboardNode);
  if (!n) return;
  const key = chartRange + ':' + n.id;
  if (rangeRev[key] === n.rev && Date.now() - (rangeAt[key] || 0) < 600000) return;
  try {
    rangeHist[chartRange][n.id] = mapHourly(await fetchHistory(n.id, chartRange), RANGE_HOURS[chartRange]);
    rangeRev[key] = n.rev;
    rangeAt[key] = Date.now();
  } catch (e) { /* the chart shows its loading/empty text */ }
}

function selectDashboardNode(id) {
  selectedDashboardNode = id;
  const sel = latestNodes.find((n) => n.id === id);
  const detailEl = document.getElementById('dashboardDetail');
  if (detailEl) detailEl.innerHTML = sel ? dashboardCard(sel) : '';
  document.querySelectorAll('#dashboardSummary .miniCard').forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === id));
  if (sel && ORG.onSelect) ORG.onSelect(sel.uid);
  if (chartRange !== 'recent') orgRefreshSelectedRange().then(orgRender);
}

function setChartRange(k) {
  if (k === chartRange) return;
  chartRange = k;
  try {
    localStorage.setItem('sentinelChartRange', k);
  } catch (e) { /* ignore */ }
  orgRender();
  orgRefreshSelectedRange().then(orgRender);
}

// Hub mini card plus where the device is.
function miniCard(n) {
  return HUB.miniCard(n).replace('<div class="gSub">', `<div class="gSub">${esc(n.location)} · `);
}

function statBlock(n) {
  const signal = n.online && Number.isFinite(n.rssi) ? signalQuality(n.rssi) + ' (' + n.rssi + ' dBm)' : '—';
  const probe = Number.isFinite(n.externalTempF) ?
    `<div class="stat">External probe temperature<b>${n.online ? n.externalTempF.toFixed(1) + ' °F' : '—'}</b></div>` : '';
  const onboard = Number.isFinite(n.tempF) ?
    `<div class="stat">Onboard temperature (SHT40)<b>${n.online ? n.tempF.toFixed(1) + ' °F' : '—'}</b></div>` : '';
  const when = Number.isFinite(n.measuredMs) ? new Date(n.measuredMs).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';
  const hubState = {online: 'online', offline: 'cloud offline', never: 'never connected', revoked: 'revoked'}[n.hubCloud] || '';
  return `<div class="stats"><div class="stat">Voltage<b>${n.online ? n.volts.toFixed(2) + ' V' : '—'}</b></div>${probe}${onboard}` +
    `<div class="stat">Location<b>${esc(n.location)}</b></div>` +
    `<div class="stat">Reported via<b>${esc(n.via)}${hubState ? ` <small style="font-weight:400;color:var(--muted)">(${hubState})</small>` : ''}</b></div>` +
    `<div class="stat">Operating mode<b>${esc(n.operatingMode)}${n.modeInferred ? ' <small style="font-weight:400;color:var(--muted)">(from report timing)</small>' : ''}</b></div>` +
    `<div class="stat">Signal<b>${signal}</b></div><div class="stat">Expected voltage<b>${esc(n.assetProfile)}</b></div>` +
    `<div class="stat">Last measurement<b>${Number.isFinite(n.ageSeconds) ? ageText(n.ageSeconds) : '—'}${when ? ` <small style="font-weight:400;color:var(--muted)">${esc(when)}</small>` : ''}</b></div></div>`;
}

function historyMeta(n) {
  const note = chartRange !== 'recent' && ORG.notes[chartRange + ':' + n.id];
  return HUB.historyMeta(n) + (note ? `<div class="sparkMeta"><span>${esc(note)}</span></div>` : '');
}

function emptyHistoryText(n) {
  if (chartRange === 'recent') return '<div>No recent readings for this device.</div>';
  const key = chartRange + ':' + n.id;
  return rangeRev[key] === undefined ? '<div>Loading…</div>' :
    `<div>No readings for this device in the last ${rangeName().toLowerCase()}.</div>`;
}

// ---------- API used by app.js ----------

window.OrgDash = {
  configure({loader, onSelect}) {
    ORG.loader = loader;
    ORG.onSelect = onSelect;
    try {
      const r = localStorage.getItem('sentinelChartRange');
      if (r && (r === 'recent' || RANGE_HOURS[r])) chartRange = r;
    } catch (e) { /* ignore */ }
  },
  // Forget everything (organization switched or signed out).
  reset() {
    ORG.gen++;
    ORG.pending.clear();
    ORG.items = [];
    ORG.idOf.clear();
    ORG.next = 1;
    ORG.raw = {};
    ORG.rev = {};
    ORG.notes = {};
    latestNodes = [];
    selectedDashboardNode = null;
    for (const r of Object.values(rangeHist)) for (const k of Object.keys(r)) delete r[k];
    for (const o of [rangeRev, rangeAt]) for (const k of Object.keys(o)) delete o[k];
    for (const k of Object.keys(histories)) delete histories[k];
  },
  // items: [{uid, name, location, via, hubCloud, latest, measuredMs, rev, expectedIntervalMin}], in display order.
  async update(items, emptyText) {
    ORG.items = items;
    if (emptyText) ORG.emptyText = emptyText;
    for (const it of items) if (!ORG.idOf.has(it.uid)) ORG.idOf.set(it.uid, ORG.next++);
    orgBuild();
    orgRender();
    // Fetch only readings newer than what is already held, per device with a new measurement.
    await Promise.all(items.map(async (it) => {
      const id = ORG.idOf.get(it.uid);
      if (ORG.rev[id] === it.rev || ORG.pending.has(id)) return;
      ORG.pending.add(id);
      const gen = ORG.gen;
      try {
        const have = ORG.raw[id] || [];
        const since = have.length ? have[have.length - 1].t : 0;
        const {readings} = await ORG.loader(it.uid, 'recent', since);
        if (gen !== ORG.gen) return; // organization switched meanwhile
        const latest = ORG.raw[id] || [];
        const last = latest.length ? latest[latest.length - 1].t : 0;
        ORG.raw[id] = latest.concat(readings.filter((p) => p.t > last)).slice(-96);
        ORG.rev[id] = it.rev;
      } catch (e) { /* keep previous */ } finally {
        ORG.pending.delete(id);
      }
    }));
    orgBuild();
    await orgRefreshSelectedRange();
    orgRender();
  },
  tick() {
    if (!ORG.items.length) return;
    orgBuild();
    refreshAges();
    renderMiniCards();
  },
  selectedUid() {
    const n = latestNodes.find((x) => x.id === selectedDashboardNode);
    return n ? n.uid : null;
  },
};
