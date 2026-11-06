/*
 * Deklaro — ядро перевірки інвойсу.
 * Чиста логіка без DOM: працює і в браузері (window.DeklaroCore), і в Node (require).
 * Нічого нікуди не відправляє.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DeklaroCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOL_ROW = 0.005;     // qty × price ≠ amount: 0,5 %
  var TOL_TOTAL = 0.001;   // сума рядків ≠ сума інвойсу: 0,1 %
  var TOL_WEIGHT = 0.01;   // ваги ≠ пакувальний лист: 1 %
  var OUTLIER_SHARE = 0.2; // ціна < 20 % медіани для того ж коду
  var VAT_RATE = 20;

  var INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

  /* ---------- Числа ---------- */

  function parseNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (!s) return null;
    var neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d\-,.]/g, ''));
    s = s.replace(/[\s  ']/g, '').replace(/[^\d,.]/g, '');
    if (!/\d/.test(s)) return null;
    var lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > -1 && ld > -1) {
      if (lc > ld) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lc > -1) {
      var parts = s.split(',');
      s = parts.length > 2 ? parts.join('') : s.replace(',', '.');
    } else if (ld > -1 && s.split('.').length > 2) {
      s = s.replace(/\./g, '');
    }
    var n = Number(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  function fmt(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var d = digits === undefined ? 2 : digits;
    var fixed = Math.abs(n).toFixed(d).split('.');
    var int = fixed[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (n < 0 ? '−' : '') + int + (d ? ',' + fixed[1] : '');
  }

  /* ---------- Таблиця ---------- */

  function detectDelimiter(text) {
    // дивимось на перші 10 непорожніх рядків: над таблицею буває шапка інвойсу без роздільників
    var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(0, 10);
    if (lines.some(function (l) { return l.indexOf('\t') > -1; })) return '\t';
    var counts = { ';': 0, ',': 0 };
    lines.forEach(function (line) {
      var q = false;
      for (var j = 0; j < line.length; j++) {
        var c = line[j];
        if (c === '"') q = !q;
        else if (!q && (c === ';' || c === ',')) counts[c]++;
      }
    });
    return counts[';'] >= counts[','] && counts[';'] > 0 ? ';' : ',';
  }

  function parseTable(text, delimiter) {
    text = String(text || '').replace(/^﻿/, '');
    var d = delimiter || detectDelimiter(text);
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += c;
      } else if (c === '"' && cell.trim() === '') { q = true; cell = ''; }
      else if (c === d) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    row.push(cell); rows.push(row);
    return rows
      .map(function (r) { return r.map(function (x) { return x.trim(); }); })
      .filter(function (r) { return r.some(function (x) { return x !== ''; }); });
  }

  /* ---------- Заголовки ---------- */

  // Порядок важливий: «Ціна за од.» → price, а не unit; «Вага нетто» → net.
  var HEADER_RULES = [
    ['net', /нетто|\bnet\b|net\s*w|nett/],
    ['gross', /брутто|gross|\bg\.?\s*w/],
    ['duty', /мито|пошлин|\bduty\b|duty\s*%|ставк/],
    ['currency', /валют|currency|^curr|^ccy$/],
    ['code', /укт|зед|вэд|\bhs\b|hs\s*code|hts|tariff|^код|\bcode\b|тн\s*вэд/],
    ['origin', /країн|страна|origin|country|походж|происх|made\s*in/],
    ['price', /ціна|цена|price|вартість\s*за|стоимость\s*за|за\s*од|за\s*ед|unit\s*cost|rate/],
    ['amount', /сума|сумма|amount|total|вартість|стоимость|value|разом|итого/],
    ['qty', /к-?сть|кількість|количество|кол-?во|qty|quantity|q-ty|pcs|^шт/],
    ['unit', /^од\.?$|^од\.?\s|одиниц|^ед\.?$|^ед\.?\s|единиц|^units?$|^unit\s*of|^uom|measure/],
    ['description', /опис|назв|наимен|описание|descr|goods|товар|product|item|name|найменув/]
  ];

  var FIELD_LABELS = {
    code: 'Код УКТ ЗЕД', description: 'Опис', origin: 'Країна походження', qty: 'Кількість',
    unit: 'Одиниця', price: 'Ціна за од.', amount: 'Сума', net: 'Нетто, кг', gross: 'Брутто, кг',
    currency: 'Валюта', duty: 'Мито, %'
  };

  function matchHeader(cell) {
    var h = String(cell || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
    if (!h) return null;
    for (var i = 0; i < HEADER_RULES.length; i++) {
      if (HEADER_RULES[i][1].test(h)) return HEADER_RULES[i][0];
    }
    return null;
  }

  function detectColumns(headerRow) {
    var map = {};
    (headerRow || []).forEach(function (cell, idx) {
      var key = matchHeader(cell);
      if (key && map[key] === undefined) map[key] = idx;
    });
    return map;
  }

  function findHeaderRow(table) {
    var best = -1, bestCount = 1;
    for (var i = 0; i < Math.min(table.length, 10); i++) {
      var count = Object.keys(detectColumns(table[i])).length;
      if (count > bestCount) { best = i; bestCount = count; }
    }
    return best;
  }

  /* ---------- Країни ---------- */

  var COUNTRIES = {
    AT: 'австрія австрия austria', BE: 'бельгія бельгия belgium', BG: 'болгарія болгария bulgaria',
    HR: 'хорватія хорватия croatia', CY: 'кіпр кипр cyprus', CZ: 'чехія чехия czechia|czech republic',
    DK: 'данія дания denmark', EE: 'естонія эстония estonia', FI: 'фінляндія финляндия finland',
    FR: 'франція франция france', DE: 'німеччина германия germany|фрн', GR: 'греція греция greece',
    HU: 'угорщина венгрия hungary', IE: 'ірландія ирландия ireland', IT: 'італія италия italy',
    LV: 'латвія латвия latvia', LT: 'литва lithuania', LU: 'люксембург luxembourg', MT: 'мальта malta',
    NL: 'нідерланди нидерланды netherlands holland|голландія|голландия', PL: 'польща польша poland',
    PT: 'португалія португалия portugal', RO: 'румунія румыния romania', SK: 'словаччина словакия slovakia',
    SI: 'словенія словения slovenia', ES: 'іспанія испания spain', SE: 'швеція швеция sweden',
    CH: 'швейцарія швейцария switzerland', NO: 'норвегія норвегия norway', IS: 'ісландія исландия iceland',
    LI: 'ліхтенштейн лихтенштейн liechtenstein',
    GB: 'великобританія великобритания британія uk england|велика британія|united kingdom|great britain',
    CA: 'канада canada', IL: 'ізраїль израиль israel',
    TR: 'туреччина турция turkey türkiye turkiye|турецька республіка',
    GE: 'грузія грузия georgia|сакартвело', ME: 'чорногорія черногория montenegro',
    MK: 'македонія македония macedonia|північна македонія|северная македония|north macedonia',
    MD: 'молдова молдавия moldova',
    CN: 'китай china кнр prc|p.r.c|p.r. china|people\'s republic of china', US: 'сша usa|united states|америка',
    IN: 'індія индия india', VN: 'вʼєтнам в\'єтнам вьетнам vietnam|viet nam', JP: 'японія япония japan',
    KR: 'корея korea|південна корея|южная корея|south korea|republic of korea', TW: 'тайвань taiwan',
    BD: 'бангладеш bangladesh', PK: 'пакистан pakistan', ID: 'індонезія индонезия indonesia',
    TH: 'таїланд таиланд thailand', MY: 'малайзія малайзия malaysia', UA: 'україна украина ukraine'
  };
  var COUNTRY_NAMES = {
    AT: 'Австрія', BE: 'Бельгія', BG: 'Болгарія', HR: 'Хорватія', CY: 'Кіпр', CZ: 'Чехія', DK: 'Данія',
    EE: 'Естонія', FI: 'Фінляндія', FR: 'Франція', DE: 'Німеччина', GR: 'Греція', HU: 'Угорщина',
    IE: 'Ірландія', IT: 'Італія', LV: 'Латвія', LT: 'Литва', LU: 'Люксембург', MT: 'Мальта',
    NL: 'Нідерланди', PL: 'Польща', PT: 'Португалія', RO: 'Румунія', SK: 'Словаччина', SI: 'Словенія',
    ES: 'Іспанія', SE: 'Швеція', CH: 'Швейцарія', NO: 'Норвегія', IS: 'Ісландія', LI: 'Ліхтенштейн',
    GB: 'Велика Британія', CA: 'Канада', IL: 'Ізраїль', TR: 'Туреччина', GE: 'Грузія',
    ME: 'Чорногорія', MK: 'Північна Македонія', MD: 'Молдова', CN: 'Китай', US: 'США', IN: 'Індія',
    VN: 'Вʼєтнам', JP: 'Японія', KR: 'Корея', TW: 'Тайвань', BD: 'Бангладеш', PK: 'Пакистан',
    ID: 'Індонезія', TH: 'Таїланд', MY: 'Малайзія', UA: 'Україна'
  };
  var EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
    'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
  var EFTA = ['CH', 'NO', 'IS', 'LI'];
  var FTA_OTHER = ['GB', 'CA', 'IL', 'TR', 'GE', 'ME', 'MK', 'MD'];

  var countryIndex = null;
  function buildCountryIndex() {
    countryIndex = {};
    Object.keys(COUNTRIES).forEach(function (code) {
      countryIndex[code.toLowerCase()] = code;
      // перша частина до «|» — однослівні назви через пробіл, решта — багатослівні назви цілком
      COUNTRIES[code].split('|').forEach(function (chunk, k) {
        if (k === 0) chunk.split(/\s+/).forEach(function (w) { countryIndex[w] = code; });
        else countryIndex[chunk.trim()] = code;
      });
    });
    countryIndex['eu'] = 'EU'; countryIndex['єс'] = 'EU'; countryIndex['ес'] = 'EU';
    countryIndex['european union'] = 'EU'; countryIndex['європейський союз'] = 'EU';
  }

  function normalizeCountry(v) {
    if (!countryIndex) buildCountryIndex();
    var s = String(v || '').toLowerCase().replace(/ё/g, 'е').replace(/^made\s+in\s+/, '')
      .replace(/[.,;()]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (countryIndex[s]) return countryIndex[s];
    var m = s.match(/^([a-z]{2})\b/);
    if (m && countryIndex[m[1]] && s.length <= 3) return countryIndex[m[1]];
    return null;
  }

  function ftaGroup(code) {
    if (!code) return null;
    if (code === 'EU' || EU.indexOf(code) > -1) return 'ЄС';
    if (EFTA.indexOf(code) > -1) return 'ЄАВТ';
    if (FTA_OTHER.indexOf(code) > -1) return COUNTRY_NAMES[code];
    return null;
  }

  function countryName(code, raw) {
    if (code === 'EU') return 'ЄС';
    return COUNTRY_NAMES[code] || raw;
  }

  /* ---------- Рядки ---------- */

  var TOTAL_ROW = /^(разом|всього|усього|итого|всего|total|grand total|subtotal|sum)(?![\p{L}\p{N}])/iu;

  function normalizeCode(v) { return String(v || '').replace(/[\s.\-]/g, ''); }

  function buildRows(table) {
    var hIdx = findHeaderRow(table);
    if (hIdx < 0) return { headerIndex: -1, columns: {}, rows: [], totalRow: null, headers: [] };
    var cols = detectColumns(table[hIdx]);
    var rows = [], totalRow = null;
    for (var i = hIdx + 1; i < table.length; i++) {
      var r = table[i];
      var get = function (k) { return cols[k] === undefined ? '' : (r[cols[k]] || ''); };
      var desc = get('description'), code = get('code');
      var firstCells = r.slice(0, 3).join(' ').trim();
      if (TOTAL_ROW.test(firstCells) || TOTAL_ROW.test(desc) || (!desc && !code && r.filter(Boolean).length <= 3 && parseNumber(get('amount')) !== null && rows.length)) {
        totalRow = { amount: parseNumber(get('amount')), net: parseNumber(get('net')), gross: parseNumber(get('gross')), line: i + 1 };
        continue;
      }
      var originRaw = get('origin');
      var row = {
        n: rows.length + 1,
        line: i + 1,
        code: code,
        codeDigits: normalizeCode(code),
        description: desc,
        origin: originRaw,
        originCode: normalizeCountry(originRaw),
        qty: parseNumber(get('qty')),
        unit: get('unit'),
        price: parseNumber(get('price')),
        amount: parseNumber(get('amount')),
        net: parseNumber(get('net')),
        gross: parseNumber(get('gross')),
        currency: get('currency').toUpperCase(),
        duty: parseNumber(get('duty')),
        derived: {}
      };
      if (row.amount === null && row.qty !== null && row.price !== null) { row.amount = round2(row.qty * row.price); row.derived.amount = true; }
      if (row.price === null && row.qty && row.amount !== null) { row.price = row.amount / row.qty; row.derived.price = true; }
      rows.push(row);
    }
    return { headerIndex: hIdx, columns: cols, rows: rows, totalRow: totalRow, headers: table[hIdx] };
  }

  /* ---------- Перевірки ---------- */

  var GENERIC = ['товар', 'товари', 'товары', 'goods', 'parts', 'part', 'spare', 'spareparts', 'запчастини',
    'запчастина', 'запчасти', 'запчасть', 'items', 'item', 'product', 'products', 'accessories', 'accessory',
    'аксесуари', 'аксессуары', 'комплектуючі', 'комплектующие', 'sample', 'samples', 'зразки', 'образцы',
    'різне', 'разное', 'misc', 'other', 'others', 'інше', 'прочее', 'продукція', 'продукция', 'вироби',
    'изделия', 'матеріали', 'материалы', 'material', 'materials', 'cargo', 'вантаж', 'груз', 'general',
    'merchandise', 'stuff', 'equipment', 'обладнання', 'оборудование', 'tools', 'інструменти', 'and', 'та', 'і', 'и'];

  function words(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  }

  function median(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function relDiff(a, b) {
    var base = Math.max(Math.abs(a), Math.abs(b));
    return base === 0 ? 0 : Math.abs(a - b) / base;
  }

  function sum(rows, key) {
    var s = 0, any = false;
    rows.forEach(function (r) { if (r[key] !== null && r[key] !== undefined) { s += r[key]; any = true; } });
    return any ? round2(s) : null;
  }

  function analyze(text, opts) {
    opts = opts || {};
    var table = parseTable(text);
    var parsed = buildRows(table);
    var rows = parsed.rows, cols = parsed.columns;
    var issues = [];
    var cellFlags = {}; // n -> {field: severity}
    var rank = { error: 3, warn: 2, info: 1 };

    function flag(row, field, sev) {
      if (!row) return;
      var f = cellFlags[row.n] || (cellFlags[row.n] = {});
      if (!f[field] || rank[sev] > rank[f[field]]) f[field] = sev;
    }
    function add(sev, id, title, text, rowsAffected, field) {
      var ns = (rowsAffected || []).map(function (r) { return r.n; });
      issues.push({ severity: sev, id: id, title: title, text: text, rows: ns, field: field || null });
      (rowsAffected || []).forEach(function (r) { flag(r, field || '_row', sev); });
    }
    function rowList(rs) {
      var ns = rs.map(function (r) { return r.n; });
      return (ns.length === 1 ? 'Рядок ' : 'Рядки ') + (ns.length > 8 ? ns.slice(0, 8).join(', ') + ' і ще ' + (ns.length - 8) : ns.join(', '));
    }

    if (!table.length) {
      add('error', 'EMPTY', 'Таблиця порожня', 'Встав таблицю інвойсу з Excel (разом із рядком заголовків) або завантаж CSV.');
      return finish();
    }
    if (parsed.headerIndex < 0) {
      add('error', 'NO_HEADER', 'Не знайшли заголовки колонок',
        'Скопіюй таблицю разом із рядком заголовків: «Опис», «Код УКТ ЗЕД», «Країна походження», «Кількість», «Ціна», «Сума», «Нетто», «Брутто».');
      return finish();
    }
    if (!rows.length) {
      add('error', 'NO_ROWS', 'Немає рядків з товарами', 'Під заголовками не знайшли жодної позиції.');
      return finish();
    }

    // 1. Колонки
    var required = ['description', 'code', 'origin', 'qty'];
    var missing = required.filter(function (k) { return cols[k] === undefined; });
    if (cols.price === undefined && cols.amount === undefined) missing.push('amount');
    if (missing.length) {
      add('error', 'MISSING_COLUMNS', 'Бракує обовʼязкових колонок',
        'Не знайшли: ' + missing.map(function (k) { return FIELD_LABELS[k]; }).join(', ') +
        '. Без них декларацію не заповнити. Якщо колонка є, перейменуй заголовок (наприклад, «Країна походження» або «Origin»).');
    }
    var missingWeights = ['net', 'gross'].filter(function (k) { return cols[k] === undefined; });
    if (missingWeights.length) {
      add('warn', 'MISSING_WEIGHTS', 'Немає ваг по позиціях',
        'Не знайшли: ' + missingWeights.map(function (k) { return FIELD_LABELS[k]; }).join(', ') +
        '. Вагу нетто і брутто вказують для кожного товару в декларації — попроси їх у постачальника або візьми з пакувального листа.');
    }
    if (cols.amount === undefined && cols.price !== undefined && cols.qty !== undefined) {
      add('info', 'AMOUNT_DERIVED', 'Суму порахували самі', 'Колонки «Сума» немає — порахували її як кількість × ціна.');
    }

    // 2. Кількість × ціна = сума
    if (cols.qty !== undefined && cols.price !== undefined && cols.amount !== undefined) {
      var bad = rows.filter(function (r) {
        if (r.qty === null || r.price === null || r.amount === null) return false;
        var calc = r.qty * r.price;
        return Math.abs(calc - r.amount) > Math.max(0.01, Math.abs(r.amount) * TOL_ROW);
      });
      bad.forEach(function (r) {
        add('error', 'QTY_PRICE', 'Кількість × ціна ≠ сума',
          'Рядок ' + r.n + ': ' + fmt(r.qty, r.qty % 1 ? 2 : 0) + ' × ' + fmt(r.price) + ' = ' + fmt(r.qty * r.price) +
          ', а в інвойсі ' + fmt(r.amount) + '. Різниця ' + fmt(r.amount - r.qty * r.price) +
          '. Попроси постачальника виправити інвойс — митниця звіряє ці цифри.', [r], 'amount');
      });
    }
    var badNums = rows.filter(function (r) { return cols.qty !== undefined && r.qty === null || (r.amount === null && r.price === null); });
    if (badNums.length) {
      add('warn', 'BAD_NUMBERS', 'Не вдалося прочитати числа', rowList(badNums) + ': порожня або нечислова кількість, ціна чи сума.', badNums, '_row');
    }

    // 3. Сума рядків vs сума інвойсу
    var rowsTotal = sum(rows, 'amount');
    var invoiceTotal = parseNumber(opts.invoiceTotal);
    var totalSource = 'форми';
    if (invoiceTotal === null && parsed.totalRow && parsed.totalRow.amount !== null) {
      invoiceTotal = parsed.totalRow.amount; totalSource = 'рядка «Разом»';
    }
    if (parsed.totalRow) {
      add('info', 'TOTAL_ROW', 'Рядок «Разом» не рахуємо як товар',
        'Знайшли підсумковий рядок (рядок ' + parsed.totalRow.line + ' таблиці) — використали його лише для звірки.');
    }
    if (invoiceTotal !== null && rowsTotal !== null) {
      if (Math.abs(rowsTotal - invoiceTotal) > Math.max(0.01, invoiceTotal * TOL_TOTAL)) {
        add('error', 'TOTAL_MISMATCH', 'Сума позицій ≠ сума інвойсу',
          'Позиції разом: ' + fmt(rowsTotal) + ', а загальна сума (з ' + totalSource + '): ' + fmt(invoiceTotal) +
          '. Різниця ' + fmt(rowsTotal - invoiceTotal) + '. Знайди рядок з помилкою або уточни в постачальника.');
      }
    } else if (invoiceTotal === null) {
      add('info', 'NO_INVOICE_TOTAL', 'Не вказана загальна сума інвойсу',
        'Впиши її у формі — так перевіримо, чи сходяться позиції з підсумком.');
    }

    // 4. Нетто > брутто
    rows.forEach(function (r) {
      if (r.net !== null && r.gross !== null && r.net > r.gross) {
        add('error', 'NET_GT_GROSS', 'Нетто більше за брутто',
          'Рядок ' + r.n + ': нетто ' + fmt(r.net) + ' кг, брутто ' + fmt(r.gross) +
          ' кг. Брутто (з упаковкою) не може бути меншим за нетто — схоже, колонки переплутані.', [r], 'net');
        flag(r, 'gross', 'error');
      }
    });
    var netSum = sum(rows, 'net'), grossSum = sum(rows, 'gross');
    var plNet = parseNumber(opts.packingNet), plGross = parseNumber(opts.packingGross);
    if (plNet !== null && plGross !== null && plNet > plGross) {
      add('error', 'PL_NET_GT_GROSS', 'У пакувальному листі нетто більше за брутто',
        'Нетто ' + fmt(plNet) + ' кг > брутто ' + fmt(plGross) + ' кг. Перевір цифри у формі.');
    }

    // 5. Ваги vs пакувальний лист
    if (plGross !== null && grossSum !== null && relDiff(grossSum, plGross) > TOL_WEIGHT) {
      add('warn', 'GROSS_PL', 'Брутто не сходиться з пакувальним листом',
        'Сума брутто по позиціях: ' + fmt(grossSum) + ' кг, у пакувальному листі: ' + fmt(plGross) +
        ' кг (різниця ' + fmt(grossSum - plGross) + ' кг, допуск 1 %). Митниця може зважити вантаж — краще, щоб документи сходилися.');
    }
    if (plNet !== null && netSum !== null && relDiff(netSum, plNet) > TOL_WEIGHT) {
      add('warn', 'NET_PL', 'Нетто не сходиться з пакувальним листом',
        'Сума нетто по позиціях: ' + fmt(netSum) + ' кг, у пакувальному листі: ' + fmt(plNet) +
        ' кг (різниця ' + fmt(netSum - plNet) + ' кг, допуск 1 %).');
    }

    // 6. Код УКТ ЗЕД
    if (cols.code !== undefined) {
      var emptyCode = rows.filter(function (r) { return !r.codeDigits; });
      var badCode = rows.filter(function (r) { return r.codeDigits && !/^\d{10}$/.test(r.codeDigits); });
      if (emptyCode.length) add('error', 'HS_EMPTY', 'Немає коду УКТ ЗЕД',
        rowList(emptyCode) + ': код порожній. Без коду не визначити ставку мита й обмеження.', emptyCode, 'code');
      badCode.forEach(function (r) {
        add('warn', 'HS_FORMAT', 'Код УКТ ЗЕД не з 10 цифр',
          'Рядок ' + r.n + ': «' + r.code + '» — ' + r.codeDigits.replace(/\D/g, '').length +
          ' цифр. У декларації потрібен повний 10-значний код. Код постачальника (6–8 цифр, HS) — лише початок.', [r], 'code');
      });
    }

    // 7. Країна походження
    if (cols.origin !== undefined) {
      var noOrigin = rows.filter(function (r) { return !String(r.origin).trim(); });
      if (noOrigin.length) add('error', 'ORIGIN_EMPTY', 'Не вказана країна походження',
        rowList(noOrigin) + ': країна порожня. Від неї залежить ставка мита і можливі пільги. Країна відправлення ≠ країна походження.', noOrigin, 'origin');
    }

    // 8. Дублікати описів
    var byDesc = {};
    rows.forEach(function (r) {
      var k = words(r.description).join(' ');
      if (!k) return;
      (byDesc[k] = byDesc[k] || []).push(r);
    });
    Object.keys(byDesc).forEach(function (k) {
      var g = byDesc[k];
      if (g.length > 1) {
        add('warn', 'DUPLICATE', 'Однаковий опис у кількох рядках',
          rowList(g) + ': «' + g[0].description + '». Якщо це різні товари — опиши різницю (модель, розмір, матеріал). Якщо той самий — обʼєднай рядки.', g, 'description');
      }
    });

    // 9. Надто загальні описи
    rows.forEach(function (r) {
      var w = words(r.description);
      if (!w.length) {
        add('error', 'DESC_EMPTY', 'Немає опису товару', 'Рядок ' + r.n + ': опис порожній.', [r], 'description');
        return;
      }
      var meaningful = w.filter(function (x) { return GENERIC.indexOf(x) === -1 && !/^\d+$/.test(x); });
      if (!meaningful.length) {
        add('warn', 'DESC_GENERIC', 'Надто загальний опис',
          'Рядок ' + r.n + ': «' + r.description + '». Митниця просить конкретику: що це, з чого зроблено, для чого, модель/артикул. Інакше можуть зупинити для перевірки.', [r], 'description');
      } else if (w.length < 3) {
        add('info', 'DESC_SHORT', 'Короткий опис',
          'Рядок ' + r.n + ': «' + r.description + '». Додай матеріал, призначення або модель — це допомагає з класифікацією.', [r], 'description');
      }
    });

    // 10. Підозріло дешеві позиції
    var byCode = {};
    rows.forEach(function (r) {
      if (/^\d{10}$/.test(r.codeDigits) && r.price !== null && r.price > 0) (byCode[r.codeDigits] = byCode[r.codeDigits] || []).push(r);
    });
    Object.keys(byCode).forEach(function (c) {
      var g = byCode[c];
      if (g.length < 2) return;
      var med = median(g.map(function (r) { return r.price; }));
      g.forEach(function (r) {
        if (r.price < med * OUTLIER_SHARE) {
          add('warn', 'PRICE_OUTLIER', 'Підозріло низька ціна',
            'Рядок ' + r.n + ': ' + fmt(r.price) + ' за од. — менше 20 % від медіани (' + fmt(med) + ') для коду ' + c +
            '. Ризик коригування митної вартості: підготуй прайс, договір або калькуляцію, що пояснюють ціну.', [r], 'price');
        }
      });
    });

    // 11. Валюта
    var cur = String(opts.currency || '').trim().toUpperCase();
    var rowCurs = {};
    rows.forEach(function (r) { if (r.currency) rowCurs[r.currency] = true; });
    var curList = Object.keys(rowCurs);
    if (curList.length > 1) {
      add('warn', 'CURRENCY_MIX', 'Кілька валют в одному інвойсі', 'У рядках: ' + curList.join(', ') + '. Перевір, чи всі суми в одній валюті.');
    } else if (curList.length === 1 && cur && curList[0] !== cur) {
      add('warn', 'CURRENCY_DIFF', 'Валюта рядків не та, що у формі', 'У рядках ' + curList[0] + ', у формі ' + cur + '.');
    }

    // 12. Incoterms
    var inco = String(opts.incoterms || '').trim().toUpperCase();
    var freight = parseNumber(opts.freight) || 0, insurance = parseNumber(opts.insurance) || 0;
    if (!inco) {
      add('warn', 'INCOTERMS_MISSING', 'Не вказані умови поставки (Incoterms)',
        'Від Incoterms залежить митна вартість: якщо ціна без доставки й страхування до кордону України (EXW, FCA, FOB), їх треба додати. Знайди умови в інвойсі або контракті.');
    } else if (INCOTERMS.indexOf(inco) === -1) {
      add('warn', 'INCOTERMS_UNKNOWN', 'Незнайомі умови поставки', '«' + inco + '» — не схоже на Incoterms 2020. Перевір написання.');
    } else if (['EXW', 'FCA', 'FAS', 'FOB'].indexOf(inco) > -1 && freight === 0) {
      add('info', 'INCOTERMS_FREIGHT', 'Додай доставку і страхування',
        inco + ': ціна не включає перевезення до кордону України. Впиши вартість фрахту і страхування — вони входять у митну вартість.');
    } else if (['CFR', 'CPT'].indexOf(inco) > -1 && insurance === 0) {
      add('info', 'INCOTERMS_INSURANCE', 'Перевір страхування',
        inco + ': фрахт уже в ціні, а страхування — ні. Якщо вантаж застрахований, додай страхування до митної вартості.');
    } else if (['DAP', 'DPU', 'DDP'].indexOf(inco) > -1) {
      add('info', 'INCOTERMS_D', 'Доставка вже в ціні',
        inco + ': у ціну може входити доставка після кордону України. Таку частину можна не включати в митну вартість, якщо вона окремо підтверджена документами.');
    }

    // 13. Походження з країн із ЗВТ
    var fta = {}, ftaRows = [];
    rows.forEach(function (r) {
      var g = ftaGroup(r.originCode);
      if (g) { fta[g] = true; ftaRows.push(r); }
    });
    var groups = Object.keys(fta);
    if (groups.length) {
      var tr = groups.indexOf('Туреччина') > -1;
      add('info', 'FTA_ORIGIN', 'Можлива пільга за походженням',
        'Походження: ' + groups.join(', ') + '. Можлива преференція за угодою про вільну торгівлю, якщо є доказ походження (EUR.1 або декларація походження в інвойсі). ' +
        (tr ? 'Угода з Туреччиною діє з 01.10.2026. ' : '') + 'Перевір актуальний перелік угод і правила походження.', ftaRows, 'origin');
    }
    var dispatch = normalizeCountry(opts.dispatchCountry);
    if (dispatch && ftaGroup(dispatch) && rows.some(function (r) { return r.originCode && !ftaGroup(r.originCode); })) {
      add('info', 'DISPATCH_FTA', 'Пільгу дає походження, а не відправлення',
        'Вантаж іде з ' + countryName(dispatch, opts.dispatchCountry) + ', але частина товарів вироблена в іншій країні. Для таких позицій пільги за угодою з країною відправлення зазвичай немає.');
    }

    return finish();

    function finish() {
      var counts = { error: 0, warn: 0, info: 0 };
      issues.forEach(function (i) { counts[i.severity]++; });
      issues.sort(function (a, b) { return rank[b.severity] - rank[a.severity]; });
      var score = Math.max(0, 100 - counts.error * 15 - counts.warn * 5);
      var level = counts.error ? 'error' : counts.warn ? 'warn' : 'ok';
      return {
        table: table, columns: cols, headers: parsed.headers, rows: rows, totalRow: parsed.totalRow,
        issues: issues, counts: counts, score: score, level: level, cellFlags: cellFlags,
        totals: { amount: rowsTotal, net: netSum, gross: grossSum, invoiceTotal: invoiceTotal }
      };
    }
  }

  /* ---------- Платежі ---------- */

  function estimatePayments(rows, opts) {
    opts = opts || {};
    var rate = parseNumber(opts.rate);
    var freight = parseNumber(opts.freight) || 0;
    var insurance = parseNumber(opts.insurance) || 0;
    var defDuty = parseNumber(opts.defaultDuty);
    var vatRate = opts.vatRate === undefined ? VAT_RATE : parseNumber(opts.vatRate);
    var base = sum(rows || [], 'amount');
    if (base === null || base === 0) base = parseNumber(opts.invoiceTotal);
    var missing = [];
    if (!base) missing.push('суми інвойсу');
    if (!rate) missing.push('курсу валюти');
    if (missing.length) return { ok: false, missing: missing };
    var valueCur = base + freight + insurance;
    var valueUAH = valueCur * rate;
    var duty = 0, noDuty = 0;
    var rowsWithAmount = (rows || []).filter(function (r) { return r.amount !== null; });
    if (rowsWithAmount.length) {
      rowsWithAmount.forEach(function (r) {
        var share = r.amount / base;
        var pct = r.duty !== null && r.duty !== undefined ? r.duty : defDuty;
        if (pct === null) noDuty++;
        duty += valueUAH * share * (pct || 0) / 100;
      });
    } else {
      duty = valueUAH * (defDuty || 0) / 100;
      if (defDuty === null) noDuty = 1;
    }
    var vat = (valueUAH + duty) * vatRate / 100;
    return {
      ok: true, valueCur: round2(valueCur), valueUAH: round2(valueUAH), duty: round2(duty),
      vat: round2(vat), total: round2(duty + vat), rowsWithoutDuty: noDuty, vatRate: vatRate
    };
  }

  /* ---------- Експорт ---------- */

  var EXPORT_COLS = ['code', 'description', 'origin', 'qty', 'unit', 'price', 'amount', 'net', 'gross'];
  var EXPORT_HEADERS = ['Код УКТ ЗЕД', 'Опис', 'Країна походження', 'Кількість', 'Одиниця', 'Ціна за од.', 'Сума', 'Нетто, кг', 'Брутто, кг'];

  function csvCell(v, sep) {
    var s = v === null || v === undefined ? '' : String(v);
    return /["\n\r]/.test(s) || s.indexOf(sep) > -1 ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(rows, options) {
    options = options || {};
    var sep = options.sep || ';';
    var dec = options.decimal || ',';
    var num = function (n) {
      if (n === null || n === undefined) return '';
      var s = String(Math.round(n * 10000) / 10000);
      return dec === ',' ? s.replace('.', ',') : s;
    };
    var lines = [EXPORT_HEADERS.map(function (h) { return csvCell(h, sep); }).join(sep)];
    rows.forEach(function (r) {
      lines.push(EXPORT_COLS.map(function (k) {
        var v = r[k];
        if (k === 'code') v = r.codeDigits;
        if (k === 'origin') v = r.originCode && r.originCode !== 'EU' ? r.originCode : r.origin;
        return csvCell(typeof v === 'number' ? num(v) : v, sep);
      }).join(sep));
    });
    return (options.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n';
  }

  var SEV_LABEL = { error: 'ПОМИЛКА', warn: 'УВАГА', info: 'ПІДКАЗКА' };

  function buildReport(result, payments, meta) {
    meta = meta || {};
    var out = [];
    out.push('Deklaro — звіт перевірки інвойсу' + (meta.date ? ' (' + meta.date + ')' : ''));
    out.push('Позицій: ' + result.rows.length + '. Оцінка: ' + result.score + '/100. Помилок: ' + result.counts.error +
      ', попереджень: ' + result.counts.warn + ', підказок: ' + result.counts.info + '.');
    if (result.totals.amount !== null) out.push('Сума позицій: ' + fmt(result.totals.amount) + (meta.currency ? ' ' + meta.currency : '') +
      '; нетто: ' + fmt(result.totals.net) + ' кг; брутто: ' + fmt(result.totals.gross) + ' кг.');
    out.push('');
    result.issues.forEach(function (i, k) {
      out.push((k + 1) + '. [' + SEV_LABEL[i.severity] + '] ' + i.title + ' — ' + i.text);
    });
    if (!result.issues.length) out.push('Явних проблем не знайшли.');
    if (payments && payments.ok) {
      out.push('');
      out.push('Орієнтовні платежі (без акцизу та інших платежів; перевір у брокера):');
      out.push('  Митна вартість: ' + fmt(payments.valueUAH) + ' грн');
      out.push('  Мито: ' + fmt(payments.duty) + ' грн');
      out.push('  ПДВ ' + payments.vatRate + ' %: ' + fmt(payments.vat) + ' грн');
      out.push('  Разом: ' + fmt(payments.total) + ' грн');
    }
    out.push('');
    out.push('Deklaro не є митним брокером і не представляє Держмитслужбу; результати — підказки, не митне рішення.');
    return out.join('\n');
  }

  /* ---------- Приклад ---------- */

  var DEMO_TSV = [
    ['№', 'Опис товару', 'Код УКТ ЗЕД', 'Країна походження', 'К-сть', 'Од.', 'Ціна, USD', 'Сума, USD', 'Нетто, кг', 'Брутто, кг'],
    ['1', 'Навушники бездротові Bluetooth 5.3 з зарядним кейсом', '8518300090', 'Китай', '500', 'шт', '6,20', '3 100,00', '40,0', '46,5'],
    ['2', 'Павербанк 10000 мА·год у пластиковому корпусі', '8507600090', 'Китай', '300', 'шт', '8,50', '2 650,00', '75,0', '82,0'],
    ['3', 'Запчастини', '8708 99', 'Китай', '120', 'шт', '3,10', '372,00', '30,0', '28,0'],
    ['4', 'Чохол для смартфона силіконовий прозорий', '3926909790', 'Туреччина', '1000', 'шт', '0,90', '900,00', '35,0', '40,0'],
    ['5', 'Чохол для смартфона силіконовий прозорий', '3926909790', '', '800', 'шт', '0,15', '120,00', '28,0', '32,0'],
    ['6', 'Тримач для телефона автомобільний магнітний', '3926909790', 'Китай', '400', 'шт', '1,20', '480,00', '24,0', '27,0'],
    ['7', 'Кабель USB-C 1 м у нейлоновій оплітці', '8544429009', 'Китай', '600', 'шт', '0,70', '420,00', '30,0', '33,0']
  ].map(function (r) { return r.join('\t'); }).join('\n');

  var DEMO_FORM = {
    invoiceTotal: '7 942,00', currency: 'USD', incoterms: '', packingGross: '300', packingNet: '262',
    dispatchCountry: 'Китай', freight: '450', insurance: '', rate: '42', defaultDuty: '5'
  };

  return {
    parseNumber: parseNumber, parseTable: parseTable, detectDelimiter: detectDelimiter,
    detectColumns: detectColumns, matchHeader: matchHeader, findHeaderRow: findHeaderRow,
    buildRows: buildRows, normalizeCountry: normalizeCountry, ftaGroup: ftaGroup,
    analyze: analyze, estimatePayments: estimatePayments, toCSV: toCSV, buildReport: buildReport,
    fmt: fmt, round2: round2, FIELD_LABELS: FIELD_LABELS, EXPORT_COLS: EXPORT_COLS,
    EXPORT_HEADERS: EXPORT_HEADERS, INCOTERMS: INCOTERMS, DEMO_TSV: DEMO_TSV, DEMO_FORM: DEMO_FORM
  };
});
