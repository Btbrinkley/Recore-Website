// ReCore Sentinel customer dashboard (pilot).
// Reads come straight from Firestore and are limited by firestore.rules to the
// signed-in user's organizations. Every change goes through the `account`
// Cloud Function, which re-checks the user's role server-side.
import {firebaseConfig, FUNCTIONS_REGION, FIREBASE_SDK, USE_EMULATORS} from "./firebase-config.js";
import {
  hubCloudState, nodeState, displayName, timeAgo, filterNodes, sortNodes, RANGES, RANGE_LIMIT, toChartReadings,
} from "./status.js";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>'"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"}[c]));
const RANK = {viewer: 1, admin: 2, owner: 3};

const S = {
  user: null, orgs: {}, orgId: null, role: null, org: null,
  hubs: {}, nodes: [], locations: {}, members: [], discovered: [],
  unsub: [], filter: {locationId: "", hubId: ""}, dialogNode: null, range: "24h",
};

let fb; // loaded SDK functions

function flash(msg, kind = "info") {
  const el = $("flash");
  el.textContent = msg;
  el.className = "app-flash " + kind;
  el.hidden = !msg;
  if (msg && kind !== "error") setTimeout(() => {
    if (el.textContent === msg) el.hidden = true;
  }, 6000);
}
function show(view) {
  for (const v of ["authView", "verifyView", "noOrgView", "dashView"]) $(v).hidden = v !== view;
  $("accountBar").hidden = view === "authView";
}
function friendly(e) {
  const code = e && (e.code || "");
  const map = {
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/user-not-found": "Email or password is incorrect.",
    "auth/email-already-in-use": "That email already has an account. Sign in instead.",
    "auth/weak-password": "Use at least 8 characters.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "Network problem. Check your connection.",
  };
  return map[code] || (e && e.message ? e.message.replace(/^Firebase:\s*/, "") : "Something went wrong.");
}

// ------------------------------------------------------------------ SDK
async function loadFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}`;
  const [app, auth, fs, fn] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`), import(`${base}/firebase-functions.js`),
  ]);
  const a = app.initializeApp(firebaseConfig);
  const authInst = auth.getAuth(a);
  const db = fs.getFirestore(a);
  const functions = fn.getFunctions(a, FUNCTIONS_REGION);
  if (USE_EMULATORS) {
    auth.connectAuthEmulator(authInst, "http://127.0.0.1:9099");
    fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
    fn.connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  }
  return {auth, fs, authInst, db, accountFn: fn.httpsCallable(functions, "account")};
}

async function call(action, data = {}) {
  try {
    const res = await fb.accountFn({action, ...data});
    return res.data;
  } catch (e) {
    flash(friendly(e), "error");
    e.shown = true; // already reported to the user; see unhandledrejection below
    throw e;
  }
}
window.addEventListener("unhandledrejection", (ev) => {
  if (ev.reason && ev.reason.shown) ev.preventDefault();
});

// ----------------------------------------------------------------- auth UI
let authMode = "signin";
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll("[data-auth-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.authTab === mode)));
  $("pwRow").hidden = mode === "reset";
  $("authPassword").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("authSubmit").textContent = {signin: "Sign in", signup: "Create account", reset: "Email me a reset link"}[mode];
  $("authHint").textContent = mode === "signup" ?
    "Use the email address your invitation was sent to. You'll confirm it before seeing any equipment." : "";
}

function wireAuth() {
  document.querySelectorAll("[data-auth-tab]").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.authTab)));
  $("authForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("authEmail").value.trim();
    const pw = $("authPassword").value;
    const {auth, authInst} = fb;
    $("authSubmit").disabled = true;
    try {
      const continueUrl = {url: location.origin + location.pathname};
      if (authMode === "signin") {
        await auth.signInWithEmailAndPassword(authInst, email, pw);
      } else if (authMode === "signup") {
        const cred = await auth.createUserWithEmailAndPassword(authInst, email, pw);
        await auth.sendEmailVerification(cred.user, continueUrl);
      } else {
        await auth.sendPasswordResetEmail(authInst, email, continueUrl);
        // Same message whether or not the account exists.
        flash("If that email has an account, a reset link is on its way.");
        setAuthMode("signin");
      }
    } catch (e) {
      flash(friendly(e), "error");
    } finally {
      $("authSubmit").disabled = false;
    }
  });
  $("signOutBtn").addEventListener("click", () => fb.auth.signOut(fb.authInst));
  $("resendBtn").addEventListener("click", async () => {
    try {
      await fb.auth.sendEmailVerification(fb.authInst.currentUser, {url: location.origin + location.pathname});
      flash("Verification email sent.");
    } catch (e) {
      flash(friendly(e), "error");
    }
  });
  $("verifiedBtn").addEventListener("click", async () => {
    await fb.authInst.currentUser.reload();
    await fb.authInst.currentUser.getIdToken(true); // refresh email_verified claim
    onUser(fb.authInst.currentUser);
  });
}

// Invitation links look like /app/#invite=<token>. Keep the token across the
// sign-up / email-verification round trip, then accept it once verified.
function captureInvite() {
  const m = /invite=([A-Za-z0-9_-]{20,100})/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem("recoreInvite", m[1]);
      localStorage.setItem("recoreInvite", m[1]);
    } catch { /* storage blocked: accept immediately if signed in */ }
    S.pendingInvite = m[1];
    history.replaceState(null, "", location.pathname);
    flash("Invitation found. Sign in or create an account with the invited email address.");
  } else {
    try {
      S.pendingInvite = sessionStorage.getItem("recoreInvite") || localStorage.getItem("recoreInvite");
    } catch { /* ignore */ }
  }
}
function clearInvite() {
  S.pendingInvite = null;
  try {
    sessionStorage.removeItem("recoreInvite");
    localStorage.removeItem("recoreInvite");
  } catch { /* ignore */ }
}

async function onUser(user) {
  stopListeners();
  S.user = user;
  if (!user) {
    S.orgs = {};
    show("authView");
    return;
  }
  if (!user.emailVerified) {
    $("verifyEmail").textContent = user.email;
    show("verifyView");
    return;
  }
  if (S.pendingInvite) {
    try {
      const r = await call("acceptInvite", {token: S.pendingInvite});
      flash("Invitation accepted.");
      S.orgId = r.orgId;
    } catch { /* message already shown */ }
    clearInvite();
  }
  const {fs, db} = fb;
  S.unsub.push(fs.onSnapshot(fs.doc(db, "users", user.uid), (snap) => {
    S.orgs = (snap.exists() && snap.data().orgs) || {};
    renderOrgSelect();
  }, () => show("noOrgView")));
}

function renderOrgSelect() {
  const ids = Object.keys(S.orgs).sort((a, b) => (S.orgs[a].name || a).localeCompare(S.orgs[b].name || b));
  if (!ids.length) {
    show("noOrgView");
    return;
  }
  let saved = null;
  try {
    saved = localStorage.getItem("recoreOrg");
  } catch { /* ignore */ }
  const want = [S.orgId, saved, ids[0]].find((x) => x && S.orgs[x]);
  $("orgSelect").innerHTML = ids.map((id) => `<option value="${esc(id)}" ${id === want ? "selected" : ""}>${esc(S.orgs[id].name || id)}</option>`).join("");
  $("orgSelect").hidden = ids.length < 2;
  if (want !== S.orgDataFor) selectOrg(want);
}

// ------------------------------------------------------------- org data
function stopOrgListeners() {
  (S.orgUnsub || []).forEach((u) => u());
  S.orgUnsub = [];
}
function stopListeners() {
  stopOrgListeners();
  S.unsub.forEach((u) => u());
  S.unsub = [];
  S.orgDataFor = null;
}

function selectOrg(orgId) {
  stopOrgListeners();
  S.orgId = orgId;
  S.orgDataFor = orgId;
  try {
    localStorage.setItem("recoreOrg", orgId);
  } catch { /* ignore */ }
  S.hubs = {};
  S.nodes = [];
  S.locations = {};
  S.members = [];
  S.discovered = [];
  S.filter = {locationId: "", hubId: ""};
  show("dashView");
  const {fs, db} = fb;
  const base = ["orgs", orgId];
  const watch = (path, fn) => S.orgUnsub.push(fs.onSnapshot(path, fn, (e) => flash(friendly(e), "error")));
  watch(fs.doc(db, ...base), (s) => {
    S.org = s.data() || {};
    render();
    renderManage();
  });
  watch(fs.doc(db, ...base, "members", S.user.uid), (s) => {
    S.role = s.exists() ? s.data().role : null;
    render();
    renderManage();
    renderDiscovered();
  });
  watch(fs.collection(db, ...base, "members"), (q) => {
    S.members = q.docs.map((d) => ({uid: d.id, ...d.data()}));
    renderManage();
  });
  watch(fs.collection(db, ...base, "locations"), (q) => {
    S.locations = Object.fromEntries(q.docs.map((d) => [d.id, {id: d.id, ...d.data()}]));
    render();
    renderManage();
  });
  watch(fs.collection(db, ...base, "hubs"), (q) => {
    S.hubs = Object.fromEntries(q.docs.map((d) => [d.id, {id: d.id, ...d.data()}]));
    render();
    renderManage();
  });
  watch(fs.collection(db, ...base, "nodes"), (q) => {
    S.nodes = q.docs.map((d) => ({id: d.id, ...d.data()}));
    render();
    if (S.dialogNode) renderDialog(false);
  });
  watch(fs.collection(db, ...base, "discovered"), (q) => {
    S.discovered = q.docs.map((d) => ({id: d.id, ...d.data()}));
    renderDiscovered();
  });
}

// ---------------------------------------------------------------- render
const canAdmin = () => (RANK[S.role] || 0) >= RANK.admin;
const locName = (id) => (id && S.locations[id] ? S.locations[id].name : "No location");
const hubName = (id) => (id && S.hubs[id] ? S.hubs[id].name || id : id || "—");
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "—");

function render() {
  if (!S.orgId) return;
  const now = Date.now();
  $("orgName").textContent = (S.org && S.org.name) || S.orgs[S.orgId]?.name || "Dashboard";
  $("orgMeta").textContent = S.role ? `Your role: ${S.role}` : "";
  // filters
  const locOpts = Object.values(S.locations).sort((a, b) => a.name.localeCompare(b.name));
  $("locFilter").innerHTML = `<option value="">All locations</option>` +
    locOpts.map((l) => `<option value="${esc(l.id)}" ${l.id === S.filter.locationId ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  const hubList = Object.values(S.hubs).filter((h) => !S.filter.locationId || h.locationId === S.filter.locationId);
  $("hubFilter").innerHTML = `<option value="">All hubs</option>` +
    hubList.map((h) => `<option value="${esc(h.id)}" ${h.id === S.filter.hubId ? "selected" : ""}>${esc(h.name || h.id)}</option>`).join("");

  // hubs
  $("hubStrip").innerHTML = hubList.length ? hubList.map((h) => {
    const c = hubCloudState(h, now);
    const label = {online: "Online", offline: "Cloud offline", never: "Never connected", revoked: "Revoked"}[c.state];
    return `<div class="hub-card ${c.state}"><div class="hub-name">${esc(h.name || h.id)}</div>
      <div class="app-sub">${esc(locName(h.locationId))}${h.role === "gateway" ? " · receive-only" : ""}</div>
      <div class="hub-state"><span class="dot"></span>${label}</div>
      <div class="app-sub">Last upload ${esc(timeAgo(c.lastMs, now))}${h.firmwareVersion ? " · " + esc(h.firmwareVersion) : ""}</div></div>`;
  }).join("") : `<p class="app-sub">No hubs yet.${canAdmin() ? " Use Manage organization → Hubs to claim one." : ""}</p>`;

  // nodes
  const list = sortNodes(filterNodes(S.nodes, S.filter), S.hubs, now);
  const counts = {crit: 0, low: 0, stale: 0, hubOff: Object.values(S.hubs).filter((h) => hubCloudState(h, now).state === "offline").length};
  for (const n of S.nodes) {
    const st = nodeState(n, S.hubs, now);
    if (st.battery === "CRITICAL") counts.crit++;
    else if (st.battery === "LOW") counts.low++;
    if (st.freshness !== "fresh") counts.stale++;
  }
  $("summary").innerHTML = [
    ["Equipment", S.nodes.length, ""], ["Critical", counts.crit, counts.crit ? "bad" : ""],
    ["Low", counts.low, counts.low ? "warn" : ""], ["No recent reading", counts.stale, counts.stale ? "warn" : ""],
    ["Hubs offline", counts.hubOff, counts.hubOff ? "bad" : ""],
  ].map(([k, v, c]) => `<div class="sum ${c}"><b>${v}</b><span>${k}</span></div>`).join("");

  $("nodeGrid").innerHTML = list.length ? list.map((n) => nodeCard(n, now)).join("") :
    `<p class="app-sub">${S.nodes.length ? "Nothing matches these filters." : "No equipment has reported yet."}</p>`;
  document.querySelectorAll("[data-node]").forEach((el) => el.addEventListener("click", () => openNode(el.dataset.node)));
}

function nodeCard(n, now) {
  const st = nodeState(n, S.hubs, now);
  const v = st.voltage === null ? "—" : st.voltage.toFixed(2);
  const badges = [];
  if (st.battery === "CRITICAL") badges.push(`<span class="pill bad">Battery critical</span>`);
  else if (st.battery === "LOW") badges.push(`<span class="pill warn">Battery low</span>`);
  else if (st.battery === "OK") badges.push(`<span class="pill good">Battery OK</span>`);
  if (st.freshness === "stale") {
    badges.push(st.reason === "hub-offline" ? `<span class="pill muted">Hub offline</span>` : `<span class="pill warn">No recent reading</span>`);
  }
  if (st.freshness === "never") badges.push(`<span class="pill muted">No readings</span>`);
  const snoozed = n.alert && n.alert.snoozeUntilMs > now;
  return `<button type="button" class="node-card sev${st.severity}" data-node="${esc(n.id)}">
    <div class="nc-top"><span class="nc-name">${esc(displayName(n))}</span><span class="nc-volt">${v}<small> V</small></span></div>
    <div class="app-sub">${esc(locName(n.locationId))} · ${esc(hubName(n.lastHubId || n.primaryHubId))}</div>
    <div class="nc-badges">${badges.join("")}${snoozed ? `<span class="pill muted">Alerts snoozed</span>` : ""}</div>
    <div class="nc-time">Measured ${esc(timeAgo(st.measuredMs, now))} <span>${esc(fmtTime(st.measuredMs))}</span></div>
  </button>`;
}

function renderDiscovered() {
  const el = $("discovered");
  if (!S.discovered.length || !canAdmin()) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<h2 class="dash-h2">Heard but not registered</h2><p class="app-sub">A receive-only hub heard these devices. Add only equipment you own.</p>` +
    S.discovered.map((d) => `<div class="row-item"><span><b>${esc(d.hubName || d.id)}</b> <code>${esc(d.id)}</code> via ${esc(hubName(d.lastHubId))}, ${esc(timeAgo(d.lastHeardAt?.toMillis?.(), Date.now()))}</span>
      <button class="app-btn small" data-adopt="${esc(d.id)}" type="button">Add to my equipment</button></div>`).join("");
  el.querySelectorAll("[data-adopt]").forEach((b) => b.addEventListener("click", async () => {
    await call("adoptDiscoveredNode", {orgId: S.orgId, deviceUid: b.dataset.adopt});
    flash("Added. Its next reading will appear on the dashboard.");
  }));
}

// ------------------------------------------------------------ node detail
function openNode(id) {
  S.dialogNode = id;
  S.range = "24h";
  renderDialog(true);
  const d = $("nodeDialog");
  if (!d.open) d.showModal();
}

async function loadHistory(n) {
  const {fs, db} = fb;
  const cutoff = Date.now() - RANGES[S.range];
  const q = fs.query(fs.collection(db, "orgs", S.orgId, "nodes", n.id, "readings"),
      fs.where("measuredMs", ">=", cutoff), fs.orderBy("measuredMs", "desc"), fs.limit(RANGE_LIMIT[S.range]));
  const snap = await fs.getDocs(q);
  return toChartReadings(snap.docs.map((d) => ({id: d.id, ...d.data()})));
}

async function renderDialog(reloadChart) {
  const n = S.nodes.find((x) => x.id === S.dialogNode);
  if (!n) return;
  const now = Date.now();
  const st = nodeState(n, S.hubs, now);
  const L = n.latest || {};
  $("ndTitle").textContent = displayName(n);
  $("ndSub").textContent = `${locName(n.locationId)} · primary hub ${hubName(n.primaryHubId)}`;
  const temp = (x) => (typeof x === "number" ? x.toFixed(1) + " °F" : "—");
  $("ndMetrics").innerHTML = [
    ["Voltage", st.voltage === null ? "—" : st.voltage.toFixed(2) + " V"], ["Battery", st.battery],
    ["External probe", temp(L.externalTemperatureF)], ["Onboard", temp(L.internalTemperatureF ?? L.temperatureF)],
    ["Signal", typeof L.rssi === "number" ? L.rssi + " dBm" : "—"],
    ["Last measurement", `${timeAgo(st.measuredMs, now)}<br><small>${esc(fmtTime(st.measuredMs))}</small>`],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  const heard = Object.entries(n.heardBy || {}).map(([h, x]) => `${esc(hubName(h))} (${typeof x.rssi === "number" ? x.rssi + " dBm, " : ""}${esc(timeAgo(x.at?.toMillis?.(), now))})`).join("<br>");
  $("ndFacts").innerHTML = [
    ["Hardware ID", `<code>${esc(n.id)}</code>`], ["Name on hub", esc(n.hubName || "—")],
    ["Reported by", esc(hubName(n.lastHubId))], ["Heard by", heard || "—"],
    ["Radio address", esc(n.internalAddress ?? "—")], ["Hub firmware", esc(L.firmwareVersion || "—")],
    ["Time source", esc({"hub-clock": "hub clock", "receive-age": "hub receive time", "server-receipt": "cloud receipt"}[L.timeSource] || "—")],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  document.querySelectorAll("#ndRanges [data-range]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.range === S.range)));
  renderNodeActions(n);
  if (reloadChart) {
    $("ndChart").innerHTML = `<p class="app-sub">Loading history…</p>`;
    try {
      const readings = await loadHistory(n);
      if (S.dialogNode !== n.id) return;
      window.SentinelChart.render($("ndChart"), readings, `${n.id}:${S.range}`);
    } catch (e) {
      $("ndChart").innerHTML = `<p class="app-sub">Could not load history: ${esc(friendly(e))}</p>`;
    }
  }
}

function renderNodeActions(n) {
  const now = Date.now();
  const snoozedUntil = n.alert && n.alert.snoozeUntilMs > now ? n.alert.snoozeUntilMs : 0;
  let html = `<div class="nd-section"><h3>Alerts</h3><p class="app-sub">${snoozedUntil ? `Snoozed until ${esc(fmtTime(snoozedUntil))}.` :
    (n.alert && n.alert.enabled === false ? "Alerts are off for this device." : "Alerts are on.")}</p>
    <div class="app-row">${[1, 3, 7].map((d) => `<button class="app-btn small ghost" data-snooze="${d}" type="button">Snooze ${d} d</button>`).join("")}
    ${snoozedUntil ? `<button class="app-btn small ghost" data-snooze="0" type="button">Resume</button>` : ""}</div></div>`;
  if (canAdmin()) {
    const locs = Object.values(S.locations).map((l) => `<option value="${esc(l.id)}" ${l.id === n.locationId ? "selected" : ""}>${esc(l.name)}</option>`).join("");
    const hubs = Object.values(S.hubs).map((h) => `<option value="${esc(h.id)}" ${h.id === n.primaryHubId ? "selected" : ""}>${esc(h.name || h.id)}</option>`).join("");
    html += `<form class="nd-section app-form" id="nodeEdit"><h3>Settings</h3>
      <label>Name <input name="name" maxlength="40" value="${esc(n.name || "")}" placeholder="${esc(n.hubName || n.id)}"></label>
      <label>Location <select name="locationId" class="app-select"><option value="">No location</option>${locs}</select></label>
      <label>Primary hub (commands and updates) <select name="primaryHubId" class="app-select">${hubs}</select></label>
      <label>Expected reporting interval (minutes) <input name="interval" type="number" min="1" max="1440" value="${esc(n.expectedIntervalMin || 60)}"></label>
      <label class="check"><input type="checkbox" name="alerts" ${n.alert && n.alert.enabled === false ? "" : "checked"}> Send alerts for this device</label>
      <p class="app-hint">Sampling mode, expected voltage and calibration are changed on the hub's local Control Center; the cloud does not send radio commands yet.</p>
      <button class="app-btn" type="submit">Save</button></form>`;
  }
  $("ndActions").innerHTML = html;
  $("ndActions").querySelectorAll("[data-snooze]").forEach((b) => b.addEventListener("click", async () => {
    await call("snoozeNode", {orgId: S.orgId, deviceUid: n.id, days: Number(b.dataset.snooze)});
    flash(Number(b.dataset.snooze) ? "Alerts snoozed." : "Alerts resumed.");
  }));
  const form = $("nodeEdit");
  if (form) {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      const data = {orgId: S.orgId, deviceUid: n.id, name: f.get("name").trim() || null,
        locationId: f.get("locationId") || null, alertsEnabled: f.get("alerts") === "on",
        expectedIntervalMin: Number(f.get("interval"))};
      if (f.get("primaryHubId")) data.primaryHubId = f.get("primaryHubId");
      await call("updateNode", data);
      flash("Saved.");
    });
  }
}

// --------------------------------------------------------------- manage
function renderManage() {
  const body = $("manageBody");
  if (!body || !S.orgId) return;
  const me = S.members.find((m) => m.uid === S.user?.uid);
  const recipients = new Set((S.org && S.org.alerts && S.org.alerts.recipientUids) || []);
  let html = `<div class="mg-block"><h3>My alerts</h3><label class="check"><input type="checkbox" id="myAlerts" ${recipients.has(S.user?.uid) ? "checked" : ""}>
    Email me (${esc(me?.email || S.user?.email || "")}) when a battery goes low or critical</label></div>`;
  if (canAdmin()) {
    const now = Date.now();
    html += `<div class="mg-block"><h3>Locations</h3>${Object.values(S.locations).map((l) =>
      `<div class="row-item"><span>${esc(l.name)}</span><button class="app-btn small ghost" data-rename-loc="${esc(l.id)}" type="button">Rename</button></div>`).join("")}
      <form class="app-row" id="addLoc"><input name="name" maxlength="60" placeholder="New location name" required><button class="app-btn small" type="submit">Add location</button></form></div>`;
    html += `<div class="mg-block"><h3>Hubs</h3>${Object.values(S.hubs).map((h) => `<div class="row-item"><span><b>${esc(h.name || h.id)}</b> <code>${esc(h.id)}</code><br>
      <small>${esc(locName(h.locationId))} · ${esc(hubCloudState(h, now).state)} · last upload ${esc(timeAgo(hubCloudState(h, now).lastMs, now))}</small></span>
      <span class="app-row"><button class="app-btn small ghost" data-hub-edit="${esc(h.id)}" type="button">Edit</button>
      <button class="app-btn small ghost" data-hub-rotate="${esc(h.id)}" type="button">New token</button>
      <button class="app-btn small danger" data-hub-revoke="${esc(h.id)}" type="button">Revoke</button></span></div>`).join("")}
      <form class="app-form" id="claimHub"><h4>Claim a hub</h4>
        <label>Hub ID <input name="hubUid" placeholder="RC-34B7DA5F1C20" required></label>
        <label>Claim code <input name="claimCode" placeholder="XXXXX-XXXXX" required autocomplete="off"></label>
        <label>Name <input name="name" maxlength="40" placeholder="Barn hub"></label>
        <label>Location <select name="locationId" class="app-select"><option value="">No location</option>${Object.values(S.locations).map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("")}</select></label>
        <button class="app-btn" type="submit">Claim hub</button></form>
      <div id="tokenOut"></div></div>`;
    const canOwner = S.role === "owner";
    html += `<div class="mg-block"><h3>People</h3>${S.members.map((m) => `<div class="row-item"><span>${esc(m.email)} <small>${esc(m.role)}${m.uid === S.user?.uid ? " (you)" : ""}</small></span>
      <span class="app-row">${canOwner ? `<select class="app-select" data-role-for="${esc(m.uid)}">${["owner", "admin", "viewer"].map((r) => `<option ${r === m.role ? "selected" : ""}>${r}</option>`).join("")}</select>` : ""}
      ${(m.uid === S.user?.uid || (m.role !== "owner" || canOwner)) ? `<button class="app-btn small ghost" data-remove="${esc(m.uid)}" type="button">${m.uid === S.user?.uid ? "Leave" : "Remove"}</button>` : ""}
      <label class="check"><input type="checkbox" data-recipient="${esc(m.uid)}" ${recipients.has(m.uid) ? "checked" : ""}> alerts</label></span></div>`).join("")}
      <form class="app-row" id="invite"><input name="email" type="email" placeholder="person@example.com" required>
        <select name="role" class="app-select"><option value="viewer">viewer</option><option value="admin">admin</option>${canOwner ? "<option value=\"owner\">owner</option>" : ""}</select>
        <button class="app-btn small" type="submit">Invite</button></form>
      <div id="inviteOut"></div><div id="pending"></div></div>`;
  } else {
    html += `<p class="app-sub">Viewers can see all equipment and snooze alerts. Ask an owner or admin for changes.</p>`;
  }
  // Preserve an open <details> and any half-typed claim form.
  if (body.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  body.innerHTML = html;
  wireManage();
}

function wireManage() {
  const body = $("manageBody");
  const on = (sel, ev, fn) => body.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
  $("myAlerts")?.addEventListener("change", (e) => call("setMyAlerts", {orgId: S.orgId, enabled: e.target.checked}));
  if (!canAdmin()) return;
  $("addLoc").addEventListener("submit", async (e) => {
    e.preventDefault();
    await call("createLocation", {orgId: S.orgId, name: new FormData(e.target).get("name")});
    flash("Location added.");
  });
  on("[data-rename-loc]", "click", async (e) => {
    const id = e.target.dataset.renameLoc;
    const name = prompt("New name", S.locations[id].name);
    if (name) await call("updateLocation", {orgId: S.orgId, locationId: id, name});
  });
  $("claimHub").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await call("claimHub", {orgId: S.orgId, hubUid: f.get("hubUid"), claimCode: f.get("claimCode"),
      name: f.get("name") || undefined, locationId: f.get("locationId") || null});
    e.target.reset();
    showToken(r.hubUid, r.hubToken);
  });
  on("[data-hub-rotate]", "click", async (e) => {
    const id = e.target.dataset.hubRotate;
    if (!confirm(`Issue a new token for ${hubName(id)}? The hub stops uploading until you enter the new token in its Settings page.`)) return;
    const r = await call("rotateHubToken", {orgId: S.orgId, hubUid: id});
    showToken(id, r.hubToken);
  });
  on("[data-hub-revoke]", "click", async (e) => {
    const id = e.target.dataset.hubRevoke;
    if (!confirm(`Revoke ${hubName(id)}? Its uploads will be rejected immediately. You can issue a new token later.`)) return;
    await call("revokeHub", {orgId: S.orgId, hubUid: id});
    flash("Hub revoked.");
  });
  on("[data-hub-edit]", "click", async (e) => {
    const id = e.target.dataset.hubEdit;
    const name = prompt("Hub name", hubName(id));
    if (name === null) return;
    const locNames = Object.values(S.locations).map((l) => l.name).join(", ");
    const loc = prompt(`Location (one of: ${locNames || "none yet"}). Leave blank to keep.`, locName(S.hubs[id].locationId));
    const match = Object.values(S.locations).find((l) => l.name.toLowerCase() === String(loc || "").trim().toLowerCase());
    const data = {orgId: S.orgId, hubUid: id, name};
    if (match) data.locationId = match.id;
    await call("updateHub", data);
  });
  on("[data-role-for]", "change", async (e) => {
    await call("setMemberRole", {orgId: S.orgId, uid: e.target.dataset.roleFor, role: e.target.value});
    flash("Role updated.");
  });
  on("[data-remove]", "click", async (e) => {
    const uid = e.target.dataset.remove;
    const m = S.members.find((x) => x.uid === uid);
    if (!confirm(uid === S.user.uid ? "Leave this organization?" : `Remove ${m?.email}?`)) return;
    await call("removeMember", {orgId: S.orgId, uid});
  });
  on("[data-recipient]", "change", async () => {
    const uids = [...body.querySelectorAll("[data-recipient]")].filter((x) => x.checked).map((x) => x.dataset.recipient);
    await call("updateAlertSettings", {orgId: S.orgId, recipientUids: uids});
  });
  $("invite").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await call("createInvite", {orgId: S.orgId, email: f.get("email"), role: f.get("role")});
    e.target.reset();
    $("inviteOut").innerHTML = `<p class="app-hint">${r.emailed ? "Invitation emailed." : "Email could not be sent; share this link"}:
      <input readonly value="${esc(r.link)}" onclick="this.select()"></p>`;
    loadPending();
  });
  loadPending();
}

async function loadPending() {
  const el = $("pending");
  if (!el) return;
  try {
    const r = await fb.accountFn({action: "listPendingInvites", orgId: S.orgId});
    el.innerHTML = r.data.invites.length ? `<h4>Pending invitations</h4>` + r.data.invites.map((i) =>
      `<div class="row-item"><span>${esc(i.email)} <small>${esc(i.role)} · expires ${esc(fmtTime(i.expiresMs))}</small></span>
      <button class="app-btn small ghost" data-revoke-invite="${esc(i.inviteId)}" type="button">Revoke</button></div>`).join("") : "";
    el.querySelectorAll("[data-revoke-invite]").forEach((b) => b.addEventListener("click", async () => {
      await call("revokeInvite", {orgId: S.orgId, inviteId: b.dataset.revokeInvite});
      loadPending();
    }));
  } catch {
    el.innerHTML = "";
  }
}

function showToken(hubUid, token) {
  const el = $("tokenOut");
  el.innerHTML = `<div class="token-box"><b>Hub token for ${esc(hubUid)} — shown once</b>
    <p class="app-hint">Open the hub's local Control Center → Settings → Cloud token, paste this, and save. Don't email or text it.</p>
    <input readonly value="${esc(token)}" id="tokenField"><button class="app-btn small" type="button" id="copyToken">Copy</button></div>`;
  $("copyToken").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(token);
      flash("Token copied.");
    } catch {
      $("tokenField").select();
    }
  });
}

// ------------------------------------------------------------------ boot
async function main() {
  captureInvite();
  if (firebaseConfig.apiKey.startsWith("REPLACE_")) {
    show("authView");
    flash("Dashboard not configured yet: fill in app/firebase-config.js (see docs).", "error");
    $("authSubmit").disabled = true;
    return;
  }
  try {
    fb = await loadFirebase();
  } catch (e) {
    flash("Could not load sign-in. Check your connection and reload.", "error");
    return;
  }
  setAuthMode("signin");
  wireAuth();
  $("orgSelect").addEventListener("change", (e) => selectOrg(e.target.value));
  $("locFilter").addEventListener("change", (e) => {
    S.filter = {locationId: e.target.value, hubId: ""};
    render();
  });
  $("hubFilter").addEventListener("change", (e) => {
    S.filter.hubId = e.target.value;
    render();
  });
  $("ndClose").addEventListener("click", () => $("nodeDialog").close());
  $("nodeDialog").addEventListener("close", () => (S.dialogNode = null));
  document.querySelectorAll("#ndRanges [data-range]").forEach((b) => b.addEventListener("click", () => {
    S.range = b.dataset.range;
    renderDialog(true);
  }));
  // Keep "x min ago" honest without new reads.
  setInterval(() => S.orgId && !$("dashView").hidden && render(), 60000);
  fb.auth.onAuthStateChanged(fb.authInst, onUser);
}

main();
