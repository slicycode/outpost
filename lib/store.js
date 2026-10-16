'use strict';
// Match storage with optimistic concurrency.
// - Supabase (Postgres via PostgREST) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set (production on Vercel).
//   Table: matches(code text primary key, doc jsonb not null, version int not null, updated_at timestamptz) — see schema.sql
// - In-memory Map otherwise (local dev, tests). Single process only.
// A record is the whole match document plus `version`.

const memory = new Map();

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

async function sbFetch(path, init = {}) {
  const cfg = supabaseConfig();
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`supabase ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function split(rec) {
  const { version, ...doc } = rec;
  return { doc, version };
}

const store = {
  backend() { return supabaseConfig() ? 'supabase' : 'memory'; },

  async get(code) {
    if (!supabaseConfig()) return memory.has(code) ? structuredClone(memory.get(code)) : null;
    const rows = await sbFetch(`matches?code=eq.${encodeURIComponent(code)}&select=doc,version`);
    if (!rows || !rows.length) return null;
    return { ...rows[0].doc, version: rows[0].version };
  },

  async create(rec) {
    const full = { ...rec, version: 1 };
    if (!supabaseConfig()) {
      if (memory.has(rec.code)) { const e = new Error('code collision'); e.code = 'CONFLICT'; throw e; }
      memory.set(rec.code, structuredClone(full));
      return full;
    }
    const { doc } = split(full);
    try {
      await sbFetch('matches', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ code: rec.code, doc, version: 1, updated_at: new Date().toISOString() }) });
    } catch (e) { if (e.status === 409) e.code = 'CONFLICT'; throw e; }
    return full;
  },

  // Save only if the stored version still equals rec.version; bumps rec.version. Throws CONFLICT otherwise.
  async update(rec) {
    if (!supabaseConfig()) {
      const cur = memory.get(rec.code);
      if (!cur || cur.version !== rec.version) { const e = new Error('version conflict'); e.code = 'CONFLICT'; throw e; }
      rec.version += 1;
      memory.set(rec.code, structuredClone(rec));
      return rec;
    }
    const { doc, version } = split(rec);
    const rows = await sbFetch(`matches?code=eq.${encodeURIComponent(rec.code)}&version=eq.${version}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ doc, version: version + 1, updated_at: new Date().toISOString() }),
    });
    if (!rows || rows.length !== 1) { const e = new Error('version conflict'); e.code = 'CONFLICT'; throw e; }
    rec.version = version + 1;
    return rec;
  },

  _reset() { memory.clear(); },
};

module.exports = store;
