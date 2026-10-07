// Cloudflare Worker: handles /api/slots, /api/claim, /api/release; everything else is served from ./public
// Storage: D1 (binding "DB"). Optional secret: ADMIN_KEY.

const FOUR = ["Graphics & Slides","Lyrics & Sermon","Lights","Internal Livestream & Translations"];
const mk=(names,times)=>names.map(n=>({n,t:times}));
const day=(d,roles)=>({d,roles});
// A Sunday at Putra/PJ: all four roles at 9 AM and 11 AM. A GPN: all four roles at 6 PM.
const sunday=d=>day(d+" (Sunday)",mk(FOUR,["9 AM","11 AM"]));
const gpn=d=>day(d+" (GPN)",mk(FOUR,["6 PM"]));
const GROUPS=[
 {title:"Subang",days:[
  day("21st October (GPN)",mk(["Lights"],["6 PM"])),
  day("25th October (Sunday)",mk(["Lyrics","Sermon","Lyrics (Side Screens)","Lights"],["5 PM"]))]},
 {title:"Mandarin",days:[
  day("11th October (Sunday)",mk(["Lyrics","Sermon","Lights"],["2 PM"])),
  day("18th October (Sunday)",mk(["Lyrics","Sermon","Lights"],["2 PM"])),
  day("21st October (GPN)",mk(["Lyrics & Sermon","Lights"],["6 PM"])),
  day("25th October (Sunday)",mk(["Lyrics","Sermon","Lights"],["2 PM"]))]},
 {title:"Putra",days:[sunday("11th October"),sunday("18th October"),gpn("21st October"),sunday("25th October")]},
 {title:"PJ",days:[sunday("11th October"),sunday("18th October"),gpn("21st October"),sunday("25th October")]}
];
const sid = (d, g, r, t) => [d.replace(/\s*\(.*\)\s*$/, ""), g, r, t].join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
const IDS = new Set(GROUPS.flatMap(g => g.days.flatMap(x => x.roles.flatMap(r => r.t.map(t => sid(x.d, g.title, r.n, t))))));

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

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
        return res.meta.changes === 0 ? json({ error: "taken" }, 409) : json({ ok: true });
      }

      // release
      const existing = await db.prepare("SELECT token FROM claims WHERE id = ?1").bind(id).first();
      if (!existing) return json({ ok: true });
      const isAdmin = !!env.ADMIN_KEY && body.adminKey === env.ADMIN_KEY;
      if (existing.token !== token && !isAdmin) return json({ error: "forbidden" }, 403);
      await db.prepare("DELETE FROM claims WHERE id = ?1").bind(id).run();
      return json({ ok: true });
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
