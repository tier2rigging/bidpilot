#!/usr/bin/env node
// BidPilot on-demand lookup: one solicitation or NSN, open or closed.
//
//   node ingest/lookup.mjs --q SPE7L125T04H3
//   node ingest/lookup.mjs --q 5340-01-665-9391
//
// Writes data/lookup/<KEY>.json with:
//   status per solicitation (DIBBS NSN search), the RFQ PDF itself (base64, so the site can
//   read requirements with the same reader as "Read RFQ"), procurement history from the PDF,
//   and recent award records for the NSN. Every part is best-effort; failures are listed in errors.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { get } from './fetch.mjs';
import { parseNsnSearch } from './pastdue.mjs';
import { parseHistory } from './history.mjs';
import { parseAwardPage } from './awards.mjs';

const DIBBS = 'https://www.dibbs.bsm.dla.mil';
const FILES = 'https://dibbs2.bsm.dla.mil';
const DIR = path.resolve('data/lookup');
const KEEP = 40;            // newest lookups kept in the repo
const MAX_SOLS = 4;         // PDFs fetched for an NSN lookup
const MAX_PDF = 4e6;        // skip giant PDFs
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const args = process.argv.slice(2);
const rawQ = args[args.indexOf('--q') + 1] || '';
export const normQ = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const SOL_ONLY = /^SP[A-Z0-9]{4}\d{2}[A-Z][A-Z0-9]{4}$/;
const NSN_ONLY = /^\d{13}$/;

function pdfText(buf) {
  const f = path.join(os.tmpdir(), `lk-${process.pid}-${Date.now()}.pdf`);
  try { fs.writeFileSync(f, buf); return execFileSync('pdftotext', ['-q', '-layout', f, '-'], { encoding: 'latin1', maxBuffer: 50e6, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; } finally { fs.rmSync(f, { force: true }); }
}

async function fetchPdf(sol) {
  // Newest amendment first, then the base file.
  for (const suf of ['-3', '-2', '-1', '']) {
    const name = `${sol}${suf}.PDF`;
    try {
      const buf = await get(`${FILES}/Downloads/RFQ/${sol.slice(-1)}/${name}`, true);
      if (buf && buf.length > 500 && buf.subarray(0, 4).toString() === '%PDF') return { name, buf };
    } catch {}
  }
  return null;
}

const nsnFromText = (t) => {
  const a = t.match(/\b(\d{4})-(\d{2})-(\d{3})-(\d{4})\b/); if (a) return a.slice(1).join('');
  const b = t.match(/NSN\/FSC:\s*(\d{9})\s*\/\s*(\d{4})/i); if (b) return b[2] + b[1];
  return '';
};

const DBG = {};
async function statusFor(nsn) {
  const u = `${DIBBS}/RFQ/RFQNsn.aspx?value=${nsn}&category=issue&Scope=all`;
  let page = await get(u);
  let m = parseNsnSearch(page);
  if (!m.size) { page = await get(u.replace('Scope=all', 'Scope=')); m = parseNsnSearch(page); }
  DBG.status = { n: m.size, sample: [...m].slice(0, 8), text: page.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(-2500) };
  return m; // sol -> status
}

async function awardsFor(nsn) {
  const tries = [
    `${DIBBS}/Awards/AwdRecs.aspx?Category=nsn&TypeSrch=cq&Value=${nsn}`,
    `${DIBBS}/Awards/AwdRecs.aspx?Category=nsn&TypeSrch=cq&Value=${nsn.slice(0, 4)}-${nsn.slice(4, 6)}-${nsn.slice(6, 9)}-${nsn.slice(9)}`,
  ];
  for (const u of tries) {
    try { const html = await get(u); const p = parseAwardPage(html); (DBG.awards = DBG.awards || []).push({ u, rows: p.rows.length, total: p.total, text: html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(-1500) }); const r = p.rows.filter((x) => !x.nsn || x.nsn === nsn); if (r.length) return r.slice(0, 25); } catch (e) { (DBG.awards = DBG.awards || []).push({ u, err: e.message }); }
  }
  return [];
}

async function main() {
  const q = normQ(rawQ);
  if (!SOL_ONLY.test(q) && !NSN_ONLY.test(q)) throw new Error(`"${rawQ}" isn't a solicitation (SPE7L125T04H3) or 13-digit NSN`);
  const out = { q, kind: SOL_ONLY.test(q) ? 'sol' : 'nsn', at: new Date().toISOString(), nsn: '', sols: [], history: [], awards: [], errors: [] };
  const err = (where, e) => { out.errors.push(`${where}: ${e.message || e}`); log(where, 'failed:', e.message || e); };

  let sols = [];
  if (out.kind === 'sol') {
    sols = [q];
  } else {
    out.nsn = q;
    try {
      const st = await statusFor(q);
      const all = [...st.entries()];
      all.sort((a, b) => (b[1] === 'Open') - (a[1] === 'Open'));
      out.sols = all.map(([sol, status]) => ({ sol, status }));
      sols = all.slice(0, MAX_SOLS).map(([s]) => s);
    } catch (e) { err('NSN search', e); }
  }

  let histText = '';
  for (const sol of sols) {
    let e = out.sols.find((x) => x.sol === sol); if (!e) { e = { sol, status: '' }; out.sols.push(e); }
    try {
      const pdf = await fetchPdf(sol);
      if (!pdf) { e.pdfMissing = true; continue; }
      const text = pdfText(pdf.buf);
      if (!out.nsn) out.nsn = nsnFromText(text);
      if (!histText && /Procurement History/i.test(text)) histText = text;
      e.file = pdf.name;
      if (pdf.buf.length <= MAX_PDF) e.pdf = pdf.buf.toString('base64');
      log(sol, 'PDF', pdf.name, pdf.buf.length, 'bytes');
    } catch (x) { err(`${sol} PDF`, x); }
  }

  if (out.nsn) {
    if (out.kind === 'sol') {
      try { const st = await statusFor(out.nsn); const s = st.get(q); out.sols[0].status = s || ''; for (const [sol, status] of st) if (sol !== q) out.sols.push({ sol, status }); } catch (e) { err('status', e); }
    }
    if (histText) { const h = parseHistory(histText).get(out.nsn); if (h) out.history = h; }
    try { out.awards = await awardsFor(out.nsn); } catch (e) { err('awards', e); }
  } else if (out.kind === 'sol') out.errors.push('could not find the NSN (RFQ PDF not available)');

  if (process.env.LK_DEBUG) out.debug = DBG;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${q}.json`), JSON.stringify(out));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => [f, fs.statSync(path.join(DIR, f)).mtimeMs]).sort((a, b) => b[1] - a[1]);
  for (const [f] of files.slice(KEEP)) fs.rmSync(path.join(DIR, f));
  log(`wrote ${q}.json: nsn ${out.nsn || '?'}, ${out.sols.length} solicitations, ${out.history.length} history rows, ${out.awards.length} awards, ${out.errors.length} errors`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  // Still write a result so the site can show the reason instead of waiting forever.
  try { const q = normQ(rawQ) || 'BAD'; fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, `${q}.json`), JSON.stringify({ q, at: new Date().toISOString(), sols: [], history: [], awards: [], errors: [e.message] })); } catch {}
  console.error(e); process.exit(0);
});
