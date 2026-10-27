#!/usr/bin/env node
// BidPilot — daily DIBBS ingest. Zero dependencies (Node 20+).
// Pulls DIBBS daily RFQ files for ALL FSCs and writes data/rfqs.js for the site.
//
//   node ingest/fetch.mjs            # last 5 days (normal daily run)
//   node ingest/fetch.mjs --days 30  # backfill
//
// Sources (public, no login):
//   inYYMMDD.txt  fixed-width index, one line per RFQ line item
//   bqYYMMDD.zip  batch-quote file: RFQ type, FOB, delivery days
// DIBBS quirks handled: DoD consent banner per host, F5 WAF that rejects
// lower-case header names (so node:https with Title-Case headers, not fetch).

import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const DIBBS = 'https://www.dibbs.bsm.dla.mil';
const FILES = 'https://dibbs2.bsm.dla.mil';
const OUT = path.resolve('data/rfqs.js');
const args = process.argv.slice(2);
const DAYS = +(args[args.indexOf('--days') + 1] || 0) || 5;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP client ----------
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
};
const jars = new Map();

export function raw(url, { method = 'GET', body, headers = {} } = {}) {
  const u = new URL(url);
  const jar = jars.get(u.host);
  const h = { ...HEADERS, ...headers };
  if (jar?.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (body) h['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h, timeout: 90000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (!jars.has(u.host)) jars.set(u.host, new Map());
        for (const c of res.headers['set-cookie'] ?? []) {
          const kv = c.split(';')[0]; const i = kv.indexOf('=');
          if (i > 0) jars.get(u.host).set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
        }
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function consent(warnUrl, html) {
  log('accepting DoD consent on', new URL(warnUrl).host);
  if (!html) html = (await raw(warnUrl)).body.toString('latin1');
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input[^>]*>/gi)) {
    const t = m[0];
    const name = t.match(/name="([^"]*)"/)?.[1];
    const value = t.match(/value="([^"]*)"/)?.[1] ?? '';
    const type = t.match(/type="([^"]*)"/)?.[1];
    if (name && (type === 'hidden' || name === 'butAgree')) form.append(name, value);
  }
  const action = html.match(/<form[^>]*action="([^"]*)"/i)?.[1];
  const postUrl = action ? new URL(action.replace(/&amp;/g, '&'), warnUrl).href : warnUrl;
  const res = await raw(postUrl, { method: 'POST', body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: warnUrl } });
  if (res.status >= 400) throw new Error(`consent POST failed HTTP ${res.status}`);
}

export async function get(url, binary = false, attempt = 0) {
  await sleep(300);
  let res;
  for (let i = 0; i < 3; i++) {
    try { res = await raw(url); break; } catch (e) { if (i === 2) throw e; await sleep(2000 * (i + 1)); }
  }
  const loc = res.headers.location;
  if (res.status >= 300 && res.status < 400 && loc) {
    const next = new URL(loc, url).href;
    if (/dodwarning\.aspx/i.test(next)) {
      if (attempt > 1) throw new Error('consent loop ' + url);
      await consent(next);
      return get(url, binary, attempt + 1);
    }
    return get(next, binary, attempt);
  }
  const isHtml = /text\/html/i.test(res.headers['content-type'] || '');
  const text = binary && !isHtml ? '' : res.body.toString('latin1');
  if (/<title>\s*Request Rejected/i.test(text)) throw new Error('DIBBS WAF rejected ' + url);
  if (/name="butAgree"/.test(text)) {
    if (attempt > 1) throw new Error('consent loop ' + url);
    await consent(url, text);
    return get(url, binary, attempt + 1);
  }
  if (res.status >= 400) throw new Error(`HTTP ${res.status} ${url}`);
  return binary ? res.body : text;
}

// ---------- parsers ----------
// Layout per DIBBS RfqFileDefs.aspx
const LAYOUT = [['sol', 13], ['nsn', 46], ['pr', 13], ['ret', 8], ['file', 19], ['qty', 7], ['unit', 2],
  ['nom', 21], ['buyer', 5], ['amsc', 1], ['itype', 1], ['sa', 1], ['sapct', 3]];

function usToIso(s) {
  const m = s?.trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (!m) return '';
  const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function parseIndex(text, postDate) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let p = 0; const r = {};
    for (const [k, n] of LAYOUT) { r[k] = line.slice(p, p + n).trim(); p += n; }
    if (!r.sol) continue;
    const nsn = r.nsn.replace(/-/g, '');
    out.push({
      sol: r.sol, nsn, pr: r.pr,
      fsc: /^\d{13}$/.test(nsn) ? nsn.slice(0, 4) : '',
      nom: r.nom, qty: r.qty ? parseInt(r.qty, 10) : null, unit: r.unit,
      issue: postDate, ret: usToIso(r.ret), sa: r.sa || 'N', amsc: r.amsc,
      file: r.file,
    });
  }
  return out;
}

// bq file: comma delimited, double-quoted, 121 columns (DIBBS BatchFormat.aspx)
export function parseBatch(text) {
  const m = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('"')) continue;
    const f = t.slice(1, t.endsWith('"') ? -1 : undefined).split('","');
    const g = (n) => (f[n - 1] ?? '').trim();
    const key = `${g(1)}:${g(46)}`;
    if (!g(1) || m.has(key)) continue;
    m.set(key, { type: g(2) || 'M', fob: g(32), insp: g(36), days: g(51) ? parseInt(g(51), 10) : null });
  }
  return m;
}

export function unzip(buf) {
  const files = new Map();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip');
  let p = buf.readUInt32LE(eocd + 16);
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    p += 46 + nl + el + cl;
  }
  return files;
}

// as file (inside bq zip): "NSN","CAGE","PartNumber","" one line per approved source
export function parseAS(text) {
  const m = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('"')) continue;
    const [nsn, cage, pn] = t.slice(1, -1).split('","').map((x) => (x || '').trim());
    if (!nsn || !cage) continue;
    if (!m.has(nsn)) m.set(nsn, []);
    m.get(nsn).push([cage, pn]);
  }
  return m;
}

// ---------- storage ----------
// Row array order (kept short to keep the file small):
// 0 sol, 1 nsn, 2 pr, 3 fsc, 4 nom, 5 qty, 6 unit, 7 issue, 8 ret, 9 setAside, 10 amsc, 11 type, 12 fob, 13 days, 14 file, 15 approved sources [[cage,pn],...], 16 inspection/acceptance point
const toRow = (r) => [r.sol, r.nsn, r.pr, r.fsc, r.nom, r.qty, r.unit, r.issue, r.ret, r.sa, r.amsc, r.type || '', r.fob || '', r.days ?? null, r.file || '', r.as || [], r.insp || ''];

function loadExisting() {
  try {
    const txt = fs.readFileSync(OUT, 'utf8');
    return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  } catch { return { updated: null, imported: [], rows: [] }; }
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const yymmddToIso = (s) => `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;

async function main() {
  const db = loadExisting();
  const byKey = new Map(db.rows.map((r) => [`${r[0]}:${r[2]}:${r[1]}`, r]));
  // v2 adds inspection point (col 36): re-import all listed days once.
  const done = new Set(db.v >= 2 ? db.imported || [] : []);

  const list = await get(`${DIBBS}/RFQ/RFQDates.aspx?category=recent`);
  const days = new Map();
  for (const m of list.matchAll(/href=["']([^"']*\/(in|bq)(\d{6})\.(txt|zip))["']/gi)) {
    const iso = yymmddToIso(m[3]);
    if (!days.has(iso)) days.set(iso, {});
    days.get(iso)[m[2].toLowerCase()] = new URL(m[1].replace(/&amp;/g, '&'), DIBBS).href;
  }
  const dates = [...days.keys()].sort().slice(-DAYS);
  log(`archive lists ${days.size} days; importing up to ${dates.length}`);

  for (const d of dates) {
    if (done.has(d)) { log(d, 'already imported'); continue; }
    const f = days.get(d);
    if (!f.in) continue;
    const recs = parseIndex(await get(f.in), d);
    if (f.bq) {
      try {
        const zip = unzip(await get(f.bq, true));
        const name = [...zip.keys()].find((n) => /^bq.*\.txt$/i.test(n));
        const extra = name ? parseBatch(zip.get(name).toString('latin1')) : new Map();
        const asName = [...zip.keys()].find((n) => /^as.*\.txt$/i.test(n));
        const as = asName ? parseAS(zip.get(asName).toString('latin1')) : new Map();
        for (const r of recs) Object.assign(r, extra.get(`${r.sol}:${r.pr}`) || {}, { as: as.get(r.nsn) || [] });
        log(d, `batch merged, ${as.size} NSNs with approved sources`);
      } catch (e) { log(d, 'batch file skipped:', e.message); }
    }
    for (const r of recs) byKey.set(`${r.sol}:${r.pr}:${r.nsn}`, toRow(r));
    done.add(d);
    log(d, `${recs.length} RFQ lines`);
  }

  // Keep only RFQs still open (return-by today or later).
  const rows = [...byKey.values()].filter((r) => !r[8] || r[8] >= today);
  rows.sort((a, b) => (a[8] || '').localeCompare(b[8] || ''));
  const keep = [...done].sort().slice(-60);
  const out = { v: 2, updated: new Date().toISOString(), imported: keep, rows };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, 'window.RFQ_DATA=' + JSON.stringify(out) + ';\n');
  log(`wrote ${rows.length} open RFQ lines to ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
