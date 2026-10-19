// ReCore Sentinel customer dashboard (pilot).
// Reads come straight from Firestore and are limited by firestore.rules to the
// signed-in user's organizations. Every change goes through the `account`
// Cloud Function, which re-checks the user's role server-side.
import {firebaseConfig, FUNCTIONS_REGION, FIREBASE_SDK, USE_EMULATORS} from "./firebase-config.js";
import {
  hubCloudState, nodeState, displayName, timeAgo, filterNodes, sortNodes, RANGES, RANGE_LIMIT,
} from "./status.js";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>'"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"}[c]));
const RANK = {viewer: 1, admin: 2, owner: 3};

const S = {
  user: null, orgs: {}, orgId: null, role: null, org: null,
  hubs: {}, nodes: [], locations: {}, members: [], discovered: [],
  unsub: [], filter: {locationId: "", hubId: ""}, selected: null,
};
const OrgDash = window.OrgDash; // org-dashboard.js (hub gauges and charts)

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
  S.selected = null;
  OrgDash.reset();
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
    renderDiscovered();
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
    ["Equipment", S.nodes.length, "Registered devices"],
    ["Attention", counts.crit + counts.low, `${counts.crit} critical · ${counts.low} low`],
    ["No recent reading", counts.stale, "Past their expected report"],
    ["Hubs offline", counts.hubOff, `of ${Object.keys(S.hubs).length} hubs`],
  ].map(([k, v, e]) => `<div class="summaryCard"><span>${k}</span><b>${v}</b><em>${esc(e)}</em></div>`).join("");

  OrgDash.update(list.map((n) => {
    const st = nodeState(n, S.hubs, now);
    return {uid: n.id, name: displayName(n), location: locName(n.locationId), via: hubName(n.lastHubId || n.primaryHubId),
      hubCloud: st.hubCloud, latest: n.latest || null, measuredMs: st.measuredMs, rev: st.measuredMs,
      expectedIntervalMin: n.expectedIntervalMin || null};
  }), S.nodes.length ? "Nothing matches these filters." : "No equipment has reported yet.");
  renderNodeActions();
}

function renderDiscovered() {
  const el = $("discovered");
  // A device that is already registered (e.g. assigned after it was first heard) is not listed.
  const registered = new Set(S.nodes.map((n) => n.id));
  const list = S.discovered.filter((d) => !registered.has(d.id));
  if (!list.length || !canAdmin()) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<h2 class="dash-h2">Heard but not registered</h2><p class="app-sub">Your hubs heard these devices, but they are not registered to this organization. Add only equipment you own.</p>` +
    list.map((d) => `<div class="row-item"><span><b>${esc(d.hubName || d.id)}</b> <code>${esc(d.id)}</code> via ${esc(hubName(d.lastHubId))}, ${esc(timeAgo(d.lastHeardAt?.toMillis?.(), Date.now()))}</span>
      <button class="app-btn small" data-adopt="${esc(d.id)}" type="button">Add to my equipment</button></div>`).join("");
  el.querySelectorAll("[data-adopt]").forEach((b) => b.addEventListener("click", async () => {
    await call("adoptDiscoveredNode", {orgId: S.orgId, deviceUid: b.dataset.adopt});
    flash("Added. Its next reading will appear on the dashboard.");
  }));
}

// ------------------------------------------------------------ readings
function readingFromDoc(d) {
  const t = typeof d.measuredMs === "number" ? d.measuredMs : (d.measuredAt && d.measuredAt.toMillis ? d.measuredAt.toMillis() : NaN);
  if (!Number.isFinite(t) || typeof d.voltage !== "number") return null;
  const codes = {0: "OK", 1: "LOW", 2: "CRITICAL"};
  const status = Number.isInteger(d.statusCode) && codes[d.statusCode] ? codes[d.statusCode] :
    (d.status === "LOW" || d.status === "CRITICAL" ? d.status : "OK");
  const onboard = d.internalTemperatureF !== undefined ? d.internalTemperatureF : d.temperatureF;
  return {t, volts: d.voltage, tempF: typeof onboard === "number" ? onboard : null,
    probeF: typeof d.externalTemperatureF === "number" ? d.externalTemperatureF : null,
    rssi: Number.isInteger(d.rssi) ? d.rssi : null, sequence: Number.isInteger(d.sequence) ? d.sequence : 0, status};
}

// range "recent": the newest 96 (only those after sinceMs); otherwise the window, newest first up to a cap.
async function loadReadings(uid, range, sinceMs) {
  const {fs, db} = fb;
  const col = fs.collection(db, "orgs", S.orgId, "nodes", uid, "readings");
  let q;
  if (range === "recent") {
    q = sinceMs ?
      fs.query(col, fs.where("measuredMs", ">", sinceMs), fs.orderBy("measuredMs", "desc"), fs.limit(96)) :
      fs.query(col, fs.orderBy("measuredMs", "desc"), fs.limit(96));
  } else {
    q = fs.query(col, fs.where("measuredMs", ">=", Date.now() - RANGES[range]), fs.orderBy("measuredMs", "desc"),
        fs.limit(RANGE_LIMIT[range]));
  }
  const snap = await fs.getDocs(q);
  const readings = snap.docs.map((d) => readingFromDoc(d.data())).filter(Boolean).reverse();
  return {readings, capped: range !== "recent" && snap.docs.length >= RANGE_LIMIT[range]};
}

function renderNodeActions() {
  const n = S.nodes.find((x) => x.id === (S.selected || OrgDash.selectedUid()));
  if (!n) {
    $("nodeActions").innerHTML = "";
    return;
  }
  // Keep a half-typed settings form.
  if ($("nodeActions").contains(document.activeElement) && document.activeElement.tagName === "INPUT" &&
    $("nodeActions").dataset.uid === n.id) return;
  $("nodeActions").dataset.uid = n.id;
  const now = Date.now();
  const snoozedUntil = n.alert && n.alert.snoozeUntilMs > now ? n.alert.snoozeUntilMs : 0;
  let html = `<div class="nd-section"><h3>${esc(displayName(n))} · alerts</h3><p class="app-sub">${snoozedUntil ? `Snoozed until ${esc(fmtTime(snoozedUntil))}.` :
    (n.alert && n.alert.enabled === false ? "Alerts are off for this device." : "Alerts are on.")}</p>
    <div class="app-row">${[1, 3, 7].map((d) => `<button class="app-btn small ghost" data-snooze="${d}" type="button">Snooze ${d} d</button>`).join("")}
    ${snoozedUntil ? `<button class="app-btn small ghost" data-snooze="0" type="button">Resume</button>` : ""}</div></div>`;
  if (canAdmin()) {
    const locs = Object.values(S.locations).map((l) => `<option value="${esc(l.id)}" ${l.id === n.locationId ? "selected" : ""}>${esc(l.name)}</option>`).join("");
    const hubs = Object.values(S.hubs).map((h) => `<option value="${esc(h.id)}" ${h.id === n.primaryHubId ? "selected" : ""}>${esc(h.name || h.id)}</option>`).join("");
    html += `<form class="nd-section app-form" id="nodeEdit"><h3>${esc(displayName(n))} · settings</h3>
      <label>Name <input name="name" maxlength="40" value="${esc(n.name || "")}" placeholder="${esc(n.hubName || n.id)}"></label>
      <label>Location <select name="locationId" class="app-select"><option value="">No location</option>${locs}</select></label>
      <label>Primary hub (commands and updates) <select name="primaryHubId" class="app-select">${hubs}</select></label>
      <label>Expected reporting interval (minutes) <input name="interval" type="number" min="1" max="1440" value="${esc(n.expectedIntervalMin || 60)}"></label>
      <label class="check"><input type="checkbox" name="alerts" ${n.alert && n.alert.enabled === false ? "" : "checked"}> Send alerts for this device</label>
      <p class="app-hint">Sampling mode, expected voltage and calibration are changed on the hub's local Control Center; the cloud does not send radio commands yet.</p>
      <button class="app-btn" type="submit">Save</button></form>`;
  }
  $("nodeActions").innerHTML = html;
  $("nodeActions").querySelectorAll("[data-snooze]").forEach((b) => b.addEventListener("click", async () => {
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
  OrgDash.configure({loader: loadReadings, onSelect: (uid) => {
    S.selected = uid;
    renderNodeActions();
  }});
  // Keep "x min ago" honest without new reads.
  setInterval(() => S.orgId && !$("dashView").hidden && OrgDash.tick(), 15000);
  fb.auth.onAuthStateChanged(fb.authInst, onUser);
}

main();
