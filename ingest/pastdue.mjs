#!/usr/bin/env node
// BidPilot: RFQs past their return-by date that DIBBS still shows as OPEN.
// DLA often leaves an RFQ open (not awarded, not cancelled) for weeks or months after the
// return-by date and keeps taking quotes. This keeps those, and only those.
//
//   node ingest/pastdue.mjs --minutes 25 [--backfill 120]
//
// Candidates: lines fetch.mjs drops when their return-by date passes (data/pastdue-queue.json),
// plus, with --backfill N, older DIBBS daily index files (tried by date, skipped if gone).
// Each candidate's status is read from DIBBS's NSN search (one page per NSN). Only lines DIBBS
// shows as "Open" go into data/pastdue.js. Shown lines are re-checked, oldest check first.

import fs from 'node:fs';
import path from 'node:path';
import { get, raw, parseIndex, unzip, parseAS, parseBatch } from './fetch.mjs';

const DIBBS = 'https://www.dibbs.bsm.dla.mil';
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] || d : d; };
const MINUTES = arg('--minutes', 25), BACKFILL = arg('--backfill', 0);
const QUEUE = path.resolve('data/pastdue-queue.json');
const OUT = path.resolve('data/pastdue.js');
const STATE = path.resolve('data/pastdue-state.json');
const MAX_TRIES = 4;          // give up on a line DIBBS never lists after this many checks
const RECHECK_DAYS = 2;       // shown lines are re-verified at least this often (time permitting)
const MAX_AGE_DAYS = 730;     // stop tracking lines whose return-by date is older than this
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const t0 = Date.now();
const left = () => MINUTES * 60e3 - (Date.now() - t0);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const daysAgo = (iso) => Math.round((Date.parse(today) - Date.parse(iso)) / 864e5);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const key = (r) => `${r[0]}:${r[2]}:${r[1]}`;

// ---------- DIBBS NSN search page -> {SOL: status} ----------
// Each result row has the solicitation (SPE7L1-25-T-04H3) and an RFQ/Quote Status cell
// ("Open", "Closed", "Cancelled", "Awarded"...). Item names are upper case, statuses are not,
// so matching the title-case status words avoids e.g. "WRENCH, OPEN END".
const SOL_RE = /\b(SP[A-Z0-9]{4})-?(\d{2})-?([A-Z])-?([A-Z0-9]{4})\b/;
const STATUS_RE = /\b(Open|Closed|Cancell?ed|Awarded|Expired|Suspended|Pending|Archived)\b/;
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
export function parseNsnSearch(html) {
  const out = new Map();
  for (const chunk of html.split(/<tr[\s>]/i).slice(1)) {
    const row = chunk.split(/<\/tr>/i)[0];
    // Real results grid: <span id="..._lblSolicitation"> and <span id="..._lblStatus"><span>Open</span>...
    const solCell = row.match(/_lblSolicitation"[^>]*>([\s\S]*?)<\/td>/i), stCell = row.match(/_lblStatus"[^>]*>([\s\S]*?)<\/td>/i);
    const text = strip(solCell ? solCell[1] : row);
    const s = text.match(SOL_RE); if (!s) continue;
    const st = (stCell ? strip(stCell[1]) : strip(row)).match(STATUS_RE);
    const sol = s[1] + s[2] + s[3] + s[4];
    if (!out.has(sol) || st) out.set(sol, st ? st[1].replace('Canceled', 'Cancelled') : '');
  }
  return out;
}

// DIBBS's header quick search ("RFQs - NSN"), the same form a browser submits. It returns
// RfqRecs.aspx: "All RFQs where NSN/Part Numbers: ..." with an RFQ/Quote Status column.
let formPage = null; // { url, html } of the last DIBBS page, reused for the next search's form fields
function formFields(html) {
  const f = new URLSearchParams();
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]*)"/)?.[1]; if (!name) continue;
    f.set(name, (m[0].match(/value="([^"]*)"/)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  }
  const nav = html.match(/name="ctl00\$ddlNavigation"[\s\S]*?<\/select>/i)?.[0] || '';
  const navVal = (nav.match(/<option[^>]*selected[^>]*value="([^"]*)"/i) || nav.match(/<option[^>]*value="([^"]*)"[^>]*selected/i) || nav.match(/<option[^>]*value="([^"]*)"/i) || [])[1];
  if (navVal !== undefined) f.set('ctl00$ddlNavigation', navVal);
  return f;
}
export async function searchNsn(nsn) {
  if (!formPage) { const url = `${DIBBS}/RFQ/RFQDates.aspx?category=recent`; formPage = { url, html: await get(url) }; }
  const f = formFields(formPage.html);
  f.set('__EVENTTARGET', 'ctl00$butDbSearch'); f.set('__EVENTARGUMENT', '');
  f.set('ctl00$ddlGotoDB', 'rfqnsn'); f.set('ctl00$txtValue', nsn);
  const action = formPage.html.match(/<form[^>]*action="([^"]*)"/i)?.[1];
  const postUrl = action ? new URL(action.replace(/&amp;/g, '&'), formPage.url).href : formPage.url;
  await new Promise((r) => setTimeout(r, 400));
  const res = await raw(postUrl, { method: 'POST', body: f.toString().replace(/%20/g, '+'), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: formPage.url, Origin: DIBBS } });
  let html, url = postUrl;
  if (res.status >= 300 && res.status < 400 && res.headers.location) { url = new URL(res.headers.location, postUrl).href; html = await get(url); }
  else { html = res.body.toString('latin1'); if (res.status >= 400) { formPage = null; throw new Error(`HTTP ${res.status}`); } }
  if (/name="butAgree"|Request Rejected/i.test(html)) { formPage = null; throw new Error('consent or WAF page instead of results'); }
  if (/__VIEWSTATE/.test(html)) formPage = { url, html }; else formPage = null;
  return html;
}

async function main() {
  const queue = readJson(QUEUE, { rows: [] });
  const shownPrev = (() => { try { const t = fs.readFileSync(OUT, 'utf8'); return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)).rows || []; } catch { return []; } })();
  const st0 = readJson(STATE, { tries: {}, gone: {}, backfilled: [] });
  // v2: earlier runs used a page without the status column; forget their retry counts.
  const st = st0.v === 2 ? st0 : { ...st0, tries: {}, gone: Object.fromEntries(Object.entries(st0.gone || {}).filter(([, v]) => v !== 'not listed')) };
  const gone = new Map(Object.entries(st.gone || {})); // key -> status seen, never re-added
  const tries = new Map(Object.entries(st.tries || {}));
  const backfilled = new Set(st.backfilled || []);

  // Candidate pool: key -> row (17 fields) ; shown rows carry [17] = last-checked date.
  const cand = new Map();
  const add = (r) => { if (!r[0] || !r[8] || r[8] >= today || daysAgo(r[8]) > MAX_AGE_DAYS) return; const k = key(r); if (gone.has(k) || cand.has(k)) return; cand.set(k, r.slice(0, 17)); };
  const shown = new Map(shownPrev.map((r) => [key(r), r]));
  for (const r of queue.rows) add(r);

  // Optional backfill of older daily index files (DIBBS only lists recent days; older files may still exist).
  if (BACKFILL) {
    try {
      const list = await get(`${DIBBS}/RFQ/RFQDates.aspx?category=recent`);
      const ins = [...list.matchAll(/href=["']([^"']*\/in(\d{6})\.txt)["']/gi)].map((m) => ({ url: new URL(m[1].replace(/&amp;/g, '&'), DIBBS).href, d: m[2] })).sort((a, b) => a.d.localeCompare(b.d));
      const bqs = [...list.matchAll(/href=["']([^"']*\/bq(\d{6})\.zip)["']/gi)].map((m) => new URL(m[1].replace(/&amp;/g, '&'), DIBBS).href);
      if (ins.length) {
        const tmplIn = ins[0].url, code = ins[0].d, tmplBq = bqs.find((u) => u.includes(code)) || bqs[0];
        const start = new Date(Date.UTC(2000 + +code.slice(0, 2), +code.slice(2, 4) - 1, +code.slice(4, 6)));
        let found = 0, missing = 0;
        for (let i = 1; i <= BACKFILL && left() > MINUTES * 60e3 * 0.5; i++) {
          const d = new Date(start - i * 864e5); const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
          const c = d.toISOString().slice(2, 10).replace(/-/g, ''); if (backfilled.has(c)) continue;
          const iso = d.toISOString().slice(0, 10);
          try {
            const recs = parseIndex(await get(tmplIn.replace(code, c)), iso);
            if (tmplBq) try {
              const zip = unzip(await get(tmplBq.replace(code, c), true));
              const bn = [...zip.keys()].find((n) => /^bq.*\.txt$/i.test(n)), an = [...zip.keys()].find((n) => /^as.*\.txt$/i.test(n));
              const extra = bn ? parseBatch(zip.get(bn).toString('latin1')) : new Map(), as = an ? parseAS(zip.get(an).toString('latin1')) : new Map();
              for (const r of recs) Object.assign(r, extra.get(`${r.sol}:${r.pr}`) || {}, { as: as.get(r.nsn) || [] });
            } catch {}
            for (const r of recs) add([r.sol, r.nsn, r.pr, r.fsc, r.nom, r.qty, r.unit, r.issue, r.ret, r.sa, r.amsc, r.type || '', r.fob || '', r.days ?? null, r.file || '', r.as || [], r.insp || '']);
            backfilled.add(c); found++;
          } catch { missing++; backfilled.add(c); }
        }
        log(`backfill: ${found} older index files read, ${missing} not available`);
      }
    } catch (e) { log('backfill skipped:', e.message); }
  }

  // Work list by NSN: new candidates first, then shown lines due for a re-check (oldest first).
  const byNsn = new Map();
  const want = (r, pri) => { const n = r[1]; if (!n) return; const e = byNsn.get(n) || { pri: 9e9, rows: [] }; e.rows.push(r); e.pri = Math.min(e.pri, pri); byNsn.set(n, e); };
  for (const r of cand.values()) if (!shown.has(key(r))) want(r, -1);
  for (const r of shown.values()) { const age = r[17] ? daysAgo(r[17]) : 99; if (age >= RECHECK_DAYS) want(r, -age / 1000 + 1); else if (daysAgo(r[8]) > MAX_AGE_DAYS) shown.delete(key(r)); }
  const work = [...byNsn.entries()].sort((a, b) => a[1].pri - b[1].pri);
  log(`${cand.size} past-due candidates, ${shown.size} shown, ${work.length} NSNs to check`);

  let checked = 0, open = 0, closed = 0, unknown = 0, failed = 0, sample = null, withRows = 0, firstEmpty = null;
  const unlisted = []; // counted as a failed check only if this run's searches returned real results
  for (const [nsn, e] of work) {
    if (left() < 30e3) break;
    let page;
    try { page = await searchNsn(nsn); } catch (err) { failed++; if (failed <= 3) log('NSN search failed', nsn, err.message); if (failed > 25 && !checked) { log('DIBBS NSN search not reachable; stopping'); break; } continue; }
    const status = parseNsnSearch(page);
    if (status.size) withRows++; else if (!firstEmpty) firstEmpty = `${nsn}: page title "${(page.match(/<title>([^<]*)/i) || [])[1]?.trim() || '?'}", ${page.length} bytes, ${/No records|no matching/i.test(page) ? 'says no records' : 'no RFQ rows found'}`;
    if (!sample && status.size) sample = `${nsn}: ${[...status].slice(0, 4).map(([s, v]) => `${s}=${v || '?'}`).join(', ')}`;
    checked++;
    for (const r of e.rows) {
      const k = key(r), s = status.get(r[0]);
      if (s === 'Open') { shown.set(k, [...r.slice(0, 17), today]); tries.delete(k); open++; }
      else if (s) { shown.delete(k); gone.set(k, s); tries.delete(k); closed++; }
      else { unknown++; unlisted.push(k); } // not listed or no status: never shown unverified
    }
    if (checked % 200 === 0) log(`${checked} NSNs checked`);
  }
  if (sample) log('sample status read:', sample);
  if (firstEmpty) log('first search with no RFQ rows:', firstEmpty);
  if (withRows) for (const k of unlisted) { const n = (+tries.get(k) || 0) + 1; if (n >= MAX_TRIES) { shown.delete(k); gone.set(k, 'not listed'); tries.delete(k); } else tries.set(k, n); }
  else if (checked) log('WARNING: no search returned RFQ rows, so nothing was marked as checked this run');
  log(`checked ${checked} NSNs: ${open} lines still open, ${closed} closed/awarded/cancelled, ${unknown} not listed yet, ${failed} failed`);

  // Queue keeps candidates not decided yet; gone list trimmed to lines that could still re-appear.
  const pending = [...cand.values()].filter((r) => { const k = key(r); return !shown.has(k) && !gone.has(k); });
  const rows = [...shown.values()].sort((a, b) => (b[8] || '').localeCompare(a[8] || ''));
  fs.writeFileSync(QUEUE, JSON.stringify({ rows: pending }));
  const goneObj = {}; for (const [k, v] of gone) goneObj[k] = v;
  const keepGone = Object.fromEntries(Object.entries(goneObj).slice(-60000));
  fs.writeFileSync(STATE, JSON.stringify({ v: 2, tries: Object.fromEntries(tries), gone: keepGone, backfilled: [...backfilled].sort().slice(-800) }));
  fs.writeFileSync(OUT, 'window.PASTDUE_LOAD&&PASTDUE_LOAD(' + JSON.stringify({ updated: new Date().toISOString(), rows }) + ');\n');
  log(`wrote ${rows.length} past-due open RFQ lines; ${pending.length} still waiting for a check`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
