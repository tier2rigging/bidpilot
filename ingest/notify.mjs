#!/usr/bin/env node
// BidPilot — new-award alerts.
// After the daily award collection, opens one GitHub issue (label "award") for every award to
// your CAGE that hasn't been announced yet. GitHub emails new issues to everyone watching the repo,
// so you hear about wins even when DLA's own email doesn't arrive.
//
//   node ingest/notify.mjs            # needs GITHUB_TOKEN and GITHUB_REPOSITORY (set automatically in Actions)
//   node ingest/notify.mjs --dry-run  # print what would be sent, change nothing
//
// data/my-awards-notified.json remembers what was announced. Existing issues are also checked by
// title, so an award is never announced twice even if that file wasn't committed.

import fs from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const STATE = 'data/my-awards-notified.json';
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'tier2rigging/bidpilot';
const SITE = 'https://bidpilot.tier2rigging.com';
const DIBBS = 'https://www.dibbs.bsm.dla.mil';

const fmtNsn = (n) => (/^\d{13}$/.test(n) ? `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 9)}-${n.slice(9)}` : n || '');
const usd = (n) => (n == null || n < 0 ? '' : '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cleanId = (s) => String(s || '').split(/\s*(?:&raquo;|Â?»)/)[0].trim();
const idOf = (a) => `${cleanId(a[0])}|${cleanId(a[1])}`;

function loadMine() {
  const t = fs.readFileSync('data/my-awards.js', 'utf8');
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bidpilot' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status >= 400 && !(method === 'POST' && path === '/labels' && res.status === 422)) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

function issueFor(a) {
  const contract = cleanId(a[0]), order = cleanId(a[1]);
  const num = order ? `${contract} / ${order}` : contract;
  const qty = a[13] != null ? `${a[13]} ${a[14] || ''}`.trim() : '';
  const rows = [
    ['Contract', num], ['Award date', a[6]], ['Delivery due', a[16] || 'check the award PDF'],
    ['NSN', fmtNsn(a[8])], ['Item', a[9]], ['Qty', qty], ['Unit price', usd(a[15])], ['Total', usd(a[5])],
    ['Purchase request', a[10]], ['Solicitation', a[11]], ['CAGE', a[4]],
  ].filter(([, v]) => v);
  return {
    title: `New DLA award: ${num} · ${a[9] || fmtNsn(a[8])} · ${usd(a[5])}`,
    body: [
      `**DLA awarded CAGE ${a[4]} a new order.**`, '',
      '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '/')} |`), '',
      (a[12] ? `[Award PDF](${a[12]}) · ` : '') +
      `[Award package on DIBBS](${DIBBS}/Awards/AwdRec.aspx?contract=${encodeURIComponent(contract)}&dlv=${encodeURIComponent(order)}&cnt=${encodeURIComponent(a[2] || '')}) · [Open in BidPilot → Manage → Orders](${SITE})`, '',
      'Next: order from your supplier (BidPilot → Orders → Create PO), check packaging and marking, ship, then invoice in WAWF. Close this issue when you\'ve got it.',
    ].join('\n'),
    labels: ['award'],
  };
}

async function main() {
  const mine = loadMine();
  let sent = [];
  try { sent = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  const done = new Set(sent);
  const fresh = (mine.rows || []).filter((a) => !done.has(idOf(a)));
  if (!fresh.length) { console.log('No new awards to announce.'); return; }

  if (DRY || !TOKEN) {
    if (!TOKEN && !DRY) console.log('GITHUB_TOKEN not set; showing what would be sent.');
    for (const a of fresh) { const i = issueFor(a); console.log(`\n--- ${i.title}\n${i.body}`); }
    return;
  }

  await gh('POST', '/labels', { name: 'award', color: '1a7f37', description: 'New DLA award to your CAGE' });
  const existing = (await gh('GET', '/issues?labels=award&state=all&per_page=100')) || [];
  for (const a of fresh) {
    const issue = issueFor(a);
    const contract = cleanId(a[0]), order = cleanId(a[1]);
    const dup = existing.find((x) => x.title.includes(order ? `${contract} / ${order}` : `${contract} ·`));
    if (dup) console.log(`Already announced: #${dup.number} ${dup.title}`);
    else { const r = await gh('POST', '/issues', issue); console.log(`Announced: #${r.number} ${issue.title}`); }
    done.add(idOf(a));
    fs.writeFileSync(STATE, JSON.stringify([...done].sort(), null, 0) + '\n');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
