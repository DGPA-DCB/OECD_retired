/* Download actuarial valuation reports of the pension fund, extract the key tables and update config/actuarial.json.
   Runs in GitHub Actions (workflow "更新精算報告"): Node 20 + pdfjs-dist. No AI involved.

   REPORTS env: "latest" (default: the newest report on the website, plus any report newer than what we have),
                "all" (every report from MIN_NO on), or a list such as "8,9".
   A report is written to config/actuarial.json ONLY when every validation rule passes; otherwise the previous
   figures are kept and the problem is recorded in data/raw/actuarial_extract.json for the dashboard to show. */
'use strict';
const fs = require('fs');
const path = require('path');
const { parse, validate } = require('./actuarial-parse.js');

const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'sources.json'), 'utf8').replace(/^﻿/, '')).actuarial;
const dataFile = path.join(root, 'config', 'actuarial.json');
const statusFile = path.join(root, 'data', 'raw', 'actuarial_extract.json');
const MIN_NO = cfg.minNo || 7;      // older reports use a different layout and pre-reform rules

function taipeiNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function decodeHtml(s) { return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

async function listReports() {
  const res = await fetch(cfg.listUrl, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error('list page HTTP ' + res.status);
  const html = await res.text(), re = new RegExp(cfg.pattern), found = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g)) {
    const txt = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ''), hit = txt.match(re);
    if (!hit || !/Download\.ashx|\.pdf/i.test(m[1])) continue;
    const no = +hit[1]; if (!found.has(no)) found.set(no, { no, title: txt, url: new URL(decodeHtml(m[1]), cfg.listUrl).href });
  }
  return [...found.values()].sort((a, b) => a.no - b.no);
}

/** same text reconstruction as the one the parser was developed against: items grouped into lines by y, sorted by x */
async function pdfText(buf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const dist = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), cMapUrl: path.join(dist, 'cmaps') + path.sep, cMapPacked: true,
    standardFontDataUrl: path.join(dist, 'standard_fonts') + path.sep, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent(), rows = {};
    tc.items.forEach(it => { if (!it.str) return; const y = Math.round(it.transform[5] / 3) * 3; (rows[y] = rows[y] || []).push([it.transform[4], it.str]); });
    pages.push(Object.keys(rows).map(Number).sort((a, b) => b - a).map(y => rows[y].sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ')).join('\n'));
  }
  return { text: pages.map((t, i) => `\n=== PAGE ${i + 1} ===\n${t}`).join('\n'), pages: pdf.numPages };
}

(async () => {
  const status = { at: taipeiNow(), listUrl: cfg.listUrl, results: [] };
  let store = { reports: [] };
  if (fs.existsSync(dataFile)) store = JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^﻿/, ''));
  store.reports = store.reports || [];
  let exitCode = 0;
  try {
    const all = await listReports();
    if (!all.length) throw new Error('no report link matched the pattern on the list page (page layout changed?)');
    const latest = all[all.length - 1].no, have = Math.max(0, ...store.reports.map(r => r.no));
    const want = (process.env.REPORTS || 'latest').trim().toLowerCase();
    let targets;
    if (want === 'all') targets = all.filter(r => r.no >= MIN_NO);
    else if (/^[\d,\s]+$/.test(want)) { const ns = want.split(',').map(s => +s.trim()); targets = all.filter(r => ns.includes(r.no)); }
    else targets = all.filter(r => r.no === latest || r.no > have);
    console.log(`website latest: #${latest}; stored latest: #${have}; extracting: ${targets.map(r => '#' + r.no).join(', ') || '(none)'}`);
    status.latestNo = latest;
    for (const r of targets) {
      const res = { no: r.no, title: r.title, url: r.url, status: 'failed', errors: [] };
      try {
        const pdf = await fetch(r.url, { signal: AbortSignal.timeout(300000) });
        if (!pdf.ok) throw new Error('PDF HTTP ' + pdf.status);
        const buf = Buffer.from(await pdf.arrayBuffer());
        if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('downloaded file is not a PDF');
        const { text, pages } = await pdfText(buf);
        res.pages = pages; res.chars = text.length;
        if (text.length < 20000) throw new Error('PDF has almost no text layer (scanned document?)');
        const a = parse(text), errors = validate(a);
        if (a.no !== r.no) errors.unshift(`報告內文為第 ${a.no} 次精算，與網站連結標示的第 ${r.no} 次不符`);
        res.errors = errors; res.notes = a.notes;
        if (!errors.length) {
          delete a.notes;
          const rec = Object.assign(a, { title: r.title, url: r.url, extractedAt: status.at, method: 'auto' });
          store.reports = store.reports.filter(x => x.no !== r.no).concat([rec]).sort((x, y) => x.no - y.no);
          res.status = 'ok';
        }
      } catch (e) { res.errors.push(String(e && e.message || e)); }
      console.log(`#${r.no}: ${res.status}${res.errors.length ? '\n  - ' + res.errors.join('\n  - ') : ''}`);
      if (res.status !== 'ok') exitCode = 1;
      status.results.push(res);
    }
  } catch (e) { status.error = String(e && e.message || e); console.log('ERROR: ' + status.error); exitCode = 1; }
  if (!store._說明) store = Object.assign({ _說明: '退撫基金歷次精算報告的關鍵數字，由「更新精算報告」工作流程（scripts/actuarial-extract.js）自動擷取並通過驗算後寫入。陣列順序：公務人員、教育人員、軍職人員；金額單位：億元；年度為民國年。請勿手動修改，重新擷取會覆蓋。' }, store);
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n', 'utf8');
  process.exitCode = exitCode;
})();
