// ReCore Sentinel Monitor — read-only, installable phone view.
//
// Data: the same Firestore documents as the customer dashboard (../app/), read with
// the signed-in user's Firebase ID token. firestore.rules allow reads only for
// members of the organization (verified email) and refuse every write, so access
// control does not depend on this page. Nothing here writes to the database.
//
// Cost/battery: realtime listeners on the org's node/hub/location docs (one read per
// changed doc), bounded history queries, listeners stopped while the app is hidden.
import {firebaseConfig, FUNCTIONS_REGION, FIREBASE_SDK, USE_EMULATORS} from "../app/firebase-config.js";
import * as St from "./status.js";
import {sparkline, lineChart} from "./chart.js";

void FUNCTIONS_REGION; // functions are not used by this read-only app

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>'"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"}[c]));
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch { /* storage unavailable: preferences just aren't remembered */ }
  },
};
const NO_PROP = "__none";
const SKELETON = Array.from({length: 3}, () => `<li class="mon-row skeleton" aria-hidden="true"><div></div></li>`).join("");
const VOLT_COLOR = "#38d996";
const TEMP_COLORS = {onboard: "#3d8fe6", probe: "#cc7814"};

let fb = null;
const M = {
  gen: 0, user: null, orgs: {}, orgId: null, org: null,
  locations: {}, hubs: {}, nodes: [], loaded: {nodes: false, hubs: false, locations: false},
  recent: {}, // uid -> {readings: [], rev, busy, again}
  ranges: {}, // `${uid}:${range}` -> {readings, capped, rev, at}
  conn: {loading: true, error: null, online: navigator.onLine, fromCache: false, paused: false, lastSyncMs: null},
  unsubUser: null, unsubOrg: [],
  prop: store.get("monProp") || "", view: store.get("monView") === "gauges" ? "gauges" : "list",
  catFilter: "", range: "24h", detailUid: null,
};

// ---------------------------------------------------------------- helpers
function flash(msg) {
  const el = $("flash");
  el.textContent = msg || "";
  el.hidden = !msg;
}
function show(view) {
  for (const v of ["bootView", "authView", "verifyView", "noOrgView", "listView", "detailView"]) $(v).hidden = v !== view;
  $("accountBar").hidden = !M.user;
  $("fresh").hidden = !(view === "listView" || view === "detailView");
}
function friendly(e) {
  const code = (e && e.code) || "";
  const map = {
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/user-not-found": "Email or password is incorrect.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "No connection. Check your signal and try again.",
    "permission-denied": "You don't have access to this organization's equipment.",
    "unavailable": "The cloud can't be reached right now.",
  };
  return map[code] || map[code.replace(/^firestore\//, "")] || "Something went wrong. Try again.";
}
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
const fmtWhen = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString([], {weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "—");
const nameOf = (n) => (n && (n.name || n.hubName)) || (n && n.id) || "Unnamed monitor";
const locNameOf = (id) => (id && M.locations[id] ? M.locations[id].name : "No property set");
const hubNameOf = (id) => (id && M.hubs[id] ? M.hubs[id].name || id : id || "unknown hub");

// ---------------------------------------------------------------- Firebase
async function loadFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}`;
  const [app, auth, fs] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`),
  ]);
  const a = app.initializeApp(firebaseConfig);
  const authInst = auth.getAuth(a);
  // Default Firestore web cache is in memory only: readings are never written to
  // the device's disk and disappear with the page (and on sign-out we reload).
  const db = fs.getFirestore(a);
  if (USE_EMULATORS) {
    auth.connectAuthEmulator(authInst, "http://127.0.0.1:9099");
    fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
  return {auth, fs, authInst, db};
}

// ---------------------------------------------------------------- auth
let resetMode = false;
function wireAuth() {
  $("resetToggle").addEventListener("click", () => {
    resetMode = !resetMode;
    $("pwRow").hidden = resetMode;
    $("authSubmit").textContent = resetMode ? "Email me a reset link" : "Sign in";
    $("resetToggle").textContent = resetMode ? "Back to sign in" : "Forgot password?";
  });
  $("authForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("authEmail").value.trim();
    if (!email) return flash("Enter your email address.");
    $("authSubmit").disabled = true;
    flash("");
    try {
      if (resetMode) {
        await fb.auth.sendPasswordResetEmail(fb.authInst, email, {url: location.origin + location.pathname});
        flash("If that email has an account, a reset link is on its way.");
      } else {
        await fb.auth.signInWithEmailAndPassword(fb.authInst, email, $("authPassword").value);
        $("authPassword").value = "";
      }
    } catch (e) {
      flash(friendly(e));
    } finally {
      $("authSubmit").disabled = false;
    }
  });
  $("verifiedBtn").addEventListener("click", async () => {
    try {
      await fb.authInst.currentUser.reload();
      await fb.authInst.currentUser.getIdToken(true);
      onUser(fb.authInst.currentUser);
    } catch (e) {
      flash(friendly(e));
    }
  });
  $("signOutBtn").addEventListener("click", signOut);
}

// Sign-out leaves nothing private behind: listeners stopped, in-memory data
// dropped, the remembered organization forgotten, then a full reload so no
// reading survives in page memory. (Readings are never cached on disk.)
async function signOut() {
  stopAll();
  wipeData();
  store.set("monOrg", null);
  store.set("monProp", null);
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({type: "signed-out"});
  } catch { /* ignore */ }
  try {
    await fb.auth.signOut(fb.authInst);
  } finally {
    location.replace(location.pathname);
  }
}

function wipeData() {
  M.gen++;
  Object.assign(M, {orgs: {}, orgId: null, org: null, locations: {}, hubs: {}, nodes: [], recent: {}, ranges: {}, detailUid: null,
    loaded: {nodes: false, hubs: false, locations: false}});
  window.OrgDash && window.OrgDash.reset();
  $("nodeList").innerHTML = "";
  $("detailBody").innerHTML = "";
  $("dashboardSummary").innerHTML = "";
  $("dashboardDetail").innerHTML = "";
}

function onUser(user) {
  const switched = !M.user || !user || M.user.uid !== user.uid;
  stopAll();
  if (switched) wipeData();
  M.user = user;
  flash("");
  if (!user) return show("authView");
  if (!user.emailVerified) {
    $("verifyEmail").textContent = user.email || "";
    return show("verifyView");
  }
  // Signed in: show the loading skeleton straight away.
  M.conn.loading = true;
  show("listView");
  $("nodeList").hidden = false;
  $("gaugeWrap").hidden = true;
  $("nodeList").innerHTML = SKELETON;
  renderFresh();
  watchUser(user);
}

// The user's organization index. Stopped while the app is hidden, like the rest.
function watchUser(user) {
  const {fs, db} = fb;
  const gen = M.gen;
  if (M.unsubUser) M.unsubUser();
  M.unsubUser = fs.onSnapshot(fs.doc(db, "users", user.uid), {includeMetadataChanges: true}, (snap) => {
    if (gen !== M.gen) return;
    if (snap.metadata && snap.metadata.fromCache && !snap.exists()) {
      // Offline with nothing loaded: don't mistake that for "no organizations".
      M.conn.fromCache = true;
      if (!M.orgId) {
        show("listView");
        $("nodeList").hidden = false;
        $("gaugeWrap").hidden = true;
        $("nodeList").innerHTML = `<li class="mon-empty">Can't reach the cloud, and no readings are stored on this device. They'll appear when you're back online.</li>`;
        renderFresh();
      }
      return;
    }
    M.orgs = (snap.exists() && snap.data().orgs) || {};
    pickOrg();
  }, (e) => {
    if (gen !== M.gen) return;
    flash(friendly(e));
    show("noOrgView");
  });
}

function pickOrg() {
  const ids = Object.keys(M.orgs).sort((a, b) => String(M.orgs[a].name || a).localeCompare(String(M.orgs[b].name || b)));
  if (!ids.length) {
    stopOrg();
    return show("noOrgView");
  }
  const want = [M.orgId, store.get("monOrg"), ids[0]].find((x) => x && M.orgs[x]);
  $("orgSelect").innerHTML = ids.map((id) => `<option value="${esc(id)}"${id === want ? " selected" : ""}>${esc(M.orgs[id].name || id)}</option>`).join("");
  $("orgSelect").hidden = ids.length < 2;
  if (want !== M.orgId || !M.unsubOrg.length) selectOrg(want);
}

function selectOrg(orgId) {
  const changed = orgId !== M.orgId;
  stopOrg();
  if (changed) {
    M.gen++;
    Object.assign(M, {org: null, locations: {}, hubs: {}, nodes: [], recent: {}, ranges: {}, catFilter: "",
      loaded: {nodes: false, hubs: false, locations: false}});
    if (M.orgId) M.prop = "";
    window.OrgDash.reset();
  }
  M.orgId = orgId;
  store.set("monOrg", orgId);
  routeFromHash();
  subscribeOrg();
  renderAll();
}

// ---------------------------------------------------------------- listeners
function stopOrg() {
  M.unsubOrg.forEach((u) => u());
  M.unsubOrg = [];
}
function stopAll() {
  stopOrg();
  if (M.unsubUser) M.unsubUser();
  M.unsubUser = null;
}

function subscribeOrg() {
  if (!M.orgId || document.hidden) {
    M.conn.paused = !!document.hidden;
    renderFresh();
    return;
  }
  const {fs, db} = fb;
  const gen = M.gen;
  const base = ["orgs", M.orgId];
  M.conn.loading = true;
  M.conn.error = null;
  M.conn.paused = false;
  renderFresh();
  const watch = (ref, apply) => {
    M.unsubOrg.push(fs.onSnapshot(ref, {includeMetadataChanges: true}, (snap) => {
      if (gen !== M.gen) return;
      const fromCache = !!(snap.metadata && snap.metadata.fromCache);
      M.conn.fromCache = fromCache;
      if (!fromCache) {
        M.conn.lastSyncMs = Date.now();
        M.conn.loading = false;
      }
      if (fromCache && !M.loaded.nodes) {
        // Offline cold start: an empty cache must not look like "no equipment".
        renderAll();
        return;
      }
      apply(snap);
      renderAll();
      refreshHistories();
    }, (e) => {
      if (gen !== M.gen) return;
      M.conn.error = friendly(e);
      M.conn.loading = false;
      if (e && /permission/.test(e.code || "")) {
        // Membership removed: drop everything we held for this organization.
        Object.assign(M, {nodes: [], hubs: {}, locations: {}, recent: {}, ranges: {}});
      }
      renderAll();
    }));
  };
  watch(fs.doc(db, ...base), (s) => {
    M.org = s.exists() ? s.data() : {};
  });
  watch(fs.collection(db, ...base, "locations"), (q) => {
    M.locations = Object.fromEntries(q.docs.map((d) => [d.id, {id: d.id, ...d.data()}]));
    M.loaded.locations = true;
  });
  watch(fs.collection(db, ...base, "hubs"), (q) => {
    M.hubs = Object.fromEntries(q.docs.map((d) => [d.id, {id: d.id, ...d.data()}]));
    M.loaded.hubs = true;
  });
  watch(fs.collection(db, ...base, "nodes"), (q) => {
    M.nodes = q.docs.map((d) => ({id: d.id, ...d.data()}));
    M.loaded.nodes = true;
  });
}

// Pause everything while the app is in the background (no reads, no timers doing work).
document.addEventListener("visibilitychange", () => {
  if (!fb || !M.user || !M.orgId) return;
  if (document.hidden) {
    stopAll();
    M.conn.paused = true;
    renderFresh();
  } else {
    if (!M.unsubUser && M.user && M.user.emailVerified) watchUser(M.user);
    if (!M.unsubOrg.length) subscribeOrg();
  }
});
window.addEventListener("online", () => {
  M.conn.online = true;
  renderAll();
  refreshHistories();
});
window.addEventListener("offline", () => {
  M.conn.online = false;
  renderAll();
});

// ---------------------------------------------------------------- history
// Newest readings (within 24 h, at most RECENT_LIMIT) per node for sparklines and
// mode inference. Only readings newer than what is held are fetched, and only
// when the node's latest measurement changed. One request per node at a time.
async function fetchRecent(uid) {
  const node = M.nodes.find((n) => n.id === uid);
  if (!node) return;
  const c = M.recent[uid] || (M.recent[uid] = {readings: [], rev: undefined, busy: false, again: false});
  const rev = node.lastMeasuredMs ?? null;
  if (c.rev === rev && c.readings.length) return;
  if (c.busy) {
    c.again = true;
    return;
  }
  c.busy = true;
  const gen = M.gen;
  try {
    const {fs, db} = fb;
    const floor = Date.now() - St.RANGES["24h"];
    const since = c.readings.length ? Math.max(c.readings[c.readings.length - 1].t, floor) : floor;
    const col = fs.collection(db, "orgs", M.orgId, "nodes", uid, "readings");
    const snap = await fs.getDocs(fs.query(col, fs.where("measuredMs", ">", since), fs.orderBy("measuredMs", "desc"), fs.limit(St.RECENT_LIMIT)));
    if (gen !== M.gen) return;
    const fresh = snap.docs.map((d) => St.readingFromDoc(d.data()));
    c.readings = St.mergeReadings(c.readings.filter((r) => r.t > floor), fresh, St.RECENT_LIMIT);
    c.rev = rev;
    c.failed = false;
  } catch {
    c.failed = true; // row shows "trend unavailable"; retried on the next change
  } finally {
    c.busy = false;
    if (c.again && gen === M.gen) {
      c.again = false;
      queueMicrotask(() => fetchRecent(uid));
    }
  }
}

let historyRun = null;
let historyAgain = false;
function refreshHistories() {
  if (!fb || !M.orgId || document.hidden || M.conn.online === false) return;
  if (historyRun) {
    historyAgain = true;
    return;
  }
  historyRun = (async () => {
    const queue = M.nodes.map((n) => n.id);
    const worker = async () => {
      while (queue.length) await fetchRecent(queue.shift());
    };
    await Promise.all([worker(), worker(), worker()]); // at most 3 requests in flight
    renderAll();
  })().finally(() => {
    historyRun = null;
    if (historyAgain) {
      historyAgain = false;
      refreshHistories();
    }
  });
}

async function loadRange(uid, range) {
  const node = M.nodes.find((n) => n.id === uid);
  const key = `${uid}:${range}`;
  const have = M.ranges[key];
  const rev = node ? node.lastMeasuredMs ?? null : null;
  if (have && have.rev === rev && Date.now() - have.at < 10 * 60e3) return have;
  if (have && have.pending) return have.pending;
  const {fs, db} = fb;
  const gen = M.gen;
  const col = fs.collection(db, "orgs", M.orgId, "nodes", uid, "readings");
  const pending = fs.getDocs(fs.query(col, fs.where("measuredMs", ">=", Date.now() - St.RANGES[range]),
    fs.orderBy("measuredMs", "desc"), fs.limit(St.RANGE_LIMIT[range]))).then((snap) => {
    const readings = snap.docs.map((d) => St.readingFromDoc(d.data())).filter(Boolean).reverse();
    const out = {readings, capped: snap.docs.length >= St.RANGE_LIMIT[range], rev, at: Date.now()};
    if (gen === M.gen) M.ranges[key] = out;
    return out;
  }).catch((e) => {
    if (gen === M.gen) delete M.ranges[key];
    throw e;
  });
  M.ranges[key] = {...(have || {}), pending};
  return pending;
}

// ---------------------------------------------------------------- evaluation
function evaluateAll(now) {
  const evals = M.nodes.map((n) => {
    const times = (M.recent[n.id]?.readings || []).map((r) => r.t);
    return {...St.evaluateNode(n, now, times), node: n};
  });
  const hubEvals = {};
  for (const h of Object.values(M.hubs)) hubEvals[h.id] = St.evaluateHub(h, evals, now);
  for (const e of evals) {
    e.hub = e.hubUid ? (hubEvals[e.hubUid] || St.evaluateHub(null, [], now)) : St.evaluateHub(null, [], now);
    e.why = St.attribute(e, e.hub, evals);
    e.cat = St.category(e);
  }
  return {evals, hubEvals};
}

const propOf = (e) => e.node.locationId && M.locations[e.node.locationId] ? e.node.locationId : NO_PROP;
function inProp(e) {
  return !M.prop || propOf(e) === M.prop;
}

const CAT_LABEL = {critical: "Critical", low: "Low", late: "Late", offline: "Offline", never: "No reports", unknown: "No status", ok: "OK"};
const CAT_TONE = {critical: "bad", offline: "bad", low: "warn", late: "warn", never: "muted", unknown: "muted", ok: "good"};

function batteryPill(e) {
  if (e.battery === "UNKNOWN") return `<span class="pill muted">Battery: no status</span>`;
  const current = e.reporting === "reporting" || e.reporting === "late";
  const tone = e.battery === "CRITICAL" ? "bad" : e.battery === "LOW" ? "warn" : "good";
  const text = e.battery === "OK" ? "Battery OK" : `Battery ${e.battery.toLowerCase()}`;
  return current ? `<span class="pill ${tone}">${text}</span>` : `<span class="pill muted">Last known: ${text.replace("Battery ", "")}</span>`;
}
function reportingPill(e) {
  const map = {reporting: ["good", "Reporting"], late: ["warn", "Report late"], offline: ["bad", "Not reporting"], never: ["muted", "No reports yet"]};
  const [tone, text] = map[e.reporting];
  return `<span class="pill ${tone}">${text}</span>`;
}
function whyText(e) {
  const hub = esc(hubNameOf(e.hubUid));
  switch (e.why) {
    case "node": return `${hub} is still uploading, so this monitor itself hasn't been heard. Check its battery connection, antenna or range.`;
    case "hub": return `No monitors on ${hub} have reported since ${esc(fmtWhen(e.hub.lastMs))}. The hub, its Wi-Fi or its internet connection is the likely cause; the monitors themselves may be fine.`;
    case "revoked": return `${hub}'s cloud access was revoked, so its readings are no longer accepted.`;
    case "unknown": return `Can't tell whether the monitor or ${hub} is the problem: there's no other monitor on that hub reporting to compare with.`;
    default: return "";
  }
}
function voltText(e) {
  return e.voltage === null ? "—" : `${e.voltage.toFixed(2)}<small> V</small>`;
}

// ---------------------------------------------------------------- render
function renderFresh() {
  const el = $("fresh");
  const f = St.appFreshness(M.conn, Date.now());
  const at = f.lastSyncMs ? fmtClock(f.lastSyncMs) : null;
  const text = {
    loading: "Connecting to the cloud…",
    live: `Connected · last update received ${at}`,
    paused: `Paused in background · data as of ${at || "—"}`,
    disconnected: at ? `No connection · showing data as of ${at}; it may be out of date` : "No connection · nothing loaded yet",
    error: `${M.conn.error || "Problem loading data"}${at ? ` · data as of ${at}` : ""}`,
  }[f.state];
  el.className = `mon-fresh ${f.state}`;
  el.textContent = text;
  document.body.classList.toggle("is-stale", f.state === "disconnected" || f.state === "error");
}

function renderAll() {
  renderFresh();
  if (!M.orgId || !M.user) return;
  if (M.detailUid) renderDetail();
  else renderList();
}

function renderList() {
  show("listView");
  const now = Date.now();
  const {evals, hubEvals} = evaluateAll(now);
  const ready = M.loaded.nodes;

  // property selector
  const props = Object.values(M.locations).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const unassigned = evals.filter((e) => propOf(e) === NO_PROP).length;
  if (M.prop && M.prop !== NO_PROP && !M.locations[M.prop] && M.loaded.locations) M.prop = "";
  const opts = [["", `All properties (${evals.length})`], ...props.map((l) => [l.id, `${l.name} (${evals.filter((e) => propOf(e) === l.id).length})`])];
  if (unassigned) opts.push([NO_PROP, `No property set (${unassigned})`]);
  $("propSelect").innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}"${v === M.prop ? " selected" : ""}>${esc(t)}</option>`).join("");
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === M.view)));

  const scoped = evals.filter(inProp);
  const sum = St.summarize(scoped);
  const tiles = [["critical", "Critical", "bad"], ["low", "Low", "warn"], ["late", "Late", "warn"], ["offline", "Offline", "bad"]];
  if (sum.never) tiles.push(["never", "No reports", "muted"]);
  $("summary").innerHTML = !ready ? "" : tiles.map(([k, label, tone]) =>
    `<button type="button" class="mon-tile ${sum[k] ? tone : "zero"}${M.catFilter === k ? " on" : ""}" data-cat="${k}" aria-pressed="${M.catFilter === k}">
      <b>${sum[k]}</b><span>${label}</span></button>`).join("");
  $("summary").querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
    M.catFilter = M.catFilter === b.dataset.cat ? "" : b.dataset.cat;
    renderList();
  }));

  // all-properties overview
  if (!M.prop && ready && (props.length > 1 || (props.length && unassigned))) {
    const groups = [...props.map((l) => [l.id, l.name]), ...(unassigned ? [[NO_PROP, "No property set"]] : [])];
    $("propOverview").innerHTML = `<div class="mon-overview">${groups.map(([id, name]) => {
      const es = evals.filter((e) => propOf(e) === id);
      const s = St.summarize(es);
      const worst = St.sortEvals(es, (e) => nameOf(e.node))[0];
      const tone = worst ? CAT_TONE[worst.cat] : "muted";
      const issues = ["critical", "offline", "low", "late", "never"].filter((k) => s[k]).map((k) => `${s[k]} ${CAT_LABEL[k].toLowerCase()}`).join(" · ");
      return `<button type="button" class="mon-propcard ${tone}" data-prop="${esc(id)}"><b>${esc(name)}</b>
        <span>${es.length} monitor${es.length === 1 ? "" : "s"}</span><em>${esc(issues || (es.length ? "All OK" : "No monitors"))}</em></button>`;
    }).join("")}</div>`;
    $("propOverview").querySelectorAll("[data-prop]").forEach((b) => b.addEventListener("click", () => setProp(b.dataset.prop)));
  } else {
    $("propOverview").innerHTML = "";
  }

  // hubs in scope
  const hubIds = new Set(scoped.map((e) => e.hubUid).filter(Boolean));
  for (const h of Object.values(M.hubs)) if (!M.prop || h.locationId === M.prop) hubIds.add(h.id);
  $("hubLine").innerHTML = [...hubIds].filter((id) => M.hubs[id]).map((id) => {
    const h = hubEvals[id];
    const label = {online: "uploading", silent: "no uploads", never: "never uploaded", revoked: "revoked"}[h.state] || h.state;
    const age = h.lastMs ? St.ageText((now - h.lastMs) / 1000) : "";
    const tone = h.state === "online" ? "good" : h.state === "silent" || h.state === "revoked" ? "bad" : "muted";
    return `<span class="mon-hub ${tone}"><i></i><b>${esc(hubNameOf(id))}</b> ${label}${age ? ` · last upload ${age}` : ""}</span>`;
  }).join("");

  // list
  const list = St.sortEvals(scoped.filter((e) => !M.catFilter || e.cat === M.catFilter), (e) => nameOf(e.node));
  $("filterNote").innerHTML = M.catFilter ? `<p class="mon-filter">Showing ${esc(CAT_LABEL[M.catFilter].toLowerCase())} only · <button type="button" class="mon-link" id="clearCat">Show all</button></p>` : "";
  $("clearCat")?.addEventListener("click", () => {
    M.catFilter = "";
    renderList();
  });

  const listEl = $("nodeList");
  const gaugeEl = $("gaugeWrap");
  listEl.hidden = M.view !== "list";
  gaugeEl.hidden = M.view !== "gauges";

  if (!ready) {
    listEl.innerHTML = M.conn.fromCache || M.conn.online === false ?
      `<li class="mon-empty">Can't reach the cloud, and no readings are stored on this device. They'll appear when you're back online.</li>` :
      M.conn.error ? `<li class="mon-empty">${esc(M.conn.error)}</li>` :
      SKELETON;
    if (M.view === "gauges") gaugeEl.hidden = true, listEl.hidden = false;
  } else if (!list.length) {
    listEl.innerHTML = `<li class="mon-empty">${evals.length ? "No monitors match this view." : "No monitors are registered to this organization yet."}</li>`;
  } else if (M.view === "list") {
    listEl.innerHTML = list.map((e) => rowHtml(e, now)).join("");
    for (const e of list) {
      const slot = listEl.querySelector(`[data-spark="${CSS.escape(e.uid)}"]`);
      if (!slot) continue;
      const c = M.recent[e.uid];
      if (c && c.readings.length > 1) slot.replaceChildren(sparkline(c.readings, {width: slot.clientWidth || 120, label: `${nameOf(e.node)} voltage, last 24 h`}));
      else if (c && c.readings.length === 1) slot.innerHTML = `<span class="mon-muted">Only one reading in 24 h</span>`;
      else slot.innerHTML = `<span class="mon-muted">${c && c.failed ? "Trend unavailable" : c && c.rev !== undefined ? "No readings in 24 h" : "Loading trend…"}</span>`;
    }
    listEl.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openDetail(b.dataset.open)));
  }
  if (ready && M.view === "gauges") {
    listEl.innerHTML = list.length ? "" : listEl.innerHTML;
    listEl.hidden = !!list.length;
    gaugeEl.hidden = !list.length;
    window.OrgDash.update(list.map((e) => ({
      uid: e.uid, name: nameOf(e.node), location: locNameOf(e.node.locationId), via: hubNameOf(e.hubUid),
      hubCloud: e.why === "hub" ? "offline" : e.hub.state === "silent" ? "online" : e.hub.state,
      latest: e.node.latest || null, measuredMs: e.measuredMs, rev: e.measuredMs,
      expectedIntervalMin: e.interval.source === "configured" ? e.interval.seconds / 60 : Math.round(e.interval.seconds / 60) || 1,
    })), "No monitors match this view.");
  }

  const orgName = (M.org && M.org.name) || M.orgs[M.orgId]?.name || "this organization";
  $("footNote").textContent = ready ? `${evals.length} monitor${evals.length === 1 ? "" : "s"} registered to ${orgName}. ` +
    "Equipment not yet added to the organization doesn't appear here. Charge percentages are estimates from resting voltage." : "";
}

function rowHtml(e, now) {
  const n = e.node;
  const age = e.measuredMs ? St.ageText((now - e.measuredMs) / 1000) : "never";
  const charge = e.voltage === null ? "" : St.chargeText(e.charge);
  const stale = e.reporting === "late" || e.reporting === "offline";
  return `<li><button type="button" class="mon-row cat-${e.cat}" data-open="${esc(e.uid)}">
    <span class="r-main">
      <span class="r-name">${esc(nameOf(n))}</span>
      <span class="r-sub">${esc(locNameOf(n.locationId))} · via ${esc(hubNameOf(e.hubUid))}</span>
      <span class="r-pills">${batteryPill(e)}${reportingPill(e)}${e.why === "hub" ? `<span class="pill muted">Hub not uploading</span>` : ""}</span>
    </span>
    <span class="r-side">
      <span class="r-volt${stale ? " dim" : ""}">${voltText(e)}</span>
      <span class="r-charge">${esc(charge)}</span>
      <span class="r-age${stale ? " warn" : ""}" title="${esc(fmtWhen(e.measuredMs))}">${esc(age)}</span>
    </span>
    <span class="r-spark" data-spark="${esc(e.uid)}"></span>
  </button></li>`;
}

// ---------------------------------------------------------------- detail
function openDetail(uid) {
  location.hash = `#/d/${encodeURIComponent(uid)}`;
}
function routeFromHash() {
  const m = /^#\/d\/(.+)$/.exec(location.hash);
  M.detailUid = m ? decodeURIComponent(m[1]) : null;
}
window.addEventListener("hashchange", () => {
  routeFromHash();
  renderAll();
  if (!M.detailUid) window.scrollTo(0, 0);
});

let detailKey = null;
function renderDetail() {
  show("detailView");
  const body = $("detailBody");
  if (!M.loaded.nodes) {
    body.innerHTML = `<p class="mon-muted">${M.conn.error ? esc(M.conn.error) : "Loading…"}</p>`;
    return;
  }
  const now = Date.now();
  const {evals} = evaluateAll(now);
  const e = evals.find((x) => x.uid === M.detailUid);
  if (!e) {
    body.innerHTML = `<p class="mon-empty">This monitor isn't in ${esc((M.org && M.org.name) || "this organization")}.</p>`;
    detailKey = null;
    return;
  }
  const n = e.node;
  const L = n.latest || {};
  const onboard = typeof L.internalTemperatureF === "number" ? L.internalTemperatureF : typeof L.temperatureF === "number" ? L.temperatureF : null;
  const probe = typeof L.externalTemperatureF === "number" ? L.externalTemperatureF : null;
  const rssi = Number.isInteger(L.rssi) ? L.rssi : null;
  const current = e.reporting === "reporting" || e.reporting === "late";
  const lastKnown = current ? "" : `<small>last known</small>`;
  const modeText = `${St.MODE_LABEL[e.interval.mode]} · ${St.intervalText(e.interval.seconds)}`;
  const modeSrc = {configured: "set in the dashboard", inferred: "inferred from report timing", assumed: "assumed (not enough history)"}[e.interval.source];
  const th = St.thresholds(e.interval.seconds);
  const hubState = {online: "Uploading", silent: "No recent uploads", never: "Never uploaded", revoked: "Revoked", unknown: "Unknown"}[e.hub.state];
  const charge = e.voltage === null ? "—" : St.chargeText(e.charge);
  const key = [e.uid, e.measuredMs, M.range].join("|");

  const metrics = `
    <div class="mon-metric big"><span>Voltage ${lastKnown}</span><b>${voltText(e)}</b></div>
    <div class="mon-metric"><span>Estimated charge ${lastKnown}</span><b>${esc(charge)}</b><em>Estimate from resting voltage; reads high while charging.</em></div>
    <div class="mon-metric"><span>Onboard temperature ${lastKnown}</span><b>${onboard === null ? "Not reported" : `${onboard.toFixed(1)} °F`}</b></div>
    <div class="mon-metric"><span>Probe temperature ${lastKnown}</span><b>${probe === null ? (L.externalTempStatus && L.externalTempStatus !== "OK" ? esc(String(L.externalTempStatus).toLowerCase().replace(/^./, (c) => c.toUpperCase())) : "No probe reading") : `${probe.toFixed(1)} °F`}</b></div>
    <div class="mon-metric"><span>Signal at hub ${lastKnown}</span><b>${rssi === null ? "Not reported" : `${esc(St.signalQuality(rssi))} <small>${rssi} dBm</small>`}</b></div>`;

  const facts = [
    ["Battery condition", batteryPill(e)],
    ["Node reporting", `${reportingPill(e)} <span class="mon-muted">last measured ${esc(fmtWhen(e.measuredMs))} (${esc(e.measuredMs ? St.ageText((now - e.measuredMs) / 1000) : "never")})</span>`],
    ["Reporting mode", `${esc(modeText)} <span class="mon-muted">— ${esc(modeSrc)}. Late after ${esc(St.ageText(th.lateS).replace(" ago", ""))}, offline after ${esc(St.ageText(th.offlineS).replace(" ago", ""))}.</span>`],
    ["Hub connection", `<b>${esc(hubNameOf(e.hubUid))}</b>: ${esc(hubState)}${e.hub.lastMs ? ` · last upload ${esc(fmtWhen(e.hub.lastMs))}` : ""}`],
    ["Property", esc(locNameOf(n.locationId))],
    ["Device ID", `<code>${esc(e.uid)}</code>`],
  ];
  if (M.hubs[e.hubUid]?.firmwareVersion) facts.push(["Hub firmware", esc(M.hubs[e.hubUid].firmwareVersion)]);

  // Keep the charts' DOM (and an open tooltip) unless something changed.
  if (detailKey === key && body.querySelector(".mon-detail")) {
    body.querySelector(".mon-metrics").innerHTML = metrics;
    body.querySelector(".mon-facts").innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    return;
  }
  detailKey = key;
  body.innerHTML = `<article class="mon-detail cat-${e.cat}">
    <h1 class="d-name">${esc(nameOf(n))}</h1>
    <p class="mon-muted d-sub">${esc(locNameOf(n.locationId))} · via ${esc(hubNameOf(e.hubUid))}</p>
    ${e.why ? `<p class="mon-why">${whyText(e)}</p>` : ""}
    <div class="mon-metrics">${metrics}</div>
    <dl class="mon-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="mon-range" role="group" aria-label="History range">${Object.keys(St.RANGES).map((r) =>
      `<button type="button" data-range="${r}" aria-pressed="${r === M.range}">${{"24h": "24 hours", "7d": "7 days", "30d": "30 days"}[r]}</button>`).join("")}</div>
    <div id="histNote" class="mon-muted"></div>
    <div id="chartVolt"></div><div id="chartTemp"></div><div id="chartRssi"></div>
    <details class="mon-table"><summary>Readings table</summary><div id="histTable"></div></details>
  </article>`;
  body.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
    M.range = b.dataset.range;
    detailKey = null;
    renderDetail();
  }));
  drawHistory(e);
}

async function drawHistory(e) {
  const uid = e.uid;
  const range = M.range;
  const note = $("histNote");
  note.textContent = "Loading history…";
  document.querySelector(".mon-detail")?.classList.add("loading");
  let res;
  try {
    res = await loadRange(uid, range);
  } catch (err) {
    if (M.detailUid !== uid || M.range !== range) return;
    note.textContent = `History couldn't be loaded (${friendly(err)}).`;
    document.querySelector(".mon-detail")?.classList.remove("loading");
    return;
  }
  if (M.detailUid !== uid || M.range !== range || !$("chartVolt")) return;
  document.querySelector(".mon-detail")?.classList.remove("loading");
  const r = res.readings;
  note.textContent = !r.length ? "No readings in this range." :
    `${r.length} reading${r.length === 1 ? "" : "s"}, ${fmtWhen(r[0].t)} – ${fmtWhen(r[r.length - 1].t)}.` +
    (res.capped ? " Showing the most recent readings only; older ones in this range are left out." : "");
  const est = St.chargeEstimate(r.length ? r[r.length - 1].volts : NaN);
  const bands = est.profile === "12V" ? [{from: -Infinity, to: 11.8, color: "#e5533d", label: "critical"}, {from: 11.8, to: 12.2, color: "#f2a530", label: "low"}] : [];
  lineChart($("chartVolt"), {title: "Battery voltage", unit: "V", minSpan: 0.1, bands,
    series: [{name: "Voltage", color: VOLT_COLOR, unit: "V", decimals: 2, points: r.map((p) => ({t: p.t, v: p.volts}))}]});
  const tOn = r.filter((p) => p.tempF !== null).map((p) => ({t: p.t, v: p.tempF}));
  const tPr = r.filter((p) => p.probeF !== null).map((p) => ({t: p.t, v: p.probeF}));
  if (tOn.length || tPr.length) {
    lineChart($("chartTemp"), {title: "Temperature (°F)", unit: "°F", minSpan: 2, height: 150, series: [
      {name: "Onboard", color: TEMP_COLORS.onboard, unit: "°F", decimals: 1, points: tOn},
      {name: "Probe", color: TEMP_COLORS.probe, unit: "°F", decimals: 1, points: tPr}]});
  } else {
    $("chartTemp").innerHTML = `<p class="mon-muted mon-chart-empty">No temperature readings in this range.</p>`;
  }
  const rs = r.filter((p) => p.rssi !== null).map((p) => ({t: p.t, v: p.rssi}));
  if (rs.length) lineChart($("chartRssi"), {title: "Signal at hub (dBm)", unit: "dBm", minSpan: 8, height: 120,
    series: [{name: "Signal", color: "#8aa0bf", unit: "dBm", decimals: 0, points: rs}]});
  else $("chartRssi").innerHTML = "";
  const rows = r.slice(-200).reverse();
  $("histTable").innerHTML = rows.length ? `<table><thead><tr><th>Measured</th><th>Volts</th><th>Onboard °F</th><th>Probe °F</th><th>dBm</th><th>Status</th></tr></thead><tbody>${
    rows.map((p) => `<tr><td>${esc(fmtWhen(p.t))}</td><td>${p.volts.toFixed(2)}</td><td>${p.tempF === null ? "—" : p.tempF.toFixed(1)}</td><td>${p.probeF === null ? "—" : p.probeF.toFixed(1)}</td><td>${p.rssi ?? "—"}</td><td>${esc(p.status)}</td></tr>`).join("")
  }</tbody></table>${r.length > 200 ? `<p class="mon-muted">Newest 200 of ${r.length} shown.</p>` : ""}` : `<p class="mon-muted">No readings.</p>`;
}

// ---------------------------------------------------------------- controls
function setProp(id) {
  M.prop = id;
  store.set("monProp", id || null);
  M.catFilter = "";
  window.OrgDash.reset();
  renderList();
}

function wireControls() {
  $("orgSelect").addEventListener("change", (ev) => selectOrg(ev.target.value));
  $("propSelect").addEventListener("change", (ev) => setProp(ev.target.value));
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    M.view = b.dataset.view;
    store.set("monView", M.view);
    renderList();
  }));
  $("backBtn").addEventListener("click", () => {
    if (history.length > 1 && /^#\/d\//.test(location.hash)) history.back();
    else location.hash = "";
  });
  // The gauge view's own detail card gets a link to the full detail page.
  window.OrgDash.configure({
    loader: async (uid, range, since) => {
      if (range === "recent") {
        await fetchRecent(uid);
        return {readings: (M.recent[uid]?.readings || []).filter((p) => p.t > (since || 0)), capped: false};
      }
      return loadRange(uid, range);
    },
    onSelect: (uid) => {
      const n = M.nodes.find((x) => x.id === uid);
      const b = $("gaugeOpen");
      b.hidden = !n;
      b.dataset.uid = uid;
      b.textContent = n ? `Full details for ${nameOf(n)} ›` : "";
    },
  });
  $("gaugeOpen").addEventListener("click", (ev) => ev.currentTarget.dataset.uid && openDetail(ev.currentTarget.dataset.uid));
  // Ages ("12 min ago") and late/offline states advance without any reads.
  setInterval(() => {
    if (!document.hidden && M.orgId && M.loaded.nodes) {
      if (M.view === "gauges" && !M.detailUid) window.OrgDash.tick();
      else renderAll();
    }
  }, 30000);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register("sw.js", {scope: "./"}).catch(() => { /* app still works without it */ });
}

// ---------------------------------------------------------------- boot
async function main() {
  registerServiceWorker();
  wireControls();
  try {
    fb = await loadFirebase();
  } catch {
    show("authView");
    $("authSubmit").disabled = true;
    flash("Couldn't load sign-in. Check your connection and reload.");
    return;
  }
  wireAuth();
  fb.auth.onAuthStateChanged(fb.authInst, onUser);
}

main();
