// Turso client for Cloudflare Workers — HTTP pipeline, no dependency.
// Uses the Turso database URL + auth token from Worker secrets:
//   TURSO_DATABASE_URL  e.g. https://musemesh-musemesh.aws-ap-south-1.turso.io
//   TURSO_AUTH_TOKEN    per-database token (minted via Turso Platform API)
// Engine: libSQL. Search SQL uses FTS5 syntax (proven in Spike C;
// Tantivy `USING fts` fails with "no such module: fts").
// No D1 fallback — Turso is the sole main DB (locked decision, 2026-11-25).

export class Turso {
  constructor(env) {
    this.url = (env.TURSO_DATABASE_URL || "").replace(/\/$/, "");
    this.token = env.TURSO_AUTH_TOKEN || "";
  }
  get configured() { return Boolean(this.url && this.token); }

  // Run one pipeline batch. stmts: [{sql, args:[{type,value}...]}]
  // Returns the pipeline result array. Throws on any SQLite error.
  // opts.retry: retry ONCE on transient transport failures (fetch threw,
  // or the pipeline endpoint answered HTTP 429/5xx). Reads only — write
  // batches are never retried (a retried write could double-execute).
  // The Turso pipeline occasionally stalls or drops a connection (observed
  // 2026-11-25: single calls hanging 10-30s, then a Worker 1101); one
  // retry on a fresh connection usually succeeds. Each attempt is capped
  // at 10s so a hung call fails fast instead of hanging to the Worker's
  // 30s kill (1101). SQLite errors (r.type === "error") are NOT retried.
  async batch(stmts, opts = {}) {
    if (!this.configured) throw new Error("Turso is not configured (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing)");
    const body = {
      requests: stmts.map((s) => ({
        type: "execute",
        // Nulls must be sent as {type:"null"} — String(null) is "null", which
        // violates foreign keys (e.g. attachments.room_id = "null").
        stmt: { sql: s.sql, args: (s.args || []).map((v) => (v === null || v === undefined ? { type: "null" } : { type: "text", value: String(v) })) },
      })),
      // Close the stream after this batch; stateless per request.
      stream: false,
    };
    const attempts = opts.retry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetch(this.url + "/v2/pipeline", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + this.token,
            "User-Agent": "Muse/1.0 (custom-connector; +https://muse.ai)",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`Turso pipeline HTTP ${res.status}: ${text.slice(0, 500)}`);
        let data;
        try { data = JSON.parse(text); } catch { throw new Error("Turso pipeline returned non-JSON: " + text.slice(0, 200)); }
        const results = data.results || [];
        for (const r of results) {
          if (r.type === "error") throw new Error(`Turso error ${r.error.code}: ${r.error.message}`);
        }
        // Pipeline shape: { type: "ok", response: { type: "execute", result: { cols, rows, ... } } }
        return results.map((r) => r.response?.result || null);
      } catch (e) {
        const msg = String(e && e.message || e);
        const transient = /Turso pipeline HTTP (429|5\d\d)/.test(msg) || e instanceof TypeError || /aborted|network|fetch failed|timed out/i.test(msg);
        if (transient && attempt + 1 < attempts) {
          console.error("turso transient failure, retrying once:", msg.slice(0, 200));
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw e;
      }
    }
    throw new Error("Turso batch failed after retry");
  }

  async execute(sql, args = [], opts = {}) {
    const [r] = await this.batch([{ sql, args }], opts);
    return r || null;
  }

  // Rows as plain objects: [{col: value}]
  static rows(result) {
    if (!result || !result.cols) return [];
    const cols = result.cols.map((c) => c.name);
    return (result.rows || []).map((row) =>
      Object.fromEntries(cols.map((c, i) => [c, row[i]?.value ?? null]))
    );
  }

  async query(sql, args = []) {
    // Reads are retried once on transient transport failures (see batch).
    return Turso.rows(await this.execute(sql, args, { retry: true }));
  }

  // Health check: one cheap indexed read.
  async ping() {
    const rows = await this.query("SELECT 1 AS ok");
    return rows.length === 1 && rows[0].ok === "1";
  }
}

// Split a .sql migration file into statements and run them in order.
// libSQL pipeline executes statements one by one; comments stripped.
export async function applyMigration(db, sqlText) {
  const stmts = sqlText
    .split(/;\s*\n/)
    .map((s) => s.replace(/--[^\n]*\n/g, "").trim())
    .filter((s) => s.length > 0)
    .map((sql) => ({ sql }));
  // Run in small batches to stay inside subrequest limits.
  const out = [];
  for (let i = 0; i < stmts.length; i += 10) {
    out.push(...(await db.batch(stmts.slice(i, i + 10))));
  }
  return out;
}
