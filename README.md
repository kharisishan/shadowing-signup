# Shadowing sign-up: Cloudflare Workers version

Same page and behaviour as the Netlify version. The backend is a Cloudflare Worker
with a D1 (SQLite) database; the page is served as free static assets.
(Cloudflare now steers new projects to Workers rather than Pages, so this uses Workers.)

```
public/index.html   the page (polling slowed from 4s to 15s)
src/worker.js       /api/slots, /api/claim, /api/release
schema.sql          D1 table (slot id is the primary key = first come first served)
wrangler.toml       Worker + static assets + D1 config
```

IMPORTANT: do NOT drag these files into the dashboard's "Upload and deploy" box. That
uploader only handles plain static files and flattens folders, so the backend and database
would not deploy. Use one of the two routes below.

## Route A: command line (about 5 commands, needs Node.js)
Run from this folder:
1. `npx wrangler login`
2. `npx wrangler d1 create shadowing-signup`   (copy the printed database_id into wrangler.toml)
3. `npx wrangler d1 execute shadowing-signup --remote --file=schema.sql`
4. `npx wrangler deploy`
5. Optional admin override: `npx wrangler secret put ADMIN_KEY`

The site goes live at https://shadowing-signup.<your-account>.workers.dev

## Route B: GitHub + dashboard (no terminal)
1. Dashboard > Storage & databases > D1 > Create database, name it `shadowing-signup`.
   Open it > Console tab > paste the contents of schema.sql > Execute.
   Copy the database ID into wrangler.toml (replace REPLACE_WITH_DATABASE_ID).
2. Upload this whole folder to a GitHub repo, keeping the folder structure.
3. Dashboard > Workers & Pages > Create > Import a repository. Pick the repo.
   Deploy command: `npx wrangler deploy`. Build command: leave empty.
4. Optional: Worker > Settings > Variables and Secrets > add secret ADMIN_KEY.

## Admin release of a stuck slot
```
curl -X POST https://YOUR-URL/api/release \
  -H "content-type: application/json" \
  -d '{"id":"7th-october-putra-lights-9-am","adminKey":"YOUR_ADMIN_KEY"}'
```
Or in the D1 console: `DELETE FROM claims WHERE id = '7th-october-putra-lights-9-am';`

## Notes
- Existing claims on Netlify do not transfer; re-add them with an INSERT or migrate after the sessions.
- A new domain resets each browser's anonymous token, so people can't release slots claimed on the old site.
- Free limits: 100,000 Worker requests/day (resets midnight UTC), 5M D1 rows read/day, 100K rows written/day.
