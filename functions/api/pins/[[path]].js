// Connector Pin Tracker API (Cloudflare Pages Function + D1).
//
// Routes (all require the X-Pin-Key header to match the PIN_PASSCODE secret):
//   GET    /api/pins/plugs        -> { plugs: { <id>: <plug doc> } }
//   PUT    /api/pins/plugs/:id    -> create a plug (fails if the id exists)
//   PATCH  /api/pins/plugs/:id    -> deep-merge a partial update into a plug
//   DELETE /api/pins/plugs/:id    -> remove a plug
//
// Bindings (set in the Pages project settings, not in code):
//   DB            D1 database "pin-tracker"
//   PIN_PASSCODE  secret shared passcode
//
// Each plug is one row with its pins stored as JSON, so loading the page is a
// single query and each save is one read + one write.

const MAX_BODY = 256 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function sameKey(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function deepMerge(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const v = b[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("too_large");
  const body = JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad_body");
  return body;
}

export async function onRequest({ request, env, params }) {
  if (!env.DB || !env.PIN_PASSCODE) {
    return json({ error: "Pin tracker storage isn't set up on this site yet." }, 503);
  }
  const key = request.headers.get("x-pin-key") || "";
  if (!sameKey(key, env.PIN_PASSCODE)) {
    return json({ error: "Wrong passcode." }, 401);
  }

  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  if (parts[0] !== "plugs" || parts.length > 2) return json({ error: "Not found." }, 404);
  const id = parts[1];
  const method = request.method;

  try {
    if (!id) {
      if (method !== "GET") return json({ error: "Method not allowed." }, 405);
      const { results } = await env.DB.prepare("SELECT id, data FROM plugs").all();
      const plugs = {};
      for (const r of results) plugs[r.id] = JSON.parse(r.data);
      return json({ plugs });
    }

    if (!ID_RE.test(id)) return json({ error: "Bad plug id." }, 400);

    if (method === "PUT") {
      const doc = await readBody(request);
      const now = Date.now();
      doc.updated = now;
      const res = await env.DB.prepare(
        "INSERT INTO plugs (id, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING"
      ).bind(id, JSON.stringify(doc), now).run();
      if (!res.meta.changes) return json({ error: "A plug with that id already exists." }, 409);
      return json({ ok: true, plug: doc });
    }

    if (method === "PATCH") {
      const patch = await readBody(request);
      const row = await env.DB.prepare("SELECT data FROM plugs WHERE id = ?1").bind(id).first();
      if (!row) return json({ error: "That plug no longer exists." }, 404);
      const merged = deepMerge(JSON.parse(row.data), patch);
      merged.updated = Date.now();
      const text = JSON.stringify(merged);
      if (text.length > MAX_BODY) return json({ error: "Plug data is too large." }, 413);
      await env.DB.prepare("UPDATE plugs SET data = ?2, updated = ?3 WHERE id = ?1")
        .bind(id, text, merged.updated).run();
      return json({ ok: true, updated: merged.updated });
    }

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM plugs WHERE id = ?1").bind(id).run();
      return json({ ok: true });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg === "too_large") return json({ error: "Request is too large." }, 413);
    if (msg === "bad_body" || e instanceof SyntaxError) return json({ error: "Request body must be a JSON object." }, 400);
    if (/limit/i.test(msg)) return json({ error: "Daily free-tier limit reached. It resets at midnight UTC (8 PM Eastern in summer, 7 PM in winter)." }, 429);
    return json({ error: "Storage error. Try again in a moment." }, 500);
  }
}
