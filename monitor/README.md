# Sentinel Monitor (`/monitor/`)

Read-only, installable phone app for ReCore Sentinel. It shows battery condition, node
reporting health, hub connectivity and the app's own connection to the cloud, kept as
four separate things. The customer dashboard (`/app/`) and the public Control Center
(`control-center.html`) are unchanged.

Live URL after deploy: `https://recoretechnology.com/monitor/`. On iPhone, open it in
Safari, tap Share, then **Add to Home Screen**.

## How it works

```
PowerNode ─LoRa─▶ Hub (0.9.0-lora-ota) ─HTTPS─▶ ingestReading / hubIngest ─▶ Firestore orgs/{org}/…
                                                         (unchanged)          ▲
iPhone (Safari / home-screen app) ─ Firebase Auth (email+password) ─ reads ───┘  firestore.rules: members only
```

- **No new infrastructure.** It uses the same Firebase project (`sentinel-74f28`), the same
  sign-in, the same Firestore rules and the same Cloudflare Pages site as `/app/`. It never
  talks to the hub, so there's no port forwarding and no firmware change.
- **Authorization is enforced by the database.** `firestore.rules` allow reads only by
  members of the organization with a verified email, and allow no writes from browsers.
  The app makes no writes and calls no functions. Hiding parts of the page is never what
  keeps data private.
- **No secrets in the browser.** `../app/firebase-config.js` holds only Firebase's public
  web identifiers. The hub ingest key, Brevo key and OTA key stay server-side or on the hub.
- **Identity:** records are keyed by the node's permanent 12-hex hardware UID (`deviceUid`),
  never by its radio address.

### Status rules (`status.js`, unit-tested)

| Question | Source | Rule |
|---|---|---|
| Battery condition | node's `latest.statusCode` / `status` | CRITICAL / LOW / OK. Once the node is offline, this shows as "last known". |
| Node reporting | `lastMeasuredMs` (measurement time, not upload time) | Late after 1.5 × interval + 30 s; offline after max(3 × interval + 60 s, 15 min). These are the hub's own thresholds (`config.h`). An hourly node is late after about 91 min and offline after about 3 h. |
| Reporting interval | the device's "expected interval" set in `/app/`, else inferred from the median gap between reports, else hourly | The detail page shows which of the three was used. The hub doesn't upload the mode. |
| Hub connectivity | hub `lastSeenAt` (last upload) | Hubs only upload when they hear a node. A hub counts as "no uploads" after the offline time of its fastest node. |
| Why a node is quiet | comparison with the hub and the other nodes on it | **Node:** the hub uploaded after the node was due. **Hub:** every node on that hub is overdue and the hub is silent, so the hub, its Wi-Fi or its internet is the likely cause. **Unknown:** there's nothing to compare against, and the app says so. |
| App data freshness | Firestore listener metadata + `navigator.onLine` | The banner shows Connected / Paused / No connection / Error, with the time of the last update received. When disconnected, readings are dimmed and labelled "may be out of date". |
| Charge % | resting-voltage table identical to the hub gauges (a test checks this) | Always shown as "est.". No % is shown while charging (≥ 13.0 V on a 12 V system) or for 5 V supplies. |

### Data use and cost

- Realtime listeners on the org's `nodes`, `hubs` and `locations` docs: each changed doc
  costs one read.
- List sparklines: up to 60 newest readings per node within 24 h, fetched once. After that
  only newer readings are fetched, and only when that node's latest measurement changes.
  At most 3 requests run at a time, and a node never has two requests running at once.
- Detail history is capped at 300 / 1,200 / 2,000 readings for 24 h / 7 d / 30 d, cached in
  memory for 10 minutes.
- When the app is hidden (another app, or the phone locked), all listeners stop. They resume
  when it's visible again.

Rough reads for 9 hourly nodes: about 230 per cold open and about 20 per resume, plus 2 per
new reading while the app is open. A 30-day detail view adds about 720. Ten opens a day is
roughly 3,000–5,000 reads, against Firestore's free 50,000/day.
**Expected added cost: $0/month.** Cloudflare Pages and Firebase email/password Auth are free
at this scale.

### Offline and privacy

- `sw.js` caches **only the app shell**: the files listed in it plus the pinned Firebase SDK.
  Firestore, Auth and Functions requests are never intercepted or cached.
- Firestore uses its default **memory-only** cache, so readings are never written to the
  phone's storage.
- Opening the app offline shows "no readings are stored on this device" rather than old data.
- Sign-out stops the listeners, drops all in-memory data, forgets the selected organization
  and reloads the page.
- Only per-viewer conveniences are kept in `localStorage`: the List/Gauges choice, the
  property selection and the organization ID.
- Firebase Auth keeps the session in IndexedDB so the home-screen app stays signed in. Sign
  out on shared phones.

### Map

Not included. Pin locations exist only on the hub's local page (`map_store.h`) and are never
uploaded, so there's no location data in the cloud to draw from. A map can be added once
locations are stored in the cloud (for example, an optional `lat`/`lng` on each location or
node, set from `/app/`).

## Files

```
monitor/index.html, monitor.css     shell and styles (reuses ../css/styles.css, ../css/hub-dashboard.css)
monitor/monitor.js                  auth, listeners, rendering, history
monitor/status.js                   pure status logic (tested)
monitor/chart.js                    sparkline + line charts (one unit per chart, crosshair tooltip, keyboard)
monitor/sw.js, manifest.webmanifest, icons/   PWA
../js/hub-dashboard-core.js, ../app/org-dashboard.js   reused unchanged for the Gauges view
_headers                            /monitor/* security headers + CSP
tests/monitor-status.test.mjs       unit tests
```

## Tests

```sh
node --test tests/monitor-status.test.mjs tests/app-status.test.mjs     # 23 unit tests
# Browser end-to-end (62 checks: phone 390 px and 320 px, desktop) against the real account and
# ingest code and the rules logic, served with the production CSP:
cd ../recore-cloud-functions
WEB_DIR=../Recore-Website python3 e2e/run_monitor_e2e.py              # screenshots in e2e/shots-monitor/
```

The browser tests cover:
- **Sign-in and access:** wrong password; unverified email; a user with no organization;
  neighbor isolation in the UI and at the rules layer; a deep link to another organization's
  device; the organization switch.
- **Status:** summary counts and filters; property selector and overview; hub outage versus
  node outage; last-known battery.
- **Edge cases:** missing sensors; a single reading; empty history; long names; no horizontal
  scroll at 320 px.
- **Network:** slow connection; failed history request; going offline while open; offline
  cold start from cache.
- **Background and caching:** no requests while hidden; requests bounded with no overlap;
  only the app shell in the service-worker cache.
- **Sign-out:** nothing left behind.
- **Other:** the Gauges view, the manifest and icons, and no CSP violations.

## Deploy (Cloudflare Pages; no build step, nothing to configure)

1. Commit on a branch and push it. Cloudflare builds a preview at
   `https://<branch>.recore-website.pages.dev/monitor/`.
2. **Sign-in on a preview needs its domain authorized.** Use the branch name
   `customer-accounts`, whose preview domain is already authorized, or add the new preview
   domain in Firebase → Authentication → Settings → Authorized domains. If the Browser API key
   has HTTP-referrer restrictions (Google Cloud → Credentials), add
   `https://<branch>.recore-website.pages.dev/*` there too.
3. Check it on the iPhone over cellular: sign in, Add to Home Screen, open from the icon.
4. Merge to `main`. Pages deploys `recoretechnology.com/monitor/`. `recoretechnology.com` is
   already an authorized domain.

**Rollback:** Cloudflare Pages → Deployments → previous deployment → Rollback, or revert the
commit. Nothing in Firebase changes, so there's nothing to roll back there.
**Updates:** bump `VERSION` in `sw.js` and the `?v=` strings in `index.html` when shell files
change. The service worker fetches the network first, so online users get changes on their
next open.

## Limitations

- Shows only nodes registered to the organization. Nodes added after the Oct 19 migration
  through the legacy (shared-key) upload aren't copied into the organization until they're
  added in `/app/` (Heard but not registered → Add) or migrated with the admin CLI.
- The reporting mode isn't uploaded by the hub. It's inferred unless an expected interval is
  set per device in `/app/`. Setting it makes late and offline exact.
- Hub health is inferred from uploads. The hub sends no heartbeat, so a hub with no nodes in
  range looks the same as a hub that's offline.
- Out of scope: commissioning, configuration, firmware, push notifications, iOS widgets.
