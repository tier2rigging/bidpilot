// BidPilot RFQ reader: turns a DLA RFQ PDF into a fulfillment requirements sheet.
// Works in the browser (with pdf.js) and in Node (for testing). No data leaves the browser.
(function (root) {
  'use strict';

  // ---------- PDF -> lines (pdf.js text items grouped by row) ----------
  async function pdfToLines(pdfjsLib, data) {
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows = new Map();
      for (const it of tc.items) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5] / 2) * 2; // tolerate tiny baseline shifts
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: it.transform[4], w: it.width, s: it.str });
      }
      for (const y of [...rows.keys()].sort((a, b) => b - a)) {
        const parts = rows.get(y).sort((a, b) => a.x - b.x);
        let line = '', end = null;
        for (const t of parts) {
          if (end !== null) line += t.x - end > 12 ? '   ' : t.x - end > 1.5 ? ' ' : '';
          line += t.s; end = t.x + t.w;
        }
        lines.push(line.replace(/\s+$/, ''));
      }
      lines.push('');
    }
    return lines;
  }

  // ---------- helpers ----------
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  const ymd = (s) => { const m = String(s).match(/(\d{4})\s+([A-Z]{3})\s+(\d{1,2})/); return m && MON[m[2]] ? `${m[1]}-${MON[m[2]]}-${m[3].padStart(2, '0')}` : ''; };
  const isBoiler = (l) => /CONTINUED ON NEXT PAGE|CONTINUATION SHEET|REFERENCE NO\. OF DOCUMENT|^\s*SECTION [A-Z]\s*$|^\s*PAGE \d+ OF \d+|^\s*PR: \d+ PRLI: \d+ CONT|^\s*SP[A-Z0-9]{4}-\d{2}-[A-Z]-[A-Z0-9]{4}\s*$/.test(l);

  const PKG_FIELDS = [
    ['QUP', 'Quantity per unit pack'], ['PRES MTHD', 'Preservation method'], ['CLNG/DRY', 'Cleaning / drying'],
    ['PRESV MAT', 'Preservative material'], ['WRAP MAT', 'Wrapping material'], ['CUSH/DUNN MAT', 'Cushioning / dunnage material'],
    ['CUSH/DUNN THKNESS', 'Cushioning thickness'], ['UNIT CONT', 'Unit container'], ['OPI', 'Optional procedure indicator'],
    ['INTRMDTE CONT', 'Intermediate container'], ['INTRMDTE CONT QTY', 'Intermediate container qty'], ['PACK CODE', 'Pack code'],
    ['PACKING LEVEL', 'Packing level'],
  ];
  const CLAUSES = [
    ['52.246-11', 'Higher-level quality requirement'], ['52.246-15', 'Certificate of Conformance'],
    ['52.209-3', 'First article approval (contractor testing)'], ['52.209-4', 'First article approval (government testing)'],
    ['252.211-7003', 'Item Unique Identification (IUID) marking'], ['252.211-7006', 'Passive RFID tags on shipments'],
    ['252.225-7001', 'Buy American / balance of payments'], ['252.225-7012', 'Berry Amendment (domestic textiles, clothing, etc.)'],
    ['252.225-7009', 'Specialty metals restriction'], ['252.204-7021', 'CMMC (cybersecurity) requirement'], ['252.204-7025', 'CMMC notice'],
    ['52.223-3', 'Hazardous material ID and Safety Data Sheet'], ['252.223-7001', 'Hazard warning labels'],
    ['252.246-7007', 'Counterfeit electronic parts detection'], ['252.232-7006', 'Invoicing through WAWF'],
    ['52.247-34', 'FOB destination'], ['52.247-29', 'FOB origin'],
  ];
  const STDS = [
    [/MIL-STD-129/, 'MIL-STD-129 shipping and storage marking'], [/MIL-STD-2073/, 'MIL-STD-2073 military packaging'],
    [/ASTM D\s?3951/, 'ASTM D3951 commercial packaging'], [/ISPM\s?15|IPPC/, 'ISPM 15 heat-treated wood packaging'],
    [/MIL-STD-130/, 'MIL-STD-130 item marking'], [/MIL-STD-1916/, 'MIL-STD-1916 sampling inspection'],
    [/ISO 9001/, 'ISO 9001 quality system referenced'], [/AS9100/, 'AS9100 quality system referenced'],
  ];

  // ---------- parser ----------
  function parse(lines) {
    const L = lines.map((l) => l.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[ \t]+/g, ' ').replace(/\s+$/, ''));
    const all = L.join('\n');
    const out = { header: {}, items: [], clauses: [], standards: [], notes: [] };
    const H = out.header;

    const sol = all.match(/\b(SP[A-Z0-9]{4}-\d{2}-[A-Z]-[A-Z0-9]{4})\b/); if (sol) H.solicitation = sol[1];
    const findAfter = (re, n, pick) => { const i = L.findIndex((l) => re.test(l)); if (i < 0) return ''; for (let j = i; j < Math.min(L.length, i + n); j++) { const v = pick(L[j]); if (v) return v; } return ''; };
    H.issued = findAfter(/DATE ISSUED/, 4, (l) => ymd(l));
    H.returnBy = findAfter(/BEFORE CLOSE OF BUSINESS/, 6, (l) => ymd(l));
    const buyer = all.match(/Name:\s*(.+?)\s+Buyer Code:\s*(\S+)(?:\s+Tel:\s*([^\n]+?))?(?:\s+Fax:|\n)/); if (buyer) { H.buyer = clean(buyer[1]); H.buyerCode = buyer[2]; H.buyerPhone = clean(buyer[3]); }
    const em = all.match(/Email:\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)/); if (em) H.buyerEmail = em[1];
    const iss = findAfter(/5\. ISSUED BY/, 3, (l) => { const m = l.match(/^\s*(DLA [A-Z ]+?)\s{2,}|^\s*(DLA [A-Z ]+)$/); return m ? clean(m[1] || m[2]) : ''; }); if (iss) H.issuedBy = iss;
    if (/SET-ASIDE/.test(all)) { const sa = all.match(/(?:TOTAL\s+)?(SMALL BUSINESS|HUBZONE|SDVOSB|SERVICE-DISABLED|WOMEN-OWNED|8\(A\))[A-Z ()-]*SET-ASIDE/i); if (sa && !/IS NOT A SMALL BUSINESS SET-ASIDE/.test(sa[0])) H.setAside = clean(sa[0]); }
    if (/FIRST DESTINATION TRANSPORTATION|FDT\) PROGRAM/i.test(all)) out.notes.push('First Destination Transportation (FDT): quote FOB Origin; DLA arranges and pays freight.');
    if (/MASTER SOLICITATION/.test(all)) { const m = all.match(/REVISION\s+(\d+)\s*\(([^)]+)\)/); out.notes.push(`Incorporates the DLA Master Solicitation for Automated Simplified Acquisitions${m ? ` (Revision ${m[1]}, ${m[2]})` : ''}.`); }
    if (/cfolders/i.test(all)) out.notes.push('Technical data (drawings/specs) is on cFolders: https://pcf1x.bsm.dla.mil/cfolders');

    // Section B item blocks start at "NSN/MATERIAL:" after "ITEM DESCRIPTION"
    const starts = [];
    L.forEach((l, i) => { if (/^\s*ITEM DESCRIPTION\s*$/.test(l)) starts.push(i); });
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s], to = s + 1 < starts.length ? starts[s + 1] : L.length;
      const blk = L.slice(Math.max(0, from - 6), to).filter((l) => !isBoiler(l));
      const txt = blk.join('\n');
      const it = { reqCodes: [], approved: [], packaging: [], shipTo: [], parcelTo: [], freightTo: [], markFor: [], transport: [] };
      const nsn = txt.match(/NSN\/MATERIAL:\s*([0-9A-Z]{9,15})/); if (nsn) it.nsn = nsn[1];
      const prm = txt.match(/PR:\s*(\d{10})/); if (prm) it.pr = prm[1];
      const di = blk.findIndex((l) => /^\s*ITEM DESCRIPTION\s*$/.test(l)); if (di >= 0) it.description = clean(blk[di + 1]);
      for (const l of blk) {
        const rc = l.match(/^\s*([RI][A-Z]\d{3}):\s*(.+)$/); if (rc && !/^RA001$/.test(rc[1])) it.reqCodes.push([rc[1], clean(rc[2])]);
        const ap = l.match(/^\s*(.+?)\s+([0-9A-Z]{5})\s+P\/N\s+(\S+)\s*$/); if (ap) it.approved.push([clean(ap[1]), ap[2], ap[3]]);
        if (/^\s*IAW .*DRAWING|^\s*TDP Rev/i.test(l)) it.drawing = (it.drawing ? it.drawing + ' · ' : '') + clean(l);
        if (/SHELF LIFE/i.test(l)) it.shelfLife = clean(l);
        if (/Item Unique Identification|IUID/i.test(l)) it.iuid = clean(l + ' ' + (blk[blk.indexOf(l) + 1] || '')).replace(/\s*(THIS MATERIAL.*)$/, '');
      }
      const sm = txt.match(/SAMPLING:\s*([\s\S]+?)(?:\n\s*\n|Item Unique|THIS MATERIAL|$)/); if (sm) it.sampling = clean(sm[1]).slice(0, 400);
      const clin = txt.match(/^\s*(\d{4})\s+(\d{10})\s+(\d{4})\s+([A-Z]{2})\s+([\d,.]+)/m); if (clin) { it.clin = clin[1]; it.unit = clin[4]; it.qty = +clin[5].replace(/,/g, ''); }
      const g = (re) => { const m = txt.match(re); return m ? clean(m[1]) : ''; };
      it.deliveryDays = g(/DELIVERY \(IN DAYS\):\s*0*(\d+)/);
      it.fob = g(/DELIVER FOB:\s*(ORIGIN|DESTINATION)/);
      it.qtyVariance = g(/QTY VARIANCE:\s*([^\n]+)/);
      it.inspection = g(/INSPECTION POINT:\s*(ORIGIN|DESTINATION)/);
      it.acceptance = g(/ACCEPTANCE POINT:\s*(ORIGIN|DESTINATION)/);
      it.pkgStd = g(/PKGING DATA\s*-\s*([^\n]+)/);
      const pk = (blk.slice(blk.findIndex((l) => /PKGING DATA/.test(l))).slice(0, 8).join(' ')) || '';
      for (const [code, label] of PKG_FIELDS) {
        const re = new RegExp('(?:^|\\s)' + code.replace(/[/()]/g, (c) => '\\' + c) + ':\\s*([A-Z0-9]+)');
        const m = pk.match(re); if (m && !(code === 'INTRMDTE CONT' && /QTY/.test(m[0]))) it.packaging.push([code, label, m[1]]);
      }
      it.marking = g(/(MARKING SHALL BE IN ACCORDANCE WITH [^\n]+)/);
      it.specialMarking = g(/SPECIAL MARKING CODE:\s*([^\n]+)/);
      it.palletization = g(/(PALLETIZATION SHALL BE[^\n]+(?:\n[^\n]*REQUIREMENTS FOR PROCUREMENT)?)/);
      const addr = (re, key) => { const i = blk.findIndex((l) => re.test(l)); if (i < 0) return; for (let j = i + 1; j < Math.min(blk.length, i + 14) && it[key].length < 7; j++) { const l = clean(blk[j]); if (!l || /^\*/.test(l)) continue; if (/:/.test(l) || /^(MARKFOR|RDD|VESSEL|PARCEL|BULK|FREIGHT)\b/.test(l) || /SHIPMENT\.|TRANSPORTATION/.test(l)) break; it[key].push(l); if (/^(US|USA)$/.test(l)) break; } };
      addr(/BULK BREAK POINT:|SHIP TO:/, 'shipTo');
      addr(/PARCEL POST ADDRESS:/, 'parcelTo');
      addr(/FREIGHT SHIPPING ADDRESS:/, 'freightTo');
      addr(/^\s*MARKFOR\s*$/, 'markFor');
      it.packagingNote = g(/^\s*(PACKAGING SHALL BE IN ACCORDANCE WITH [^\n]+)/m);
      it.tcn = g(/\(TCN\)\s*([A-Z0-9]+)/);
      it.rdd = g(/^\s*RDD:\s*([^\n]+)/m);
      it.requiredDelivery = g(/Original Required Delivery Date:\s*([\d/]+)/);
      for (const l of blk) if (!/ADDRESS:\s*$/.test(l) && /SHIP BY|PARCEL POST|TRANSPORTATION SEE|FIRST DEST TRANS|NMCS|EXPEDITE/i.test(l)) it.transport.push(clean(l));
      out.items.push(it);
    }

    for (const [num, label] of CLAUSES) if (all.includes(num)) out.clauses.push([num, label]);
    for (const [re, label] of STDS) if (re.test(all)) out.standards.push(label);
    return out;
  }

  // ---------- plain-text summary (for copy / notes) ----------
  function toText(r) {
    const H = r.header, o = [];
    o.push(`RFQ ${H.solicitation || ''}  issued ${H.issued || '?'}  due ${H.returnBy || '?'}`);
    if (H.buyer) o.push(`Buyer: ${H.buyer} (${H.buyerCode || ''}) ${H.buyerPhone || ''} ${H.buyerEmail || ''}`.trim());
    r.items.forEach((it, i) => {
      o.push('', `LINE ${it.clin || i + 1}: ${it.description || ''}  NSN ${it.nsn || ''}  Qty ${it.qty ?? ''} ${it.unit || ''}`);
      o.push(`Delivery ${it.deliveryDays || '?'} days | FOB ${it.fob || '?'} | Inspection ${it.inspection || '?'} | Acceptance ${it.acceptance || '?'} | Qty variance ${it.qtyVariance || '?'}`);
      if (it.packaging.length) o.push(`Packaging (${it.pkgStd || ''}): ` + it.packaging.map(([c, , v]) => `${c} ${v}`).join(', '));
      if (it.marking) o.push(it.marking + (it.specialMarking ? ` | Special marking ${it.specialMarking}` : ''));
      if (it.palletization) o.push(it.palletization);
      if (it.shipTo.length) o.push('Ship to: ' + it.shipTo.join(', '));
      if (it.tcn) o.push('TCN: ' + it.tcn);
      if (it.transport.length) o.push('Transport: ' + it.transport.join(' / '));
      if (it.approved.length) o.push('Approved parts: ' + it.approved.map(([n, c, p]) => `${n} ${c} P/N ${p}`).join('; '));
      if (it.reqCodes.length) o.push('Quality/tech requirements: ' + it.reqCodes.map(([c, t]) => `${c} ${t}`).join('; '));
      if (it.iuid) o.push('IUID: ' + it.iuid);
      if (it.shelfLife) o.push('Shelf life: ' + it.shelfLife);
    });
    if (r.clauses.length) o.push('', 'Clauses referenced: ' + r.clauses.map(([n, l]) => `${n} ${l}`).join('; '));
    return o.join('\n');
  }

  const api = { pdfToLines, parse, toText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RfqReader = api;
})(typeof window !== 'undefined' ? window : globalThis);
