/* Parse the key tables of a pension-fund actuarial valuation report (text extracted from the PDF with pdf.js)
   and validate the result. Pure functions, no dependencies: used by actuarial-extract.js (Node, GitHub Actions)
   and testable in a browser.

   Tables are located by their TITLE (stable across the 7th-9th reports), never by table number.
   Group order in every array: civil servants, teachers, military. Amounts are in NT$ 100 million. */
(function (root) {
  'use strict';
  var GROUPS = ['公務人員', '教育人員', '軍職人員'];
  function squash(s) { return String(s).replace(/\s+/g, ''); }
  /** split a text line into cells (2+ blanks separate cells; single blanks inside a number are PDF artefacts) */
  function cells(line) { return String(line).replace(/ /g, ' ').trim().split(/\s{2,}/).map(squash).filter(function (c) { return c !== ''; }); }
  /** "1,234" -> 1234, "(1,553)" -> -1553, "27%" -> 27, "134年" -> 134, "108/115年" -> 115, "NA" -> null, other -> undefined */
  function num(c) {
    c = squash(c);
    if (/^(NA|N\/A|-|－)$/i.test(c)) return null;
    if (c.indexOf('/') >= 0 && !/^\d{3}\/\d{1,2}\/\d{1,2}$/.test(c)) c = c.split('/').pop();
    if (/^NA$/i.test(c)) return null;
    var neg = /^\(.*\)$/.test(c) || /^-/.test(c);
    var m = c.replace(/[(),]/g, '').replace(/^-/, '').match(/^(\d+(?:\.\d+)?)(%|年|倍|億元|元)?$/);
    if (!m) return undefined;
    return (neg ? -1 : 1) * parseFloat(m[1]);
  }
  function nums(line) { return cells(line).map(num).filter(function (v) { return v !== undefined; }); }
  function r2(v, d) { var f = Math.pow(10, d == null ? 2 : d); return Math.round(v * f) / f; }

  function parse(text) {
    /* NFKC: the PDFs use CJK compatibility ideographs (e.g. U+F961 for U+7387) and full-width digits/punctuation */
    text = String(text).normalize('NFKC');
    var lines = text.split(/\r?\n/);
    var sq = lines.map(squash);
    var out = { no: null, baseDate: null, baseYear: null }, notes = [];
    /** index of the body line carrying a table title (the table-of-contents entry has dot leaders / a page number) */
    function table(re) {
      var hit = -1;
      for (var i = 0; i < lines.length; i++) {
        if (!/^表\d+-\d+/.test(sq[i]) || !re.test(sq[i])) continue;
        if (/\.{3,}/.test(lines[i]) || /\d{2,3}$/.test(sq[i].replace(/50年/g, ''))) continue;
        hit = i;
      }
      return hit;
    }
    function rowAfter(start, re, span) { for (var i = start; i < Math.min(lines.length, start + (span || 40)); i++) if (re.test(sq[i])) return i; return -1; }

    var m = String(text).match(/第\s*(\d+)\s*次\s*精算/); if (m) out.no = +m[1];
    m = String(text).match(/精算基準日[^\d]{0,12}民國\s*([\d\s]+?)年\s*([\d\s]+?)月\s*([\d\s]+?)日/);
    if (m) { out.baseYear = +squash(m[1]); out.baseDate = out.baseYear + ' 年 ' + (+squash(m[2])) + ' 月 ' + (+squash(m[3])) + ' 日'; }

    /* 1. funding status: liability, funded assets, unfunded liability, funded ratio */
    var t = table(/^表\d+-\d+身[分份]別基金提撥狀況彙總表/);
    if (t >= 0) {
      var unit = 1, u = rowAfter(t, /單位/, 4);
      if (u >= 0) { if (/百萬元/.test(sq[u])) unit = 100; else if (/億元/.test(sq[u])) unit = 1; else if (/元/.test(sq[u])) unit = 1e8; }
      out.liab = []; out.funded = []; out.unfunded = []; out.fundedRatio = []; out.payroll = []; out.unfundedToPayroll = [];
      GROUPS.forEach(function (g) {
        var r = rowAfter(t, new RegExp('^' + g), 16), v = r >= 0 ? nums(lines[r]) : [];
        out.liab.push(v.length >= 4 ? r2(v[0] / unit) : null); out.funded.push(v.length >= 4 ? r2(v[1] / unit) : null);
        out.unfunded.push(v.length >= 4 ? r2(v[2] / unit) : null); out.fundedRatio.push(v.length >= 4 ? v[3] : null);
        out.payroll.push(v.length >= 6 ? r2(v[4] / unit) : null); out.unfundedToPayroll.push(v.length >= 6 ? v[5] : null);
      });
      if (out.payroll.some(function (x) { return x == null; })) { delete out.payroll; delete out.unfundedToPayroll; }
    } else notes.push('funding table not found');

    /* 1b. head counts and liability split between benefit recipients and active members (optional) */
    t = table(/^表\d+-\d+身[分份]別精算負債彙總表/);
    if (t >= 0) {
      var rp = rowAfter(t, /^領取給付人員/, 10), ra = rowAfter(t, /^在職人員/, 10);
      var vp = rp >= 0 ? nums(lines[rp]) : [], va = ra >= 0 ? nums(lines[ra]) : [];
      if (vp.length >= 6 && va.length >= 6) {
        out.pensioners = [vp[0], vp[2], vp[4]]; out.pensionerLiab = [vp[1], vp[3], vp[5]];
        out.actives = [va[0], va[2], va[4]]; out.activeLiab = [va[1], va[3], va[5]];
      }
    }

    /* 2. optimal contribution rates vs the current rate */
    t = table(/未提存負債最適提撥率相對現行提撥費?率倍數/);
    if (t >= 0) {
      var pct3 = [];
      for (var i = t + 1; i < Math.min(lines.length, t + 14) && pct3.length < 3; i++) {
        var c = cells(lines[i]).filter(function (x) { return /%$/.test(x); });
        if (c.length === 3) pct3.push(c.map(num));
      }
      if (pct3.length === 3) { out.rateFull = pct3[0]; out.rateNormal = pct3[1]; out.rateNow = pct3[2][0]; }
      else notes.push('rate table: expected 3 rows of 3 percentages, got ' + pct3.length);
    } else notes.push('rate table not found');

    /* 3. investment return needed to stay balanced at the current rate (optional) */
    t = table(/^表\d+-\d+攤提過去負債基礎下最適提撥率彙總表/);
    if (t >= 0) {
      /* components of the full rate for the closed group: amortisation of the unfunded liability + future service cost (optional) */
      var pct3of = function (r) { if (r < 0) return null; var c = cells(lines[r]).filter(function (x) { return /%$/.test(x); }).map(num); return c.length === 3 ? c : null; };
      var am = pct3of(rowAfter(t, /^未提撥精算負債攤[提銷]數/, 6)), sv = pct3of(rowAfter(t, /未來服務成本/, 6));
      if (am && sv) { out.rateAmort = am; out.rateService = sv; }
      var s = rowAfter(t, /應達成之投資/, 14);
      for (var j = s; s >= 0 && j <= s + 3 && !out.needReturn; j++) {
        var seg = j === s ? lines[j].slice(lines[j].indexOf('投資') + 2) : lines[j];
        var p = seg.match(/\d(?:[\d.]| (?=[\d.%]))*\s?%/g);
        if (p && p.length >= 3) out.needReturn = p.slice(-3).map(num);
      }
    }

    /* 4. 50-year projection: year-end balances, first year of continuous deficit, year the balance turns negative */
    t = table(/四類人員未來50年退撫基金之收支分析/);
    if (t >= 0) {
      out.balYears = []; out.bal = [[], [], []];
      for (var k = t + 1; k < Math.min(lines.length, t + 45); k++) {
        var mm = sq[k].match(/^(\d{3})\/12\/31/); if (!mm) continue;
        var v2 = nums(lines[k].replace(/^\s*\d{3}\s*\/\s*12\s*\/\s*31/, ''));
        if (v2.length < 3) { notes.push('balance row ' + mm[1] + ' has ' + v2.length + ' values'); continue; }
        out.balYears.push(+mm[1]); for (var g2 = 0; g2 < 3; g2++) out.bal[g2].push(v2[g2]);
      }
      var d = rowAfter(t, /^基金規模開始/, 45), e = rowAfter(t, /^基金累積餘額開始/, 45);
      var pick = function (r) { if (r < 0) return null; for (var q = r; q <= r + 1; q++) { var c2 = cells(lines[q]).map(num).filter(function (x) { return x !== undefined; }); if (c2.length >= 3) return c2.slice(0, 3); } return null; };
      out.deficit = pick(d); out.exhaust = pick(e);
    } else notes.push('projection table not found');

    /* 5. present value of the pension-reform savings transferred to the fund (optional) */
    t = table(/年金改革挹注款彙總表/);
    if (t >= 0) {
      var tot = rowAfter(t, /^年金改革後節省挹注款$/, 8);
      for (var w0 = tot; tot >= 0 && w0 <= tot + 3 && !out.reformTotal; w0++) { var v0 = nums(lines[w0]).filter(function (x) { return x != null; }); if (v0.length >= 3) out.reformTotal = v0.slice(0, 3); }
      var pv = rowAfter(t, /挹注款現值/, 12);
      for (var w = pv; pv >= 0 && w <= pv + 3 && !out.reformPV; w++) { var v3 = nums(lines[w]).filter(function (x) { return x != null; }); if (v3.length >= 3) out.reformPV = v3.slice(0, 3); }
      var dr = rowAfter(t, /折現率[\d.]+%/, 12); if (dr >= 0) out.discount = parseFloat(sq[dr].match(/折現率([\d.]+)%/)[1]);
    }

    /* 6. government subsidy scenarios (only in reports that analyse them; optional) */
    t = table(/基金不用罄之每年政府撥補金額/);
    if (t >= 0) {
      var keep = [];
      [30, 50].forEach(function (y) { var r = rowAfter(t, new RegExp('^' + y + '年基金不用罄'), 8); var v = r >= 0 ? nums(lines[r].replace(/^\s*\d+\s*年基金不用罄/, '')) : []; if (v.length >= 2) keep.push([y + ' 年基金不用罄', v[0], v[1]]); });
      var gap = [], join = [];
      [/公務新進人員不繼續參加退撫基金致財務缺口之撥補分析/, /教育新進人員不繼續參加退撫基金致財務缺口之撥補分析/].forEach(function (re) {
        var tt = table(re), col = [];
        [10, 15, 20].forEach(function (y) { var r = tt >= 0 ? rowAfter(tt, new RegExp('^分' + y + '年撥補金額'), 30) : -1; var v = r >= 0 ? nums(lines[r].replace(/註\s*\d/g, ' ').replace(/^\s*分\s*\d+\s*年撥補金額/, '')) : []; col.push(v.length ? v[0] : null); });
        gap.push(col);
        var rj = tt >= 0 ? rowAfter(tt, /^繼續之用罄年度/, 30) : -1, vj = rj >= 0 ? nums(lines[rj].replace(/註\s*\d/g, ' ').replace(/^\s*繼續之用罄年度/, '')) : [];
        join.push(vj.length ? vj[0] : null);
      });
      var sub = [];
      [10, 15, 20].forEach(function (y, i2) { if (gap[0][i2] != null && gap[1][i2] != null) sub.push(['補新人缺口：分 ' + y + ' 年', gap[0][i2], gap[1][i2]]); });
      if (sub.length + keep.length) out.subsidy = sub.concat(keep);
      if (join[0] != null && join[1] != null) out.exhaustIfJoin = [join[0], join[1], null];
    }
    out.notes = notes;
    return out;
  }

  /** every rule must hold before the figures may be published; returns a list of human-readable problems */
  function validate(a) {
    var err = [], is = function (v) { return typeof v === 'number' && isFinite(v); };
    var arr3 = function (k, allowNull) { var v = a[k]; if (!Array.isArray(v) || v.length !== 3 || v.some(function (x) { return !(is(x) || (allowNull && x === null)); })) { err.push(k + ' 缺漏或格式不符'); return false; } return true; };
    if (!is(a.no) || a.no < 1 || a.no > 99) err.push('讀不到「第 N 次精算」');
    if (!is(a.baseYear) || a.baseYear < 90 || a.baseYear > 200) err.push('讀不到精算基準日');
    if (arr3('liab') && arr3('funded') && arr3('unfunded') && arr3('fundedRatio')) {
      for (var i = 0; i < 3; i++) {
        if (a.liab[i] <= 0 || a.funded[i] <= 0) err.push(GROUPS[i] + '：精算負債或已提存基金不是正數');
        if (Math.abs(a.liab[i] - a.funded[i] - a.unfunded[i]) > Math.max(0.05, a.liab[i] * 1e-5)) err.push(GROUPS[i] + '：精算負債－已提存 ≠ 未提存（' + a.liab[i] + '、' + a.funded[i] + '、' + a.unfunded[i] + '）');
        if (Math.abs(a.funded[i] / a.liab[i] * 100 - a.fundedRatio[i]) > 0.6) err.push(GROUPS[i] + '：已提存比例與金額不符（表列 ' + a.fundedRatio[i] + '%）');
        if (a.liab[i] < 500 || a.liab[i] > 500000) err.push(GROUPS[i] + '：精算負債 ' + a.liab[i] + ' 億元超出合理範圍，可能單位判讀錯誤');
      }
    }
    if (arr3('rateFull') && arr3('rateNormal')) {
      for (var j = 0; j < 3; j++) {
        if (a.rateFull[j] <= 0 || a.rateFull[j] >= 100 || a.rateNormal[j] <= 0 || a.rateNormal[j] >= 100) err.push(GROUPS[j] + '：最適提撥率不在 0～100% 之間');
        if (a.rateFull[j] < a.rateNormal[j]) err.push(GROUPS[j] + '：攤提費率低於不攤提費率');
      }
    }
    if (!is(a.rateNow) || a.rateNow < 5 || a.rateNow > 30) err.push('現行提撥費率讀取異常');
    var okBal = Array.isArray(a.balYears) && a.balYears.length >= 4 && Array.isArray(a.bal) && a.bal.length === 3 && a.bal.every(function (b) { return b.length === a.balYears.length && b.every(is); });
    if (!okBal) err.push('累積餘額推估表缺漏');
    else {
      for (var k = 1; k < a.balYears.length; k++) if (a.balYears[k] <= a.balYears[k - 1]) err.push('累積餘額推估年度未遞增');
      if (is(a.baseYear) && a.balYears[0] <= a.baseYear) err.push('推估年度早於精算基準日');
    }
    if (arr3('exhaust', true) && okBal) {
      for (var g = 0; g < 3; g++) {
        var b = a.bal[g], x = a.exhaust[g], firstNeg = -1;
        for (var q = 0; q < b.length; q++) if (b[q] < 0) { firstNeg = q; break; }
        if (x === null) { if (firstNeg >= 0) err.push(GROUPS[g] + '：用罄年度為 NA，但推估餘額出現負數'); }
        else {
          if (is(a.baseYear) && (x <= a.baseYear || x > a.baseYear + 60)) err.push(GROUPS[g] + '：用罄年度 ' + x + ' 不合理');
          if (firstNeg < 0) { if (x <= a.balYears[a.balYears.length - 1]) err.push(GROUPS[g] + '：用罄年度 ' + x + ' 與推估餘額（全為正）矛盾'); }
          else if (x > a.balYears[firstNeg] || (firstNeg > 0 && x <= a.balYears[firstNeg - 1])) err.push(GROUPS[g] + '：用罄年度 ' + x + ' 與推估餘額轉負的區間不符');
        }
      }
    }
    if (arr3('deficit', true) && Array.isArray(a.exhaust)) for (var h = 0; h < 3; h++) if (is(a.deficit[h]) && is(a.exhaust[h]) && a.deficit[h] > a.exhaust[h]) err.push(GROUPS[h] + '：收支不足年度晚於用罄年度');
    if (a.pensioners) {
      for (var p = 0; p < 3; p++) {
        if (![a.pensioners[p], a.actives[p], a.pensionerLiab[p], a.activeLiab[p]].every(is) || a.pensioners[p] <= 0 || a.actives[p] <= 0) { err.push(GROUPS[p] + '：人數或分項精算負債讀取異常'); continue; }
        if (Array.isArray(a.liab) && is(a.liab[p]) && Math.abs(a.pensionerLiab[p] + a.activeLiab[p] - a.liab[p]) > 2.5) err.push(GROUPS[p] + '：領取給付人員＋在職人員的精算負債 ≠ 精算負債合計');
      }
    }
    if (a.payroll) for (var y = 0; y < 3; y++) {
      if (!is(a.payroll[y]) || a.payroll[y] <= 0) { err.push(GROUPS[y] + '：涵蓋薪資讀取異常'); continue; }
      if (Array.isArray(a.unfunded) && is(a.unfunded[y]) && is(a.unfundedToPayroll[y]) && Math.abs(a.unfunded[y] / a.payroll[y] * 100 - a.unfundedToPayroll[y]) > 1.5) err.push(GROUPS[y] + '：未提存負債對涵蓋薪資比例與金額不符');
    }
    if (a.rateAmort) for (var z = 0; z < 3; z++) if (![a.rateAmort[z], a.rateService[z]].every(is) || a.rateAmort[z] < 0 || a.rateService[z] <= 0 || a.rateAmort[z] > 100 || a.rateService[z] > 100) err.push(GROUPS[z] + '：費率組成讀取異常');
    ['reformPV', 'reformTotal'].forEach(function (k) { if (a[k] && (a[k].length !== 3 || a[k].some(function (v) { return !is(v) || v <= 0 || v > 100000; }))) err.push(k + ' 讀取異常'); });
    if (a.reformPV && a.reformTotal) for (var q2 = 0; q2 < 3; q2++) if (a.reformPV[q2] > a.reformTotal[q2]) err.push(GROUPS[q2] + '：挹注款現值大於合計數');
    if (a.needReturn && (a.needReturn.length !== 3 || a.needReturn.some(function (v) { return !is(v) || v < 0 || v > 30; }))) err.push('所需投資報酬率讀取異常');
    if (a.subsidy) a.subsidy.forEach(function (r) { if (!is(r[1]) || !is(r[2]) || r[1] <= 0 || r[2] <= 0 || r[1] > 5000 || r[2] > 5000) err.push('撥補金額「' + r[0] + '」讀取異常'); });
    return err;
  }

  var api = { parse: parse, validate: validate, cells: cells, num: num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ActuarialParse = api;
})(typeof self !== 'undefined' ? self : this);
