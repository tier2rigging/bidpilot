#!/usr/bin/env node
// BidPilot: procurement history from the RFQ PDFs.
// Every DLA RFQ PDF has a "Procurement History for NSN/FSC" table (CAGE, contract, qty,
// unit cost, award date). This reads it for each open RFQ and keeps it permanently, so
// BidPilot knows the last procurement for an NSN even years back.
//
//   node ingest/history.mjs --minutes 40
//
// Fast path: DIBBS's daily "ca" zip (all of the day's RFQ PDFs in one download).
// Fallback: download RFQ PDFs one at a time for open RFQs not read yet, within the time budget.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { get } from './fetch.mjs';

const DIBBS = 'https://www.dibbs.bsm.dla.mil';
const FILES = 'https://dibbs2.bsm.dla.mil';
const args = process.argv.slice(2);
const MINUTES = +(args[args.indexOf('--minutes') + 1] || 0) || 40;
const DAYS = +(args[args.indexOf('--days') + 1] || 0) || 7;
const DIR = path.resolve('data/hist');
const DONE_FILE = path.resolve('data/hist-done.json');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const t0 = Date.now();
const left = () => MINUTES * 60e3 - (Date.now() - t0);

// ---------- parser ----------
// Rows look like:  2U435    SPE4A627V0601           1.000     107.00000   20261015   N
export function parseHistory(text) {
  const out = new Map(); // nsn -> rows
  const parts = text.split(/Procurement History for NSN\/FSC:\s*/i).slice(1);
  for (const part of parts) {
    const h = part.match(/^(\d{9})\s*\/\s*(\d{4})/);
    if (!h) continue;
    const nsn = h[2] + h[1];
    const rows = out.get(nsn) || [];
    for (const line of part.split(/\r?\n/).slice(1, 80)) {
      if (/Procurement History/i.test(line)) break;
      const m = line.match(/^\s*([0-9A-Z]{5})\s+([0-9A-Z]{8,25})\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+(\d{8})\s+([YN])?\s*$/);
      if (!m) continue;
      const d = m[5];
      rows.push([m[1], m[2], +m[3].replace(/,/g, ''), +m[4].replace(/,/g, ''), `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, m[6] || '']);
    }
    out.set(nsn, rows);
  }
  return out;
}

function pdfText(file) {
  try { return execFileSync('pdftotext', ['-q', '-layout', file, '-'], { encoding: 'latin1', maxBuffer: 50e6, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

// ---------- storage ----------
const shard = (nsn) => (/^\d{13}$/.test(nsn) ? nsn.slice(0, 4) : 'other');
function loadAll() {
  const m = new Map();
  if (!fs.existsSync(DIR)) return m;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.js')) continue;
    const t = fs.readFileSync(path.join(DIR, f), 'utf8');
    try { for (const [k, v] of Object.entries(JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)))) m.set(k, v); } catch {}
  }
  return m;
}
function merge(map, nsn, rows) {
  const have = map.get(nsn) || [];
  const seen = new Set(have.map((r) => `${r[1]}|${r[4]}|${r[2]}`));
  for (const r of rows) { const k = `${r[1]}|${r[4]}|${r[2]}`; if (!seen.has(k)) { have.push(r); seen.add(k); } }
  have.sort((a, b) => b[4].localeCompare(a[4]));
  map.set(nsn, have);
}
function saveAll(map, openNsn) {
  fs.mkdirSync(DIR, { recursive: true });
  const by = {};
  for (const [nsn, rows] of map) (by[shard(nsn)] = by[shard(nsn)] || {})[nsn] = rows;
  for (const [s, obj] of Object.entries(by)) fs.writeFileSync(path.join(DIR, `${s}.js`), `window.HIST_LOAD&&HIST_LOAD(${JSON.stringify(s)},${JSON.stringify(obj)});\n`);
  // Summary for open NSNs: [lastDate, lastUnit, lastCage, count, sameWinnerLast3, distinctCages]
  const n = {};
  for (const nsn of openNsn) {
    const rows = map.get(nsn);
    if (!rows) continue;
    if (!rows.length) { n[nsn] = ['', null, '', 0, 0, 0]; continue; }
    const l3 = rows.slice(0, 3).map((r) => r[0]);
    n[nsn] = [rows[0][4], rows[0][3], rows[0][0], rows.length, l3.length === 3 && l3.every((c) => c === l3[0]) ? 1 : 0, new Set(rows.map((r) => r[0])).size];
  }
  fs.writeFileSync('data/hist-summary.js', 'window.HIST_SUMMARY=' + JSON.stringify({ updated: new Date().toISOString(), n }) + ';\n');
  return Object.keys(n).length;
}

// ---------- main ----------
async function main() {
  const t = fs.readFileSync('data/rfqs.js', 'utf8');
  const rfq = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  const bySol = new Map(); // sol -> {file, nsns:Set}
  for (const r of rfq.rows) {
    const e = bySol.get(r[0]) || { file: r[14], nsns: new Set() };
    e.nsns.add(r[1]); bySol.set(r[0], e);
  }
  const openNsn = new Set(rfq.rows.map((r) => r[1]));
  const map = loadAll();
  let done = { sols: [], days: [] };
  try { done = JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')); } catch {}
  const doneSols = new Set(done.sols || []), doneDays = new Set(done.days || []);
  let hasPdftotext = true;
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { hasPdftotext = false; }
  if (!hasPdftotext) { log('pdftotext not installed; skipping'); return; }

  const absorb = (sol, text) => {
    for (const [nsn, rows] of parseHistory(text)) merge(map, nsn, rows);
    // An RFQ PDF with no history table still counts as read: record empty history for its NSNs.
    const e = bySol.get(sol);
    if (e) for (const nsn of e.nsns) if (!map.has(nsn)) map.set(nsn, []);
    doneSols.add(sol);
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));

  // Fast path: the day's "ca" zip of all RFQ PDFs.
  try {
    const list = await get(`${DIBBS}/RFQ/RFQDates.aspx?category=recent`);
    const ca = [...list.matchAll(/href=["']([^"']*\/ca(\d{6})\.zip)["']/gi)].map((m) => ({ url: new URL(m[1], DIBBS).href, day: m[2] }))
      .sort((a, b) => b.day.localeCompare(a.day)).slice(0, DAYS);
    for (const { url, day } of ca) {
      if (doneDays.has(day)) continue;
      if (left() < MINUTES * 60e3 * 0.4) break;
      try {
        const zf = path.join(tmp, `ca${day}.zip`), xd = path.join(tmp, `ca${day}`);
        fs.writeFileSync(zf, await get(url, true));
        fs.mkdirSync(xd, { recursive: true });
        execFileSync('unzip', ['-o', '-q', zf, '-d', xd], { stdio: 'ignore' });
        let n = 0;
        const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.pdf$/i.test(f)) { absorb(f.replace(/\.pdf$/i, '').toUpperCase(), pdfText(p)); n++; } } };
        walk(xd);
        fs.rmSync(xd, { recursive: true, force: true }); fs.rmSync(zf, { force: true });
        if (n) doneDays.add(day);
        log(`ca${day}.zip: ${n} RFQ PDFs read`);
      } catch (e) { log(`ca${day}.zip skipped: ${e.message}`); }
    }
  } catch (e) { log('ca zip list failed:', e.message); }

  // Fallback: open RFQs not read yet, soonest-closing first, one PDF at a time.
  const todo = [...bySol.entries()].filter(([sol]) => !doneSols.has(sol));
  const closing = new Map(rfq.rows.map((r) => [r[0], r[8] || '']));
  todo.sort((a, b) => (closing.get(a[0]) || '').localeCompare(closing.get(b[0]) || ''));
  let n = 0;
  for (const [sol, e] of todo) {
    if (left() < 60e3) break;
    const name = (e.file || `${sol}.pdf`).toUpperCase();
    try {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, await get(`${FILES}/Downloads/RFQ/${sol.slice(-1)}/${name}`, true));
      absorb(sol, pdfText(f)); fs.rmSync(f, { force: true }); n++;
      if (n % 100 === 0) { saveAll(map, openNsn); log(`${n} RFQ PDFs read one by one`); }
    } catch (err) { if (n < 5) log('pdf failed', sol, err.message); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  const nSum = saveAll(map, openNsn);
  // Keep the done list to open solicitations plus recent days.
  const openSols = new Set(bySol.keys());
  fs.writeFileSync(DONE_FILE, JSON.stringify({ sols: [...doneSols].filter((s) => openSols.has(s)), days: [...doneDays].sort().slice(-60) }));
  log(`history: ${map.size} NSNs stored, ${nSum} open NSNs covered, ${todo.length - n} open RFQs still to read`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
