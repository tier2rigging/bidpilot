// BidPilot API (Cloudflare Worker) — workspaces, per-workspace CRM, admin controls.
// Runs at bidpilot.tier2rigging.com/api/*, behind Cloudflare Access. Every request is checked:
//   1. the Cloudflare Access login token (signature, audience, expiry) -> who is signed in
//   2. that person is invited, not disabled, and their workspace is not locked
// Only ADMIN_EMAIL (set in wrangler.toml, not editable from the website) can use /api/admin/*.
//
// Storage: Cloudflare D1 (SQLite). Tables are created on first use.

const JSONH = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSONH });
const err = (status, code, message) => json({ error: code, message }, status);
const now = () => new Date().toISOString();
const MAX_CRM_BYTES = 1_800_000; // D1 row limit is 2 MB

// ---------- schema ----------
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, workspace TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', disabled INTEGER NOT NULL DEFAULT 0, name TEXT, created TEXT NOT NULL, last_seen TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm (workspace TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL, updated TEXT NOT NULL, updated_by TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (email TEXT PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ws_settings (workspace TEXT PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL, updated_by TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)`),
  ]);
  schemaReady = true;
}
const audit = (db, actor, action, detail) => db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?,?,?,?)').bind(now(), actor, action, detail ? JSON.stringify(detail) : null).run();

// ---------- Cloudflare Access token check ----------
let certCache = { at: 0, keys: [] };
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
async function accessIdentity(request, env) {
  if (env.DEV_EMAIL) return (env.DEV_EMAIL === '*' ? request.headers.get('X-Dev-Email') || '' : env.DEV_EMAIL).toLowerCase() || null; // local testing only (never set in production)
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || (request.headers.get('Cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlBytes(p)));
  if (Date.now() - certCache.at > 3600e3 || !certCache.keys.some((k) => k.kid === header.kid)) {
    const r = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (env.POLICY_AUD && !aud.includes(env.POLICY_AUD)) return null;
  if (payload.iss && payload.iss !== `https://${env.TEAM_DOMAIN}`) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return (payload.email || '').toLowerCase() || null;
}

// ---------- optional: keep the Cloudflare Access allow-list in step with invites ----------
async function cfApi(env, method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    method, headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error((j.errors || []).map((e) => e.message).join('; ') || `Cloudflare API ${r.status}`);
  return j.result;
}
const accessSyncOn = (env) => !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.ACCESS_POLICY_ID);
async function syncAccessPolicy(env, db) {
  if (!accessSyncOn(env)) return { synced: false, note: 'Automatic Cloudflare Access sync is off: also add/remove this email in Cloudflare Access → Policies → Allowed.' };
  const { results } = await db.prepare('SELECT u.email FROM users u JOIN workspaces w ON w.id = u.workspace WHERE u.disabled = 0 AND w.locked = 0').all();
  const emails = new Set(results.map((r) => r.email));
  emails.add(env.ADMIN_EMAIL.toLowerCase()); // the administrator can never be locked out
  const pol = await cfApi(env, 'GET', `/access/policies/${env.ACCESS_POLICY_ID}`);
  await cfApi(env, 'PUT', `/access/policies/${env.ACCESS_POLICY_ID}`, {
    name: pol.name, decision: pol.decision || 'allow', include: [...emails].sort().map((email) => ({ email: { email } })),
    exclude: pol.exclude || [], require: pol.require || [], session_duration: pol.session_duration,
  });
  return { synced: true, count: emails.size };
}
async function revokeSessions(env, email) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return false;
  try { await cfApi(env, 'POST', '/access/organizations/revoke_user', { email }); return true; } catch { return false; }
}

// ---------- who is this ----------
async function loadMe(db, env, email) {
  let u = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u && email === env.ADMIN_EMAIL.toLowerCase()) {
    // First sign-in by the administrator: create the home workspace.
    const ws = env.HOME_WORKSPACE_ID || 'tier2', wsName = env.HOME_WORKSPACE_NAME || 'Tier2 Rigging';
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO workspaces (id, name, locked, created) VALUES (?,?,0,?)').bind(ws, wsName, now()),
      db.prepare(`INSERT INTO users (email, workspace, role, disabled, created) VALUES (?,?, 'owner', 0, ?)`).bind(email, ws, now()),
    ]);
    u = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  }
  if (!u) return { status: 403, error: 'not_invited' };
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').bind(u.workspace).first();
  const isAdmin = email === env.ADMIN_EMAIL.toLowerCase();
  if (!isAdmin && u.disabled) return { status: 403, error: 'disabled' };
  if (!isAdmin && (!ws || ws.locked)) return { status: 403, error: 'workspace_locked' };
  if (!u.last_seen || Date.now() - Date.parse(u.last_seen) > 10 * 60e3) await db.prepare('UPDATE users SET last_seen = ? WHERE email = ?').bind(now(), email).run();
  return { user: u, ws, isAdmin };
}

// ---------- admin ----------
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
async function admin(request, env, db, me, path) {
  const url = new URL(request.url);
  const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
  const adminEmail = env.ADMIN_EMAIL.toLowerCase();

  if (path === 'state' && request.method === 'GET') {
    const [ws, users, crm, log] = await Promise.all([
      db.prepare('SELECT * FROM workspaces ORDER BY created').all(),
      db.prepare('SELECT email, workspace, role, disabled, name, created, last_seen FROM users ORDER BY workspace, email').all(),
      db.prepare('SELECT workspace, length(data) AS bytes, version, updated, updated_by FROM crm').all(),
      db.prepare('SELECT at, actor, action, detail FROM audit ORDER BY id DESC LIMIT 40').all(),
    ]);
    return json({ admin: adminEmail, accessSync: accessSyncOn(env), workspaces: ws.results, users: users.results, crm: crm.results, audit: log.results });
  }

  if (path === 'workspace' && request.method === 'POST') {
    const name = String(body.name || '').trim().slice(0, 60);
    const id = body.id || slug(name);
    if (!id || !name) return err(400, 'bad_request', 'Workspace name is required.');
    const exists = await db.prepare('SELECT id FROM workspaces WHERE id = ?').bind(id).first();
    if (exists) {
      await db.prepare('UPDATE workspaces SET name = ?, locked = ? WHERE id = ?').bind(name, body.locked ? 1 : 0, id).run();
    } else {
      await db.prepare('INSERT INTO workspaces (id, name, locked, created) VALUES (?,?,?,?)').bind(id, name, body.locked ? 1 : 0, now()).run();
    }
    await audit(db, me, exists ? (body.locked ? 'lock_workspace' : 'update_workspace') : 'create_workspace', { id, name, locked: !!body.locked });
    let access = null;
    if (exists) {
      try { access = await syncAccessPolicy(env, db); } catch (e) { access = { synced: false, note: e.message }; }
      if (body.locked) {
        const { results } = await db.prepare('SELECT email FROM users WHERE workspace = ? AND email != ?').bind(id, adminEmail).all();
        for (const r of results) await revokeSessions(env, r.email);
      }
    }
    return json({ ok: true, id, access });
  }

  if (path === 'workspace' && request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    const n = await db.prepare('SELECT count(*) AS n FROM users WHERE workspace = ?').bind(id).first();
    if (n.n) return err(409, 'not_empty', 'Move or remove its users first.');
    await db.batch([db.prepare('DELETE FROM crm WHERE workspace = ?').bind(id), db.prepare('DELETE FROM workspaces WHERE id = ?').bind(id)]);
    await audit(db, me, 'delete_workspace', { id });
    return json({ ok: true });
  }

  if (path === 'user' && request.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return err(400, 'bad_request', 'Enter a valid email.');
    const ws = await db.prepare('SELECT id FROM workspaces WHERE id = ?').bind(body.workspace).first();
    if (!ws) return err(400, 'bad_request', 'Pick a workspace.');
    const role = email === adminEmail ? 'owner' : ['owner', 'member'].includes(body.role) ? body.role : 'member';
    const disabled = email === adminEmail ? 0 : body.disabled ? 1 : 0; // the administrator can't disable themself
    const existed = await db.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
    await db.prepare(`INSERT INTO users (email, workspace, role, disabled, name, created) VALUES (?,?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET workspace = excluded.workspace, role = excluded.role, disabled = excluded.disabled, name = excluded.name`)
      .bind(email, body.workspace, role, disabled, String(body.name || '').slice(0, 60) || null, now()).run();
    await audit(db, me, existed ? (disabled ? 'disable_user' : 'update_user') : 'invite_user', { email, workspace: body.workspace, role, disabled: !!disabled });
    let access; try { access = await syncAccessPolicy(env, db); } catch (e) { access = { synced: false, note: e.message }; }
    if (disabled) access.revoked = await revokeSessions(env, email);
    return json({ ok: true, access });
  }

  if (path === 'user' && request.method === 'DELETE') {
    const email = String(url.searchParams.get('email') || '').toLowerCase();
    if (email === adminEmail) return err(400, 'bad_request', 'The administrator can’t be removed.');
    await db.batch([db.prepare('DELETE FROM users WHERE email = ?').bind(email), db.prepare('DELETE FROM settings WHERE email = ?').bind(email)]);
    await audit(db, me, 'remove_user', { email });
    let access; try { access = await syncAccessPolicy(env, db); } catch (e) { access = { synced: false, note: e.message }; }
    access.revoked = await revokeSessions(env, email);
    return json({ ok: true, access });
  }

  if (path === 'export' && request.method === 'GET') {
    const id = url.searchParams.get('workspace');
    const row = await db.prepare('SELECT data FROM crm WHERE workspace = ?').bind(id).first();
    await audit(db, me, 'export_workspace', { id });
    return new Response(row ? row.data : '{}', { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="bidpilot-${id}.json"` } });
  }

  if (path === 'access-sync' && request.method === 'POST') {
    try { return json({ ok: true, access: await syncAccessPolicy(env, db) }); } catch (e) { return err(502, 'access_sync_failed', e.message); }
  }

  return err(404, 'not_found', 'Unknown admin action.');
}

// ---------- main ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return fetch(request); // static site passes through
    const path = url.pathname.slice(5).replace(/\/$/, '');
    try {
      const db = env.DB;
      await ensureSchema(db);
      const email = await accessIdentity(request, env);
      if (!email) return err(401, 'not_signed_in', 'Sign in through Cloudflare Access.');
      const me = await loadMe(db, env, email);
      if (me.error) return err(me.status, me.error, { not_invited: 'Your account is not set up yet. Ask the administrator to invite you.', disabled: 'Your access has been turned off by the administrator.', workspace_locked: 'Your workspace is locked by the administrator.' }[me.error]);
      const { user, ws, isAdmin } = me;

      if (path === 'me') return json({ email, name: user.name, role: user.role, admin: isAdmin, workspace: { id: ws.id, name: ws.name, locked: !!ws.locked } });

      if (path === 'crm' && request.method === 'GET') {
        const row = await db.prepare('SELECT data, version, updated, updated_by FROM crm WHERE workspace = ?').bind(ws.id).first();
        return json(row ? { version: row.version, updated: row.updated, updated_by: row.updated_by, data: JSON.parse(row.data) } : { version: 0, data: null });
      }
      if (path === 'crm' && request.method === 'PUT') {
        const body = await request.json().catch(() => null);
        if (!body || typeof body.data !== 'object' || typeof body.version !== 'number') return err(400, 'bad_request', 'Expected {version, data}.');
        const text = JSON.stringify(body.data);
        if (text.length > MAX_CRM_BYTES) return err(413, 'too_large', 'This workspace’s data is over the 1.8 MB limit.');
        let res;
        if (body.version === 0) res = await db.prepare('INSERT OR IGNORE INTO crm (workspace, data, version, updated, updated_by) VALUES (?,?,1,?,?)').bind(ws.id, text, now(), email).run();
        else res = await db.prepare('UPDATE crm SET data = ?, version = version + 1, updated = ?, updated_by = ? WHERE workspace = ? AND version = ?').bind(text, now(), email, ws.id, body.version).run();
        if (!res.meta.changes) return err(409, 'conflict', 'Someone else saved first. Reload and merge.');
        return json({ ok: true, version: body.version + 1 });
      }

      if (path === 'settings' && request.method === 'GET') {
        const row = await db.prepare('SELECT data FROM settings WHERE email = ?').bind(email).first();
        const co = await db.prepare('SELECT data FROM ws_settings WHERE workspace = ?').bind(ws.id).first();
        return json({ data: row ? JSON.parse(row.data) : null, company: co ? JSON.parse(co.data) : null, canEditCompany: isAdmin || user.role === 'owner' });
      }
      if (path === 'settings' && request.method === 'PUT') {
        const body = await request.json().catch(() => null);
        if (!body || typeof body.data !== 'object') return err(400, 'bad_request', 'Expected {data}.');
        const clean = { ...body.data }; delete clean.token; delete clean.repo; // never store GitHub credentials
        await db.prepare('INSERT INTO settings (email, data, updated) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(email, JSON.stringify(clean).slice(0, 200000), now()).run();
        // Company answers (CAGE, business type, DIBBS certifications) belong to the workspace; owners set them.
        if (body.company && typeof body.company === 'object') {
          if (!(isAdmin || user.role === 'owner')) return json({ ok: true, companySaved: false, message: 'Only a workspace owner can change the company answers.' });
          await db.prepare('INSERT INTO ws_settings (workspace, data, updated, updated_by) VALUES (?,?,?,?) ON CONFLICT(workspace) DO UPDATE SET data = excluded.data, updated = excluded.updated, updated_by = excluded.updated_by').bind(ws.id, JSON.stringify(body.company).slice(0, 50000), now(), email).run();
        }
        return json({ ok: true, companySaved: !!body.company });
      }

      if (path.startsWith('admin/')) {
        if (!isAdmin) return err(403, 'admin_only', 'Administrator only.');
        return admin(request, env, db, email, path.slice(6));
      }
      return err(404, 'not_found', 'Unknown API path.');
    } catch (e) {
      return err(500, 'server_error', String(e.message || e));
    }
  },
};
