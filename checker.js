/* Deklaro — інтерфейс перевірки. Уся логіка — у checker-core.js. Нічого не надсилається. */
(function () {
  'use strict';
  var C = window.DeklaroCore;
  var $ = function (id) { return document.getElementById(id); };
  var form = $('checkForm'), area = $('invoice'), out = $('results');
  var FIELDS = ['invoiceTotal', 'currency', 'incoterms', 'dispatchCountry', 'packingGross', 'packingNet', 'freight', 'insurance', 'rate', 'defaultDuty'];
  var SEV = { error: 'Помилка', warn: 'Увага', info: 'Підказка' };
  var last = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function opts() {
    var o = {};
    FIELDS.forEach(function (f) { o[f] = $(f).value; });
    return o;
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function run() {
    var o = opts();
    var res = C.analyze(area.value, o);
    var pay = res.rows.length ? C.estimatePayments(res.rows, o) : { ok: false, missing: [] };
    last = { res: res, pay: pay, o: o };
    render(res, pay, o);
    out.hidden = false;
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function render(res, pay, o) {
    var cur = esc(o.currency);
    var c = res.counts;
    var verdict = res.level === 'error' ? 'Є помилки, які варто виправити до подачі.'
      : res.level === 'warn' ? 'Критичних помилок немає, але є що перевірити.'
      : 'Явних проблем не знайшли. Все одно покажи документи брокеру.';
    var h = [];

    // Підсумок
    h.push('<div class="card summary">');
    h.push('<div class="score lvl-' + res.level + '" aria-label="Оцінка ' + res.score + ' зі 100"><div>' + res.score + '<small>/100</small></div></div>');
    h.push('<div><h2 style="font-size:1.375rem;margin:0 0 4px">' + esc(verdict) + '</h2>');
    h.push('<p class="muted" style="margin:0">' + res.rows.length + ' ' + plural(res.rows.length, 'позиція', 'позиції', 'позицій'));
    if (res.totals.amount !== null) h.push(' · сума ' + C.fmt(res.totals.amount) + ' ' + cur);
    if (res.totals.gross !== null) h.push(' · брутто ' + C.fmt(res.totals.gross) + ' кг');
    h.push('</p><div class="counts">');
    h.push('<span class="cnt cnt-error">' + c.error + ' ' + plural(c.error, 'помилка', 'помилки', 'помилок') + '</span>');
    h.push('<span class="cnt cnt-warn">' + c.warn + ' ' + plural(c.warn, 'попередження', 'попередження', 'попереджень') + '</span>');
    h.push('<span class="cnt cnt-info">' + c.info + ' ' + plural(c.info, 'підказка', 'підказки', 'підказок') + '</span>');
    h.push('</div>');
    if (res.headers && res.headers.length) {
      h.push('<div class="colmap" aria-label="Знайдені колонки">');
      ['description', 'code', 'origin', 'qty', 'unit', 'price', 'amount', 'net', 'gross', 'currency', 'duty'].forEach(function (k) {
        var idx = res.columns[k];
        if (idx !== undefined) h.push('<span class="pill" title="Колонка «' + esc(res.headers[idx]) + '»">' + esc(C.FIELD_LABELS[k]) + ' ✓</span>');
        else if (['currency', 'duty', 'unit'].indexOf(k) === -1) h.push('<span class="pill missing">' + esc(C.FIELD_LABELS[k]) + ' — немає</span>');
      });
      h.push('</div>');
    }
    h.push('</div></div>');

    // Дії
    if (res.rows.length) {
      h.push('<div class="btn-row"><button type="button" class="btn btn-primary" id="copyBtn">Скопіювати звіт</button>');
      h.push('<button type="button" class="btn btn-secondary" id="csvBtn">Завантажити CSV з виправленими колонками</button></div>');
    }

    // Проблеми
    if (res.issues.length) {
      h.push('<div><h2 style="font-size:1.375rem">Що знайшли</h2><ul class="issues">');
      res.issues.forEach(function (i) {
        h.push('<li class="issue sev-' + i.severity + '"><span class="sev">' + SEV[i.severity] + '</span><div><h3>' + esc(i.title) + '</h3><p>' + esc(i.text) + '</p></div></li>');
      });
      h.push('</ul></div>');
    }

    // Платежі
    if (res.rows.length) {
      h.push('<div class="card"><h2 style="font-size:1.375rem">Орієнтовні платежі</h2>');
      if (pay.ok) {
        h.push('<div class="pay-grid">');
        h.push('<div><div class="k">Митна вартість</div><div class="v">' + C.fmt(pay.valueUAH, 0) + ' грн</div><div class="small muted">' + C.fmt(pay.valueCur) + ' ' + cur + '</div></div>');
        h.push('<div><div class="k">Мито</div><div class="v">' + C.fmt(pay.duty, 0) + ' грн</div></div>');
        h.push('<div><div class="k">ПДВ ' + pay.vatRate + ' %</div><div class="v">' + C.fmt(pay.vat, 0) + ' грн</div></div>');
        h.push('<div><div class="k">Разом</div><div class="v">' + C.fmt(pay.total, 0) + ' грн</div></div>');
        h.push('</div>');
        if (pay.rowsWithoutDuty) h.push('<p class="small" style="margin:10px 0 0;color:var(--warn)">Ставка мита не вказана — мито пораховано як 0. Впиши ставку у формі або колонку «Мито, %».</p>');
        h.push('<p class="small muted" style="margin:10px 0 0">Орієнтовно, без акцизу та інших платежів; перевір у брокера. Митна вартість = сума інвойсу + доставка + страхування, за курсом, який ти ввів. ПДВ = 20 % × (митна вартість + мито).</p>');
      } else {
        h.push('<p class="muted" style="margin:0">Щоб порахувати, впиши ' + esc(pay.missing.join(' і ')) + ' (і ставку мита) у формі вище.</p>');
      }
      h.push('</div>');
    }

    // Таблиця рядків
    if (res.rows.length) {
      var cols = ['code', 'description', 'origin', 'qty', 'unit', 'price', 'amount', 'net', 'gross'];
      var numeric = { qty: 1, price: 1, amount: 1, net: 1, gross: 1 };
      h.push('<div><h2 style="font-size:1.375rem">Позиції</h2><div class="table-wrap" tabindex="0" aria-label="Таблиця позицій, гортається вбік"><table class="rows"><thead><tr><th>#</th>');
      cols.forEach(function (k) { h.push('<th' + (numeric[k] ? ' style="text-align:right"' : '') + '>' + esc(C.FIELD_LABELS[k]) + '</th>'); });
      h.push('</tr></thead><tbody>');
      res.rows.forEach(function (r) {
        var f = res.cellFlags[r.n] || {};
        var worst = Object.keys(f).reduce(function (a, k) { return f[k] === 'error' ? 'error' : (a === 'error' ? a : (f[k] === 'warn' ? 'warn' : a)); }, '');
        h.push('<tr' + (worst ? ' class="r-' + worst + '"' : '') + '><td>' + r.n + '</td>');
        cols.forEach(function (k) {
          var v = r[k];
          var txt = numeric[k] ? (v === null ? '' : C.fmt(v, k === 'qty' && v % 1 === 0 ? 0 : 2)) : v;
          var cls = [];
          if (numeric[k]) cls.push('num');
          if (f[k]) cls.push('c-' + f[k]);
          h.push('<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' + esc(txt) + '</td>');
        });
        h.push('</tr>');
      });
      h.push('</tbody><tfoot><tr><td></td><td colspan="6">Разом</td>');
      h.push('<td class="num">' + C.fmt(res.totals.amount) + '</td><td class="num">' + C.fmt(res.totals.net) + '</td><td class="num">' + C.fmt(res.totals.gross) + '</td></tr></tfoot>');
      h.push('</table></div><p class="small muted" style="margin-top:8px">Підсвічені клітинки — там, де знайшли проблему. Таблицю можна гортати вбік.</p></div>');
    }

    out.innerHTML = h.join('');

    var copy = $('copyBtn'), csv = $('csvBtn');
    if (copy) copy.addEventListener('click', copyReport);
    if (csv) csv.addEventListener('click', downloadCSV);
  }

  function copyReport() {
    if (!last) return;
    var d = new Date();
    var date = ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
    var text = C.buildReport(last.res, last.pay, { date: date, currency: last.o.currency });
    var done = function () { toast('Звіт скопійовано'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text) ? done() : toast('Не вдалося скопіювати'); });
    } else if (fallbackCopy(text)) done(); else toast('Не вдалося скопіювати');
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function downloadCSV() {
    if (!last) return;
    var blob = new Blob([C.toCSV(last.res.rows)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'deklaro-invoice.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('CSV збережено');
  }

  function loadDemo() {
    area.value = C.DEMO_TSV;
    Object.keys(C.DEMO_FORM).forEach(function (k) { if ($(k)) $(k).value = C.DEMO_FORM[k]; });
    syncRateCur();
    toast('Приклад завантажено: у ньому навмисні помилки');
    run();
  }

  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var buf = reader.result;
      var text = new TextDecoder('utf-8').decode(buf);
      // Excel в українській Windows часто зберігає CSV у windows-1251
      if (text.indexOf('�') > -1) {
        try { text = new TextDecoder('windows-1251').decode(buf); } catch (e) { /* лишаємо utf-8 */ }
      }
      area.value = text;
      run();
    };
    reader.readAsArrayBuffer(file);
  }

  function syncRateCur() { $('rateCur').textContent = $('currency').value; }

  form.addEventListener('submit', function (e) { e.preventDefault(); run(); });
  $('demoBtn').addEventListener('click', loadDemo);
  $('clearBtn').addEventListener('click', function () {
    area.value = ''; FIELDS.forEach(function (f) { if (f !== 'currency') $(f).value = ''; });
    out.hidden = true; out.innerHTML = ''; last = null; area.focus();
  });
  $('fileInput').addEventListener('change', function (e) { if (e.target.files[0]) readFile(e.target.files[0]); e.target.value = ''; });
  $('currency').addEventListener('change', syncRateCur);
  if (/[?&#]demo\b/.test(location.search + location.hash)) loadDemo();
})();
