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

// DIBBS RFQ NSN page (public view): nomenclature, AMSC, approved sources, and the solicitations
// DIBBS still lists for the NSN (PR, qty, issue, return-by). A listed solicitation is still active.
const txt = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const usIso = (s) => { const m = (s || '').match(/(\d{2})-(\d{2})-(\d{4})/); return m ? `${m[3]}-${m[1]}-${m[2]}` : ''; };
export function parseNsnPage(html) {
  const out = { nom: '', amsc: '', as: [], sols: [] };
  const t = txt(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
  out.nom = (t.match(/Nomenclature:\s*(.+?)\s+AMSC:/) || [])[1] || '';
  out.amsc = (t.match(/AMSC:\s*([A-Z0-9])\b/) || [])[1] || '';
  let inSol = false;
  for (const chunk of html.split(/<tr[\s>]/i).slice(1)) {
    const tds = [...chunk.split(/<\/tr>/i)[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => txt(m[1]));
    if (!tds.length) continue;
    if (/^Solicitation #/.test(tds[0])) { inSol = true; continue; }
    const s = tds[0].replace(/-/g, '');
    if (/^SP[A-Z0-9]{4}\d{2}[A-Z][A-Z0-9]{4}$/.test(s)) {
      const dates = tds.filter((x) => /^\d{2}-\d{2}-\d{4}$/.test(x));
      const pr = tds.find((x) => /^\d{10}$/.test(x)) || '';
      const qty = tds.slice(tds.indexOf(pr) + 1).find((x) => /^\d+$/.test(x));
      if (!out.sols.find((x) => x.sol === s)) out.sols.push({ sol: s, pr, qty: qty ? +qty : null, issue: usIso(dates[0]), ret: usIso(dates[1]) });
    } else if (!inSol && /^[0-9A-Z]{5}$/.test(tds[0]) && tds.length >= 2 && tds[1]) {
      out.as.push([tds[0], tds[1], tds[2] || '']);
    }
  }
  if (!out.sols.length) for (const m of t.matchAll(/\b(SP[A-Z0-9]{4}\d{2}[A-Z][A-Z0-9]{4})\b.*?\b(\d{10})\s+(\d+)\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}-\d{2}-\d{4})/g))
    if (!out.sols.find((x) => x.sol === m[1])) out.sols.push({ sol: m[1], pr: m[2], qty: +m[3], issue: usIso(m[4]), ret: usIso(m[5]) });
  return out;
}

async function nsnPage(nsn) {
  const u = `${DIBBS}/RFQ/RFQNsn.aspx?value=${nsn}&category=issue&Scope=all`;
  const __h = await get(u); if (process.env.LK_PROBE) { globalThis.__opts = [...__h.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/gi)].map((m) => [m[1], m[2].trim()]); globalThis.__forms = [...__h.matchAll(/<(?:form|input|select)[^>]*>/gi)].map((m) => m[0]).slice(0, 40); }
  let p = parseNsnPage(__h);
  if (!p.sols.length) { const q = parseNsnPage(await get(u.replace('Scope=all', 'Scope='))); if (q.sols.length) p = q; }
  return p;
}

async function awardsFor(nsn) {
  const tries = [
    `${DIBBS}/Awards/AwdRecs.aspx?Category=nsn&TypeSrch=cq&Value=${nsn}`,
    `${DIBBS}/Awards/AwdRecs.aspx?Category=nsn&TypeSrch=cq&Value=${nsn.slice(0, 4)}-${nsn.slice(4, 6)}-${nsn.slice(6, 9)}-${nsn.slice(9)}`,
  ];
  for (const u of tries) {
    try { const p = parseAwardPage(await get(u)); const r = p.rows.filter((x) => !x.nsn || x.nsn === nsn); if (r.length) return r.slice(0, 25); } catch {}
  }
  return [];
}

async function main() {
  const q = normQ(rawQ);
  if (!SOL_ONLY.test(q) && !NSN_ONLY.test(q)) throw new Error(`"${rawQ}" isn't a solicitation (SPE7L125T04H3) or 13-digit NSN`);
  const out = { q, kind: SOL_ONLY.test(q) ? 'sol' : 'nsn', at: new Date().toISOString(), nsn: '', nom: '', amsc: '', as: [], sols: [], history: [], awards: [], errors: [] };
  const err = (where, e) => { out.errors.push(`${where}: ${e.message || e}`); log(where, 'failed:', e.message || e); };
  const sol = (s) => { let e = out.sols.find((x) => x.sol === s); if (!e) { e = { sol: s, status: '' }; out.sols.push(e); } return e; };

  // NSN page: what DIBBS still lists for this NSN. Listed = still active on DIBBS.
  const readNsn = async (nsn) => {
    try {
      const p = await nsnPage(nsn);
      out.nom = out.nom || p.nom; out.amsc = out.amsc || p.amsc; if (p.as.length) out.as = p.as;
      for (const x of p.sols) Object.assign(sol(x.sol), x, { status: 'Listed' });
    } catch (e) { err('NSN page', e); }
  };

  if (out.kind === 'nsn') { out.nsn = q; await readNsn(q); }
  else sol(q);

  // RFQ PDFs: the looked-up solicitation, or (NSN lookup) the newest few listed ones.
  const pdfSols = out.kind === 'sol' ? [q] : [...out.sols].sort((x, y) => (y.issue || '').localeCompare(x.issue || '')).slice(0, MAX_SOLS).map((x) => x.sol);
  let histText = '';
  for (const s of pdfSols) {
    const e = sol(s);
    try {
      const pdf = await fetchPdf(s);
      if (!pdf) { e.pdfMissing = true; continue; }
      const text = pdfText(pdf.buf);
      if (!out.nsn) out.nsn = nsnFromText(text);
      if (!histText && /Procurement History/i.test(text)) histText = text;
      e.file = pdf.name;
      if (pdf.buf.length <= MAX_PDF) e.pdf = pdf.buf.toString('base64');
      log(s, 'PDF', pdf.name, pdf.buf.length, 'bytes');
    } catch (x) { err(`${s} PDF`, x); }
  }

  if (out.nsn) {
    if (out.kind === 'sol') { await readNsn(out.nsn); if (!sol(q).status) sol(q).status = 'Not listed'; }
    if (histText) { const h = parseHistory(histText).get(out.nsn); if (h) out.history = h; }
    try { out.awards = await awardsFor(out.nsn); } catch (e) { err('awards', e); }
  } else if (out.kind === 'sol') out.errors.push('could not find the NSN (RFQ PDF not available)');
  // Looked-up solicitation first, then listed ones newest first.
  out.sols.sort((x, y) => (y.sol === q) - (x.sol === q) || (y.status === 'Listed') - (x.status === 'Listed') || (y.issue || '').localeCompare(x.issue || ''));

  if (process.env.LK_PROBE) { out.probe = { opts: globalThis.__opts, forms: globalThis.__forms }; for (const u of (process.env.LK_PROBE_URLS || '').split(' ').filter(Boolean)) { try { const h = await get(u); out.probe[u] = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(-1800) + ' PDFS:' + [...h.matchAll(/href=["']([^"']+\.pdf)/gi)].map((m) => m[1]).slice(0, 10).join(' '); } catch (e) { out.probe[u] = 'ERR ' + e.message; } } }
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
