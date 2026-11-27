// Apply a migration file to the Turso DB via the HTTP pipeline.
// Usage: TURSO_DATABASE_URL=https://<host> TURSO_AUTH_TOKEN=<token> node scripts/migrate.mjs [migrations/002_rate_limits.sql]
// The token is read from the environment only, never from a file, never printed.
// Prefer scripts/apply-migration.py, which mints a short-lived token itself.
// The migration path is resolved against the current directory first
// (so `node scripts/migrate.mjs migrations/001_init.sql` works from the
// repo root), falling back to relative-to-this-script for the default.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) { console.error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required"); process.exit(1); }
const arg = process.argv[2] || "../migrations/001_init.sql";
const file = existsSync(arg) ? resolve(arg) : new URL(arg, import.meta.url).pathname;
const sql = readFileSync(file, "utf8");
const stmts = sql.split(/;\s*\n/).map((s) => s.replace(/--[^\n]*\n/g, "").trim()).filter(Boolean);
console.log(`Applying ${stmts.length} statements to ${new URL(url).host} ...`);
for (let i = 0; i < stmts.length; i += 10) {
  const batch = stmts.slice(i, i + 10);
  const res = await fetch(url.replace(/\/$/, "") + "/v2/pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "User-Agent": "Muse/1.0 (custom-connector; +https://muse.ai)" },
    body: JSON.stringify({ requests: batch.map((s) => ({ type: "execute", stmt: { sql: s, args: [] } })), stream: false }),
  });
  const data = await res.json();
  for (const r of data.results || []) {
    if (r.type === "error") { console.error("Migration failed:", r.error); process.exit(1); }
  }
  console.log(`  statements ${i + 1}-${Math.min(i + 10, stmts.length)} OK`);
}
console.log("Migration complete.");
