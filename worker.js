// Cloudflare Worker: handles /api/slots, /api/claim, /api/release and /api/admin; everything else is served from ./public
// Storage: D1 (binding "DB"). Optional secret: ADMIN_KEY.

const FOUR=["Mac 1 Graphics & Slides","Mac 2 Lyrics & Sermon","Lights","Internal Livestream & Translations"];
const mk=(names,times)=>names.map(n=>({n,t:times}));
const day=(d,roles)=>({d,roles});
// Putra/PJ: all four roles at 9 AM and 11 AM
const std=d=>day(d,mk(FOUR,["9 AM","11 AM"]));
const GROUPS=[
 {title:"Subang",days:["1st November","15th November"].map(d=>day(d,mk(["Lyrics","Sermon","Lyrics (Side Screens)","Lights"],["5 PM"])))},
 {title:"Mandarin",days:["1st November","8th November","15th November"].map(d=>day(d,mk(["Lyrics","Sermon","Lights"],["2 PM"])))},
 {title:"Putra",days:["1st November","8th November","15th November","22nd November"].map(std)},
 {title:"PJ",days:["1st November","8th November","22nd November"].map(std)}
];
const sid = (d, g, r, t) => [d.replace(/\s*\(.*\)\s*$/, ""), g, r, t].join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
const IDS = new Set(GROUPS.flatMap(g => g.days.flatMap(x => x.roles.flatMap(r => r.t.map(t => sid(x.d, g.title, r.n, t))))));

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Activity log. The table is created automatically the first time it is needed.
let logReady = false;
async function ensureLog(db) {
  if (logReady) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, slot TEXT, name TEXT, actor TEXT NOT NULL)").run();
  logReady = true;
}
async function addLog(db, action, slot, name, actor) {
  try { // logging must never break a sign-up
    await ensureLog(db);
    await db.prepare("INSERT INTO log (at, action, slot, name, actor) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(new Date().toISOString(), action, slot, name, actor).run();
  } catch (e) {}
}
const isAdminKey = (env, k) => !!env.ADMIN_KEY && typeof k === "string" && k === env.ADMIN_KEY;
const idsFor = (date, campus) => GROUPS
  .filter(g => !campus || g.title === campus)
  .flatMap(g => g.days.filter(x => x.d === date).flatMap(x => x.roles.flatMap(r => r.t.map(t => sid(x.d, g.title, r.n, t)))));

async function handleApi(request, env) {
  try {
    const db = env.DB;
    if (!db) return json({ error: "no_database_binding" }, 500);

    const route = new URL(request.url).pathname.replace(/^\/api\/?/, "");
    const token = request.headers.get("x-token") || "";
    if (request.method === "GET" && route === "admin-check") return json({ adminKeySet: !!env.ADMIN_KEY });

    if (request.method === "GET" && route === "slots") {
      const { results } = await db.prepare("SELECT id, name, token FROM claims").all();
      const claims = {};
      for (const c of results) {
        if (IDS.has(c.id)) claims[c.id] = { name: c.name, mine: token.length >= 16 && c.token === token };
      }
      return json({ claims });
    }

    if (request.method === "POST" && (route === "claim" || route === "release")) {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
      const id = body && body.id;
      if (!IDS.has(id)) return json({ error: "unknown_slot" }, 400);

      if (route === "claim") {
        const name = String(body.name || "").trim().slice(0, 40);
        if (!name || token.length < 16) return json({ error: "bad_request" }, 400);
        // id is the PRIMARY KEY: INSERT OR IGNORE is atomic, so only the first writer changes a row.
        const res = await db
          .prepare("INSERT OR IGNORE INTO claims (id, name, token, at) VALUES (?1, ?2, ?3, ?4)")
          .bind(id, name, token, new Date().toISOString())
          .run();
        if (res.meta.changes === 0) return json({ error: "taken" }, 409);
        await addLog(db, "claim", id, name, "volunteer");
        return json({ ok: true });
      }

      // release
      const existing = await db.prepare("SELECT name, token FROM claims WHERE id = ?1").bind(id).first();
      if (!existing) return json({ ok: true });
      const isAdmin = isAdminKey(env, body.adminKey);
      if (existing.token !== token && !isAdmin) return json({ error: "forbidden" }, 403);
      await db.prepare("DELETE FROM claims WHERE id = ?1").bind(id).run();
      await addLog(db, "release", id, existing.name, isAdmin ? "admin" : "volunteer");
      return json({ ok: true });
    }

    // ---- admin actions: every one needs the ADMIN_KEY ----
    if (request.method === "POST" && route === "admin") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
      if (!isAdminKey(env, body && body.adminKey)) return json({ error: "forbidden" }, 403);
      const name = String(body.name || "").trim().slice(0, 40);

      if (body.action === "activity") {
        await ensureLog(db);
        const { results } = await db.prepare("SELECT at, action, slot, name, actor FROM log ORDER BY id DESC LIMIT 300").all();
        return json({ log: results });
      }
      if (body.action === "book") {
        if (!IDS.has(body.id) || !name) return json({ error: "bad_request" }, 400);
        const res = await db
          .prepare("INSERT OR IGNORE INTO claims (id, name, token, at) VALUES (?1, ?2, ?3, ?4)")
          .bind(body.id, name, "admin-booked-slot", new Date().toISOString())
          .run();
        if (res.meta.changes === 0) return json({ error: "taken" }, 409);
        await addLog(db, "book", body.id, name, "admin");
        return json({ ok: true });
      }
      if (body.action === "rename") {
        if (!IDS.has(body.id) || !name) return json({ error: "bad_request" }, 400);
        const old = await db.prepare("SELECT name FROM claims WHERE id = ?1").bind(body.id).first();
        if (!old) return json({ error: "not_found" }, 404);
        await db.prepare("UPDATE claims SET name = ?2 WHERE id = ?1").bind(body.id, name).run();
        await addLog(db, "rename", body.id, old.name + " -> " + name, "admin");
        return json({ ok: true });
      }
      if (body.action === "releaseMany") {
        const date = String(body.date || "");
        const campus = body.campus ? String(body.campus) : "";
        const ids = idsFor(date, campus);
        if (!ids.length) return json({ error: "bad_request" }, 400);
        let released = 0;
        for (const id of ids) {
          const row = await db.prepare("SELECT name FROM claims WHERE id = ?1").bind(id).first();
          if (!row) continue;
          await db.prepare("DELETE FROM claims WHERE id = ?1").bind(id).run();
          await addLog(db, "release", id, row.name, "admin");
          released++;
        }
        return json({ ok: true, released });
      }
      return json({ error: "bad_request" }, 400);
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    return json({ error: "server_error" }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request); // fallback; normally static files bypass the Worker
  },
};
