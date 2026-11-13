// Cloudflare Worker: sign-up API and session management.
// Routes: /api/slots, /api/claim, /api/release, /api/admin. Everything else is served from ./public
// Storage: D1 (binding "DB"). Optional secret: ADMIN_KEY.
// The list of sessions (campus / date / role / time) lives in the database and is managed from /admin.html.

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Slot id. The pages and the worker build ids the same way. A "(Sunday)" or "(GPN)" note on the date is ignored.
const sid = (d, g, r, t) => [d.replace(/\s*\(.*\)\s*$/, ""), g, r, t].join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");

// ---------- the sessions you start with (November 2026); after the first run, edit them on the admin page ----------
const FOUR = ["Mac 1 Graphics & Slides", "Mac 2 Lyrics & Sermon", "Lights", "Internal Livestream & Translations"];
const SEED = [
  ["Subang", ["Lyrics", "Sermon", "Lyrics (Side Screens)", "Lights"], ["5 PM"], ["1st November", "15th November"]],
  ["Mandarin", ["Lyrics", "Sermon", "Lights"], ["2 PM"], ["1st November", "8th November", "15th November"]],
  ["Putra", FOUR, ["9 AM", "11 AM"], ["1st November", "8th November", "15th November", "22nd November"]],
  ["PJ", FOUR, ["9 AM", "11 AM"], ["1st November", "8th November", "22nd November"]],
];
function seedRows() {
  const rows = [];
  for (const [campus, roles, times, dates] of SEED)
    for (const date of dates)
      for (const role of roles)
        for (const time of times) {
          const day = "2026-11-" + String(parseInt(date, 10)).padStart(2, "0");
          rows.push({ id: sid(date, campus, role, time), campus, date, day, role, time });
        }
  return rows;
}

// ---------- small SQL helpers (D1 allows 100 bound values per query, so work is split into chunks) ----------
const chunks = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const marks = (n) => Array(n).fill("?").join(",");
const insertSlots = (db, rows) =>
  chunks(rows, 15).map((p) =>
    db.prepare("INSERT OR IGNORE INTO slots (id, campus, date, day, role, time) VALUES " + p.map(() => "(?,?,?,?,?,?)").join(","))
      .bind(...p.flatMap((r) => [r.id, r.campus, r.date, r.day, r.role, r.time])));
const deleteIds = (db, table, ids) =>
  chunks(ids, 90).map((p) => db.prepare("DELETE FROM " + table + " WHERE id IN (" + marks(p.length) + ")").bind(...p));
const insertLog = (db, entries) =>
  chunks(entries, 15).map((p) =>
    db.prepare("INSERT INTO log (at, action, slot, name, actor) VALUES " + p.map(() => "(?,?,?,?,?)").join(","))
      .bind(...p.flatMap((e) => [e.at, e.action, e.slot, e.name, e.actor])));
const bumpVersion = (db) =>
  db.prepare("INSERT INTO meta (k, v) VALUES ('slots_version', '2') ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)");
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

// ---------- tables: created automatically, so no SQL needs to be run by hand ----------
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL, at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, slot TEXT, name TEXT, actor TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, campus TEXT NOT NULL, date TEXT NOT NULL, day TEXT NOT NULL, role TEXT NOT NULL, time TEXT NOT NULL DEFAULT '')"),
    db.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
  ]);
  const seeded = await db.prepare("SELECT v FROM meta WHERE k = 'seeded'").first();
  if (!seeded) {
    await db.batch([
      ...insertSlots(db, seedRows()),
      db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('seeded', '1')"),
      db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('slots_version', '1')"),
    ]);
  }
  schemaReady = true;
}

async function addLog(db, action, slot, name, actor) {
  try { // logging must never break a sign-up
    await db.prepare("INSERT INTO log (at, action, slot, name, actor) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(new Date().toISOString(), action, slot, name, actor).run();
  } catch (e) {}
}
const isAdminKey = (env, k) => !!env.ADMIN_KEY && typeof k === "string" && k === env.ADMIN_KEY;
const slotExists = async (db, id) => typeof id === "string" && !!(await db.prepare("SELECT 1 AS x FROM slots WHERE id = ?1").bind(id).first());

// ---------- checking slot data sent from the admin page ----------
function cleanSlots(list) {
  if (!Array.isArray(list) || list.length > 600) return { error: "bad_list" };
  const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  const seen = new Set(), rows = [];
  for (const x of list) {
    if (!x || typeof x !== "object") return { error: "bad_slot" };
    const campus = clean(x.campus), date = clean(x.date), role = clean(x.role), time = clean(x.time), day = clean(x.day);
    if (!campus || !date || !role || campus.length > 40 || date.length > 40 || role.length > 60 || time.length > 12) return { error: "bad_slot", bad: x };
    const d = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + "T00:00:00Z") : null;
    if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== day) return { error: "bad_slot", bad: x };
    const id = sid(date, campus, role, time);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, campus, date, day, role, time });
  }
  return { rows };
}

async function handleApi(request, env) {
  try {
    const db = env.DB;
    if (!db) return json({ error: "no_database_binding" }, 500);
    await ensureSchema(db);

    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/?/, "");
    const token = request.headers.get("x-token") || "";
    if (request.method === "GET" && route === "admin-check") return json({ adminKeySet: !!env.ADMIN_KEY });

    // Everything the pages need: who holds which slot, plus the session list (only sent when it has changed).
    if (request.method === "GET" && route === "slots") {
      const vRow = await db.prepare("SELECT v FROM meta WHERE k = 'slots_version'").first();
      const v = vRow ? String(vRow.v) : "1";
      const { results } = await db.prepare("SELECT c.id, c.name, c.token FROM claims c JOIN slots s ON s.id = c.id").all();
      const claims = {};
      for (const c of results) claims[c.id] = { name: c.name, mine: token.length >= 16 && c.token === token };
      const oRow = await db.prepare("SELECT v FROM meta WHERE k = 'options'").first();
      let options = null;
      try { options = oRow ? JSON.parse(oRow.v) : null; } catch (e) {}
      const out = { v, claims, options };
      if (url.searchParams.get("v") !== v) {
        out.slots = (await db.prepare("SELECT id, campus, date, day, role, time, rowid AS n FROM slots ORDER BY day, rowid").all()).results;
      }
      return json(out);
    }

    if (request.method === "POST" && (route === "claim" || route === "release")) {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
      const id = body && body.id;
      if (!(await slotExists(db, id))) return json({ error: "unknown_slot" }, 400);

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
      const at = new Date().toISOString();

      if (body.action === "activity") {
        const { results } = await db.prepare("SELECT at, action, slot, name, actor FROM log ORDER BY id DESC LIMIT 300").all();
        return json({ log: results });
      }
      if (body.action === "book") {
        if (!(await slotExists(db, body.id)) || !name) return json({ error: "bad_request" }, 400);
        const res = await db
          .prepare("INSERT OR IGNORE INTO claims (id, name, token, at) VALUES (?1, ?2, ?3, ?4)")
          .bind(body.id, name, "admin-booked-slot", at)
          .run();
        if (res.meta.changes === 0) return json({ error: "taken" }, 409);
        await addLog(db, "book", body.id, name, "admin");
        return json({ ok: true });
      }
      if (body.action === "rename") {
        if (!(await slotExists(db, body.id)) || !name) return json({ error: "bad_request" }, 400);
        const old = await db.prepare("SELECT name FROM claims WHERE id = ?1").bind(body.id).first();
        if (!old) return json({ error: "not_found" }, 404);
        await db.prepare("UPDATE claims SET name = ?2 WHERE id = ?1").bind(body.id, name).run();
        await addLog(db, "rename", body.id, old.name + " -> " + name, "admin");
        return json({ ok: true });
      }
      if (body.action === "releaseMany") {
        const date = String(body.date || "");
        const campus = body.campus ? String(body.campus) : "";
        const any = await db.prepare("SELECT 1 AS x FROM slots WHERE date = ?1 AND (?2 = '' OR campus = ?2) LIMIT 1").bind(date, campus).first();
        if (!any) return json({ error: "bad_request" }, 400);
        const rows = (await db.prepare(
          "SELECT c.id, c.name FROM claims c JOIN slots s ON s.id = c.id WHERE s.date = ?1 AND (?2 = '' OR s.campus = ?2)"
        ).bind(date, campus).all()).results;
        const stmts = [
          ...deleteIds(db, "claims", rows.map((r) => r.id)),
          ...insertLog(db, rows.map((r) => ({ at, action: "release", slot: r.id, name: r.name, actor: "admin" }))),
        ];
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true, released: rows.length });
      }

      // The menus used by the admin page: campuses, times and roles.
      if (body.action === "setOptions") {
        const o = body.options || {};
        const lim = { campuses: 40, times: 12, roles: 60 };
        const out = {};
        for (const k of Object.keys(lim)) {
          if (!Array.isArray(o[k]) || o[k].length > 100) return json({ error: "bad_options" }, 400);
          const seen = new Set(), list = [];
          for (const x of o[k]) {
            const v = String(x == null ? "" : x).replace(/\s+/g, " ").trim();
            if (!v || v.length > lim[k]) return json({ error: "bad_options" }, 400);
            if (!seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); list.push(v); }
          }
          out[k] = list;
        }
        const tidy = (m, keys, max) => { const r = {}; if (m && typeof m === "object") for (const k of keys) { const v = m[k]; if (typeof v === "string" && v.trim() && v.trim().length <= max) r[k] = v.trim(); } return r; };
        out.codes = tidy(o.codes, out.campuses, 6);
        out.cats = tidy(o.cats, out.roles, 20);
        await db.batch([
          db.prepare("INSERT INTO meta (k, v) VALUES ('options', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(out)),
          ...insertLog(db, [{ at, action: "config", slot: null, name: "Updated the lists of campuses, times and roles", actor: "admin" }]),
        ]);
        return json({ ok: true, options: out });
      }

      // Add sessions to the list, or replace the whole list. Sign-ups on slots that stay are kept.
      if (body.action === "setSessions") {
        const mode = body.mode;
        if (mode !== "add" && mode !== "replace") return json({ error: "bad_request" }, 400);
        const { rows, error, bad } = cleanSlots(body.slots);
        if (error) return json({ error, bad }, 400);
        if (!rows.length) return json({ error: "empty_list" }, 400);
        const existing = new Set((await db.prepare("SELECT id FROM slots").all()).results.map((r) => r.id));
        const fresh = rows.filter((r) => !existing.has(r.id));
        // a leftover sign-up with the same id as a brand-new slot must not make it look taken
        const clearStale = deleteIds(db, "claims", fresh.map((r) => r.id));

        if (mode === "add") {
          if (!fresh.length) return json({ ok: true, added: 0, kept: rows.length, removed: 0, released: 0 });
          await db.batch([
            ...clearStale,
            ...insertSlots(db, fresh),
            ...insertLog(db, [{ at, action: "config", slot: null, name: "Added " + plural(fresh.length, "slot"), actor: "admin" }]),
            bumpVersion(db),
          ]);
          return json({ ok: true, added: fresh.length, kept: rows.length - fresh.length, removed: 0, released: 0 });
        }

        const keep = new Set(rows.map((r) => r.id));
        const removedIds = [...existing].filter((id) => !keep.has(id));
        const removedSet = new Set(removedIds);
        const gone = (await db.prepare("SELECT id, name FROM claims").all()).results.filter((c) => removedSet.has(c.id));
        await db.batch([
          db.prepare("DELETE FROM slots"),
          ...insertSlots(db, rows),
          ...clearStale,
          ...deleteIds(db, "claims", gone.map((c) => c.id)),
          ...insertLog(db, [
            ...gone.map((c) => ({ at, action: "removed", slot: c.id, name: c.name, actor: "admin" })),
            { at, action: "config", slot: null, name: "Replaced the session list: " + fresh.length + " added, " + removedIds.length + " removed", actor: "admin" },
          ]),
          bumpVersion(db),
        ]);
        return json({ ok: true, added: fresh.length, kept: rows.length - fresh.length, removed: removedIds.length, released: gone.length });
      }

      // Remove slots (and any sign-ups on them).
      if (body.action === "removeSlots") {
        const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x) => typeof x === "string"))] : [];
        if (!ids.length || ids.length > 600) return json({ error: "bad_request" }, 400);
        const existing = new Set((await db.prepare("SELECT id FROM slots").all()).results.map((r) => r.id));
        const target = ids.filter((id) => existing.has(id));
        if (!target.length) return json({ ok: true, removed: 0, released: 0 });
        const tset = new Set(target);
        const gone = (await db.prepare("SELECT id, name FROM claims").all()).results.filter((c) => tset.has(c.id));
        await db.batch([
          ...deleteIds(db, "slots", target),
          ...deleteIds(db, "claims", gone.map((c) => c.id)),
          ...insertLog(db, [
            ...gone.map((c) => ({ at, action: "removed", slot: c.id, name: c.name, actor: "admin" })),
            { at, action: "config", slot: null, name: "Removed " + plural(target.length, "slot"), actor: "admin" },
          ]),
          bumpVersion(db),
        ]);
        return json({ ok: true, removed: target.length, released: gone.length });
      }
      return json({ error: "bad_request" }, 400);
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error(e && e.message);
    return json({ error: "server_error" }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request); // fallback; normally static files bypass the Worker
  },
};
