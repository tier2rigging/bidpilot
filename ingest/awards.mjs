#!/usr/bin/env node
// BidPilot — daily DIBBS award collector.
// DIBBS purges old awards, so this saves every posted award permanently in data/awards/,
// building your own award history from the first run forward.
//
//   node ingest/awards.mjs            # last 7 award dates (re-checks for late postings)
//   node ingest/awards.mjs --days 30  # as far back as DIBBS still has
//
// Source: "Awards by Award Date" (Awards/AwdRecs.aspx?Category=awddt), 50 rows per page,
// ASP.NET postback paging. Quantity and unit price are read from each award PDF with
// pdftotext (poppler-utils), validated by qty x unit price = total.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { get, raw } from './fetch.mjs';

const DIBBS = 'https://www.dibbs.bsm.dla.mil';
const args = process.argv.slice(2);
const DAYS = +(args[args.indexOf('--days') + 1] || 0) || 7;
const PDF_LIMIT = +(args[args.indexOf('--pdfs') + 1] || 0) || 600;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const span = (tr, id) => clean((tr.match(new RegExp(`_${id}"[^>]*>([\\s\\S]*?)</span>\\s*(?:<br>\\s*)?</td>`)) || [])[1]);
const usToIso = (s) => { const m = (s || '').match(/(\d{2})-(\d{2})-(\d{4})/); return m ? `${m[3]}-${m[1]}-${m[2]}` : ''; };
const money = (s) => { const n = parseFloat(String(s || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };

export function parseAwardPage(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr class="Bg(?:White|Silver)"[\s\S]*?<\/tr>/g)) {
    const tr = m[0];
    const contract = span(tr, 'lblAwardBasicNumber').split(/\s*Â?»/)[0].trim();
    if (!contract) continue;
    const pdf = (tr.match(/href=["'](https:\/\/dibbs2\.bsm\.dla\.mil\/Downloads\/Awards\/[^"']+\.pdf)["']/i) || [])[1] || '';
    const doCell = (tr.match(/_lblDeliveryOrder"[^>]*>([\s\S]*?)<br>/) || [])[1] || '';
    const order = clean(doCell).split(/\s*Â?»/)[0].trim();
    rows.push({
      contract, order,
      counter: span(tr, 'lblDeliveryOrderCounter'),
      modDate: usToIso(span(tr, 'lblLastModPostingDate')),
      cage: span(tr, 'lblCage'),
      total: money(span(tr, 'lblTotalContactPrice')),
      awardDate: usToIso(span(tr, 'lblAwardDate')),
      posted: usToIso(span(tr, 'lblPostedDate')),
      nsn: span(tr, 'lblNsn').replace(/-/g, ''),
      nom: span(tr, 'lblNomenclature'),
      pr: span(tr, 'lblPurchaseRequest'),
      sol: span(tr, 'lblSolicitation'),
      pdf,
    });
  }
  const pages = Math.max(1, ...[...html.matchAll(/Page\$(\d+)/g)].map((x) => +x[1]));
  const total = +((html.match(/Records Found:\s*(?:<[^>]*>\s*)*([\d,]+)/i) || [])[1] || '0').replace(/,/g, '');
  return { rows, pages, total };
}

function hiddenFields(html) {
  const f = new URLSearchParams();
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]*)"/)?.[1];
    const value = m[0].match(/value="([^"]*)"/)?.[1] ?? '';
    if (name) f.set(name, value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }
  return f;
}

async function postBack(url, html, target, arg) {
  const f = hiddenFields(html);
  f.set('__EVENTTARGET', target);
  f.set('__EVENTARGUMENT', arg);
  await sleep(400);
  const res = await raw(url, { method: 'POST', body: f.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: url } });
  if (res.status >= 400) throw new Error(`postback HTTP ${res.status}`);
  return res.body.toString('latin1');
}

async function awardsForDate(iso) {
  const [y, m, d] = iso.split('-');
  const url = `${DIBBS}/Awards/AwdRecs.aspx?Category=awddt&TypeSrch=cq&Value=${m}-${d}-${y}`;
  let html = await get(url);
  const first = parseAwardPage(html);
  log(iso, `page 1: ${first.rows.length} rows, ${first.total} total`);
  const rows = [...first.rows];
  for (let p = 2; p <= first.pages; p++) {
    html = await postBack(url, html, 'ctl00$cph1$grdAwardSearch', `Page$${p}`);
    const pg = parseAwardPage(html);
    log(iso, `page ${p}: ${pg.rows.length} rows`);
    rows.push(...pg.rows);
    if (pg.pages > first.pages) first.pages = pg.pages; // pager shows a window of pages
  }
  log(iso, `${rows.length} of ${first.total} awards`);
  return rows;
}

// Read quantity / unit / unit price from an award PDF. Accepts a line only when
// qty x unit price matches a dollar total on the same line (within rounding).
export function parseLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/([\d,]+(?:\.\d+)?)\s+([A-Z]{2})\s+\$([\d,]+\.\d{2,5})\s+\$([\d,]+\.\d{2})/);
    if (!m) continue;
    const qty = money(m[1]), unit = money(m[3]), tot = money(m[4]);
    if (qty && unit && Math.abs(qty * unit - tot) <= Math.max(0.05, tot * 0.001)) out.push({ qty, ui: m[2], unit, total: tot });
  }
  return out;
}

function pdfText(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awd-'));
  const f = path.join(dir, 'a.pdf');
  fs.writeFileSync(f, buf);
  try { return execFileSync('pdftotext', ['-q', '-layout', f, '-'], { encoding: 'latin1', maxBuffer: 20e6, stdio: ['ignore', 'pipe', 'ignore'] }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Storage: one file per FSC in data/awards/ (so the site only loads what it needs),
// plus data/award-summary.js with per-NSN stats for every NSN on an open RFQ.
// Award row order:
// 0 contract, 1 order, 2 counter, 3 modDate, 4 cage, 5 total, 6 awardDate, 7 posted, 8 nsn, 9 nom, 10 pr, 11 sol, 12 pdf, 13 qty, 14 ui, 15 unit
const DIR = path.resolve('data/awards');
const toRow = (a) => [a.contract, a.order, a.counter, a.modDate, a.cage, a.total, a.awardDate, a.posted, a.nsn, a.nom, a.pr, a.sol, a.pdf, a.qty ?? null, a.ui ?? '', a.unit ?? null];
const key = (r) => `${r[0]}|${r[1]}|${r[2]}|${r[8]}`;
const shard = (nsn) => (/^\d{13}$/.test(nsn) ? nsn.slice(0, 4) : 'other');

function loadAll() {
  const map = new Map();
  if (!fs.existsSync(DIR)) return map;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.js')) continue;
    const t = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const r of JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1))) map.set(key(r), r);
  }
  return map;
}

function saveAll(map) {
  fs.mkdirSync(DIR, { recursive: true });
  const by = new Map();
  for (const r of map.values()) { const s = shard(r[8]); if (!by.has(s)) by.set(s, []); by.get(s).push(r); }
  for (const [s, rows] of by) {
    rows.sort((a, b) => (b[6] || '').localeCompare(a[6] || ''));
    fs.writeFileSync(path.join(DIR, `${s}.js`), `window.AW_LOAD&&AW_LOAD(${JSON.stringify(s)},${JSON.stringify(rows)});\n`);
  }
  return by.size;
}

// Per-NSN stats: [lastUnit, lastCage, lastDate, awardCount, sameWinnerLast3, qtyThisYear, modCount]
export function summarize(rows, year) {
  const byNsn = new Map();
  for (const r of rows) { if (!r[8]) continue; if (!byNsn.has(r[8])) byNsn.set(r[8], []); byNsn.get(r[8]).push(r); }
  const out = {};
  for (const [nsn, list] of byNsn) {
    list.sort((a, b) => (b[6] || '').localeCompare(a[6] || ''));
    const priced = list.find((r) => r[15] > 0 && !(r[5] === 0));
    const last3 = list.slice(0, 3).map((r) => r[4]);
    out[nsn] = [priced ? priced[15] : null, list[0][4], list[0][6], list.length,
      last3.length === 3 && last3.every((c) => c === last3[0]) ? 1 : 0,
      list.filter((r) => (r[6] || '').startsWith(year)).reduce((s, r) => s + (r[13] || 0), 0),
      list.filter((r) => r[3]).length];
  }
  return out;
}

const DONE_FILE = path.resolve('data/award-days.json');
const MINUTES = +(args[args.indexOf('--minutes') + 1] || 0) || 100;

function writeSummary(map, today) {
  let open = new Set();
  try { const t = fs.readFileSync('data/rfqs.js', 'utf8'); open = new Set(JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)).rows.map((r) => r[1])); } catch {}
  const all = summarize([...map.values()], today.slice(0, 4));
  const sum = {};
  for (const nsn of open) if (all[nsn]) sum[nsn] = all[nsn];
  fs.writeFileSync('data/award-summary.js', 'window.AWARD_SUMMARY=' + JSON.stringify({ updated: new Date().toISOString(), total: map.size, n: sum }) + ';\n');
  return Object.keys(sum).length;
}

// Each run has a time budget. Awards are saved after every day, so a run that is
// cut off keeps what it collected, and the next run continues with the days not done yet.
// The 2 most recent days are always re-checked for late postings.
async function main() {
  const t0 = Date.now();
  const left = () => MINUTES * 60e3 - (Date.now() - t0);
  const map = loadAll();
  let done = new Set();
  try { done = new Set(JSON.parse(fs.readFileSync(DONE_FILE, 'utf8'))); } catch {}
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const saveDay = (iso) => {
    done.add(iso);
    saveAll(map);
    fs.writeFileSync(DONE_FILE, JSON.stringify([...done].sort()));
    writeSummary(map, today);
  };

  for (let i = 1; i <= DAYS; i++) {
    const dt = new Date(`${today}T12:00:00Z`); dt.setUTCDate(dt.getUTCDate() - i);
    const iso = dt.toISOString().slice(0, 10);
    if (done.has(iso) && i > 2) continue;
    if (left() < MINUTES * 60e3 * 0.3) { log('time budget reached; remaining days continue next run'); break; }
    try {
      for (const a of await awardsForDate(iso)) {
        const row = toRow(a);
        const old = map.get(key(row));
        if (old) { row[13] = old[13]; row[14] = old[14]; row[15] = old[15]; }
        map.set(key(row), row);
      }
      saveDay(iso);
      log(iso, `saved; ${map.size} awards total`);
    } catch (e) { log(iso, 'failed:', e.message); }
  }

  // Fill quantity / unit price from PDFs, newest first, with the time that's left.
  let hasPdftotext = true;
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { hasPdftotext = false; log('pdftotext not installed; skipping unit prices'); }
  let n = 0;
  const todo = [...map.values()].filter((r) => r[12] && r[15] == null).sort((a, b) => (b[6] || '').localeCompare(a[6] || ''));
  for (const r of hasPdftotext ? todo : []) {
    if (n >= PDF_LIMIT || left() < 60e3) break;
    n++;
    try {
      const lines = parseLines(pdfText(await get(r[12], true)));
      const hit = lines.find((l) => r[5] == null || Math.abs(l.total - r[5]) < 0.05) || lines[0];
      if (hit) { r[13] = hit.qty; r[14] = hit.ui; r[15] = hit.unit; } else r[15] = -1; // -1 = read, no price line found
    } catch (e) { log('pdf failed', r[1] || r[0], e.message); }
    if (n % 100 === 0) { saveAll(map); log(`${n} PDFs read`); }
  }

  const files = saveAll(map);
  const withHist = writeSummary(map, today);
  log(`saved ${map.size} awards in ${files} FSC files; ${withHist} open NSNs have history; ${n} PDFs read`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
