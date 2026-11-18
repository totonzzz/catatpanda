/**
 * CATAT KEUANGAN OTOMATIS DARI NOTIFIKASI
 * Dipasang di Google Sheets yang sama dengan form Tally (Extensions > Apps Script).
 * Shortcut iPhone mengirim teks notifikasi ke Web App ini; baris baru masuk ke
 * sheet "Form Responses 1", jadi Catatan Harian dan Dashboard ikut otomatis.
 * Alamat Web App yang sama melayani: (1) Shortcut notifikasi, (2) aplikasi PWA di layar utama lewat JSON API,
 * dan (3) halaman cadangan bila file HTML "Index" dipasang (opsional).
 */

// ====== GANTI INI SEBELUM DEPLOY ======
var TOKEN = 'GANTI-DENGAN-KODE-RAHASIA-KAMU';   // huruf/angka acak, minimal 16 karakter

// ====== PENGATURAN ======
var SHEET_FR = 'Form Responses 1';
var SHEET_LOG = 'Log Notif';
var SHEET_RULES = 'Aturan';
var SHEET_CICILAN = 'Cicilan';
var SHEET_SETTINGS = 'Pengaturan';
var SHEET_ACCOUNTS = 'Dompet';   // Nama | Jenis | Saldo Awal
var SHEET_ASSETS = 'Aset';       // Jenis | Kode | Nama | Jumlah | Harga Beli
var SHEET_TRANSFERS = 'Transfer';  // Tanggal | Dari | Ke | Jumlah       // Jenis | Kode | Nama | Jumlah | Harga Beli   // Kunci | Nilai   // paylater & cicilan: Nama | Per Bulan | Tenor | Sudah Bayar | Jatuh Tempo
var DEDUPE_SECONDS = 600;     // notifikasi yang sama dalam 10 menit dianggap duplikat
var TIMEZONE = 'Asia/Jakarta';
var APP_VERSION = '3.12';      // 2.2 = update + review notifikasi + pencarian lintas bulan + statistik mingguan

var CATEGORY_EMOJI = {
  'Makan': '🍚', 'Jajan': '🍟', 'Transportasi': '🚗', 'Perawatan Kendaraan': '🔧', 'Cicilan': '💳', 'Kos / Sewa Tempat': '🏠', 'Sumbangan / Kondangan': '🎁', 'BBM': '⛽', 'Belanja': '🛍️',
  'Belanja Pakaian / Fashion': '👗', 'Belanja Kebutuhan Harian': '🧺',
  'Tagihan & Utilitas': '💡', 'Hiburan': '🎬', 'Kesehatan': '🏥', 'Pendidikan': '📚',
  'E-Money / Dompet Digital': '📱', 'Tithe & Offering': '🙏',
  'Kasih ke Orang Tua / Keluarga': '👪', 'Hutang / Piutang': '🤝', 'Lainnya': '✨', 'Gaji': '💰',
  'Bonus': '🎁', 'Hadiah': '🎀', 'Investasi Masuk': '📈'
};
var METHOD_LABEL = {
  'Cash': '💸 Cash', 'Transfer': '🔄 Transfer', 'QRIS': '📱 QRIS',
  'Kartu Kredit BCA': '🔵💳 Kartu Kredit BCA',
  'Kartu Kredit Danamon': '🔴💳 Kartu Kredit Danamon',
  'Kartu Kredit DBS': '⬛💳 Kartu Kredit DBS',
  'Kartu Kredit BNI': '🟠💳 Kartu Kredit BNI',
  'Kartu Kredit Octo': '🔴💳 Kartu Kredit Octo'
};
var TIPE_LABEL = { 'Masuk': '💚 Masuk', 'Keluar': '❤️ Keluar' };

// Kata kunci bawaan (regex, huruf kecil). Aturan di sheet "Aturan" diperiksa lebih dulu.
var DEFAULT_RULES = [
  [/gereja|persembahan|donasi|kitabisa|zakat|infaq|sedekah/, 'Tithe & Offering'],
  [/flazz|e-?money|brizzi|tapcash|top[- ]?up (?:e-?money|flazz)/, 'E-Money / Dompet Digital'],
  [/\bgrab\b(?!food)|gojek|gocar|goride|bluebird|maxim|\btol\b|e-?toll|\bmrt\b|\bkrl\b|commuter|transjakarta|parkir|spbu|pertamina|\bshell\b|\bbp\b|traveloka|tiket\.com|\bkai\b|transport(?:ation|asi)?|\btaxi\b|\bride\b|uber|\bbus\b|\btrain\b|\btransit\b|\bmetro\b|fuel|petrol|gasoline|gas station|\btoll\b|\bparking\b|\bflight\b|airport/, 'Transportasi'],
  [/\bpln\b|listrik|token|pdam|telkom|indihome|biznet|pulsa|telkomsel|indosat|smartfren|\bxl\b|bpjs|first media|electric(?:ity)?|water bill|utility|\bbill\b|internet|broadband|mobile plan|data plan/, 'Tagihan & Utilitas'],
  [/netflix|spotify|disney|youtube|xxi|cgv|bioskop|steam|playstation|nintendo|vidio|cinema|movie|entertainment|subscription|concert/, 'Hiburan'],
  [/apotek|kimia farma|guardian|\bk24\b|rumah sakit|klinik|dokter|halodoc|\brs\b|pharmacy|hospital|clinic|doctor|dentist|medicine/, 'Kesehatan'],
  [/udemy|coursera|sekolah|kursus|gramedia|buku|universitas|kampus/, 'Pendidikan'],
  [/uniqlo|h&m|\bzara\b|zalora|cotton on|matahari|pull&bear|erigo/, 'Belanja Pakaian / Fashion'],
  [/indomaret|alfamart|alfamidi|superindo|super indo|hypermart|lotte mart|ranch market|farmers|transmart|giant|carrefour|supermarket|groceries|grocery/, 'Belanja Kebutuhan Harian'],
  [/tokopedia|shopee(?!food|pay)|lazada|blibli|bukalapak|ikea|ace hardware|informa/, 'Belanja'],
  [/starbucks|kopi|coffee|janji jiwa|\bfore\b|kenangan|tomoro|cafe|bakery|roti|boba|chatime|gelato|j\.?co|dunkin|es teh|minuman|dessert/, 'Jajan'],
  [/mcd|mcdonald|\bkfc\b|pizza|burger|resto|restaurant|warung|nasi|ayam|bakso|\bmie\b|sate|geprek|gofood|grabfood|shopeefood|sushi|ramen|padang|makan|food/, 'Makan']
];

// =====================================================================
//  BAGIAN 1 - PEMBACA NOTIFIKASI (fungsi murni, tidak memakai layanan Google)
// =====================================================================

function parseAmount_(raw) {
  var s = String(raw).replace(/[^0-9.,]/g, '');
  if (!s) return NaN;
  var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot > -1 && lastComma > -1) {
    s = s.slice(0, Math.max(lastDot, lastComma)).replace(/[.,]/g, '');   // buang desimal
  } else if (lastDot > -1 || lastComma > -1) {
    var sep = lastDot > -1 ? '.' : ',';
    var parts = s.split(sep);
    if (parts.length > 2) s = parts.join('');            // 1.250.000
    else if (parts[1].length === 3) s = parts.join('');  // 50.000
    else s = parts[0];                                   // 50,5 -> desimal dibuang
  }
  return parseInt(s, 10);
}

function extractAmount_(text) {
  var re = /(?:rp\.?|idr)\s*([0-9]+(?:[.,][0-9]+)*)/gi, m;
  while ((m = re.exec(text)) !== null) {
    var before = text.slice(Math.max(0, m.index - 22), m.index).toLowerCase();
    if (/saldo|sisa|limit|biaya|fee|admin/.test(before)) continue;
    var n = parseAmount_(m[1]);
    if (n > 0 && n < 1000000000) return n;
  }
  return 0;
}

function detectDirection_(t) {
  if (/(?:tagihan|pembayaran|bayar)\s+kartu\s+kredit/.test(t) && /(pembayaran|bayar|dibayar)/.test(t)) return 'KKBAYAR';
  if (/(menerima|diterima|dana masuk|transfer masuk|uang masuk|setoran|cashback|refund|pengembalian|dikreditkan|received|incoming)/.test(t)) return 'Masuk';
  if (/(pembayaran|dibayar|membayar|pembelian|belanja|transaksi|debit|didebet|tarik tunai|transfer|top[- ]?up|purchase|payment|charged|withdraw|bayar|\bspent\b|\bspend\b|\bspending\b|\bpaid\b|\bcharged\b|menghabiskan|membelanjakan|pengeluaran|uang keluar)/.test(t)) return 'Keluar';
  return '';
}

function detectBank_(t) {
  if (/danamon|d-?bank/.test(t)) return 'Danamon';
  if (/digibank|\bdbs\b/.test(t)) return 'DBS';
  if (/\bbni\b/.test(t)) return 'BNI';
  if (/\bbca\b|mybca|klikbca/.test(t)) return 'BCA';
  return '';
}

function detectMethod_(t, bank) {
  if (/kartu\s+kredit|credit\s*card|\bcc\b|\bkk\b/.test(t)) return bank ? 'Kartu Kredit ' + bank : '';
  if (/qris/.test(t)) return 'QRIS';
  if (/transfer|\btrf\b|bi-?fast|rtgs|skn/.test(t)) return 'Transfer';
  if (/gopay|ovo|\bdana\b|shopeepay|linkaja/.test(t)) return 'QRIS';
  return 'Transfer';   // kartu debit / m-banking
}

function toTitle_(s) {
  return String(s).toLowerCase().replace(/(^|\s)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
}

function extractMerchant_(text) {
  var re = /\b(?:di|at|ke|kepada|to|merchant|toko|dari)\b\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9&'.\-\/ ]{1,40}?)(?=\s+(?:pada|tgl|tanggal|jam|sebesar|senilai|seharga|rp|idr|dengan|menggunakan|using|on|berhasil|sukses|ref|no|trx|dari|limit|saldo)\b|[.,;:\n]|\s*$)/ig, m;
  while ((m = re.exec(text)) !== null) {
    var c = m[1].trim();
    if (c.length < 3) continue;
    if (/^(rekening|rek|akun|account|kartu|anda|nomor|no)\b/i.test(c)) continue;
    if (/^[0-9 \-\/]+$/.test(c)) continue;
    return toTitle_(c);
  }
  return '';
}

function guessCategory_(haystack, tipe, extraRules) {
  var h = haystack.toLowerCase();
  var i;
  if (extraRules) {
    for (i = 0; i < extraRules.length; i++) {
      if (extraRules[i][0] && h.indexOf(extraRules[i][0]) > -1) return extraRules[i][1];
    }
  }
  if (tipe === 'Masuk') return /gaji|salary|payroll/.test(h) ? 'Gaji' : 'Lainnya';
  for (i = 0; i < DEFAULT_RULES.length; i++) {
    if (DEFAULT_RULES[i][0].test(h)) return DEFAULT_RULES[i][1];
  }
  return 'Lainnya';
}

/** p = {app, text}; extraRules = [[kataKunci, kategori], ...] dari sheet Aturan */
function buildEntry_(p, extraRules) {
  var raw = String(p.text || '').replace(/\s+/g, ' ').trim();
  var app = String(p.app || '').trim();
  var t = (app + ' ' + raw).toLowerCase();
  var amount = extractAmount_(raw);
  if (!amount) return { ok: false, reason: 'amount not found' };
  if (/\b(promo|diskon|voucher|dapatkan|hingga|penawaran|kesempatan|undian)\b/.test(t)) return { ok: false, reason: 'terlihat seperti promosi', amount: amount };
  if (/jatuh tempo|segera|pengingat|reminder|e-?statement|rekening koran|batas waktu|pembayaran minimum|minimum payment/.test(t)) return { ok: false, reason: 'terlihat seperti pengingat tagihan', amount: amount };
  var dir = detectDirection_(t);
  if (!dir) return { ok: false, reason: 'transaction direction is unclear', amount: amount };
  var bank = detectBank_(app.toLowerCase()) || detectBank_(t);
  var flags = [];

  if (dir === 'KKBAYAR') {
    if (!bank) return { ok: false, reason: 'credit card bank is unclear', amount: amount };
    return { ok: true, amount: amount, tipe: 'Masuk', metode: 'Kartu Kredit ' + bank,
             merchant: 'Credit card bill payment ' + bank, kategori: 'Lainnya',
             flags: ['pembayaran kartu kredit'] };
  }

  var metode = detectMethod_(t, bank);
  if (!metode) { flags.push('credit card bank unclear'); }
  var merchant = extractMerchant_(raw);
  if (!merchant) {
    var an = /\b(?:a\.n\.?|a\/n)\s+([A-Za-z][A-Za-z ]{2,30}?)(?=\s+(?:berhasil|sukses|pada|tgl|tanggal)\b|[.,;]|\s*$)/i.exec(raw);
    if (an) merchant = 'Transfer ke ' + toTitle_(an[1].trim());
  }
  if (!merchant) {
    var pre = /^(.*?)(?=\s*(?:rp\.?|idr)\s*[0-9])/i.exec(raw);
    var desc = pre ? pre[1].replace(/^(anda|kamu)\s+(telah\s+)?/i, '').trim() : '';
    if (desc.length >= 3) {
      merchant = toTitle_(desc.slice(0, 40));
    } else {
      merchant = (dir === 'Masuk' ? 'Incoming funds' : 'Transaction') + (app ? ' ' + app : '');
      flags.push('merchant not recognised');
    }
  }
  var kategori = guessCategory_(merchant + ' ' + raw, dir, extraRules);
  if (kategori === 'Lainnya' && dir === 'Keluar') flags.push('category guessed');
  return { ok: true, amount: amount, tipe: dir, metode: metode, merchant: merchant, kategori: kategori, flags: flags };
}

// =====================================================================
//  BAGIAN 2 - PENERIMA (Web App) DAN PENULIS KE SHEET
// =====================================================================

function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/** Jalur API untuk aplikasi yang dipasang di iPhone (PWA). Semua butuh TOKEN. */
function api_(p) {
  var a = String(p.action || '');
  if (a === 'ping') return json_({ ok: true, v: APP_VERSION });
  if (a === 'data') return json_(appGetData(p.month || '', p.token));
  if (a === 'add') return json_(appAddTransaction(p, p.token));
  if (a === 'update') return json_(appUpdateTransaction(p, p.token));
  if (a === 'review_list') return json_(appReviewList(p.token));
  if (a === 'review_add') return json_(appReviewAdd(p, p.token));
  if (a === 'review_discard') return json_(appReviewDiscard(p, p.token));
  if (a === 'review_discard_bulk') return json_(appReviewDiscardBulk(p, p.token));
  if (a === 'search') return json_(appSearch(p.q, p.token));
  if (a === 'flag_clear') return json_(appClearFlag(p, p.token));
  if (a === 'budget_set') return json_(appBudgetSet(p, p.token));
  if (a === 'cicilan_add') return json_(appCicilanAdd(p, p.token));
  if (a === 'cicilan_delete') return json_(appCicilanDelete(p, p.token));
  if (a === 'cicilan_pay') return json_(appCicilanPay(p, p.token));
  if (a === 'settings_set') return json_(appSettingsSet(p, p.token));
  if (a === 'dompet_set') return json_(appDompetSet(p, p.token));
  if (a === 'no_spend') return json_(appNoSpend(p, p.token));
  if (a === 'transfer_add') return json_(appTransferAdd(p, p.token));
  if (a === 'aset_set') return json_(appAsetSet(p, p.token));
  if (a === 'aset_delete') return json_(appAsetDelete(p, p.token));
  if (a === 'budget_delete') return json_(appBudgetDelete(p, p.token));
  if (a === 'delete') return json_(appDeleteTransaction(p.id, p.token));
  if (a === 'purge_deleted') return json_(appPurgeDeleted(p, p.token));
  return json_({ ok: false, error: 'unknown action' });
}

function doGet(e) {
  var p = e && e.parameter ? e.parameter : {};
  if (p.action) return api_(p);
  if (p.token || p.text) return handle_(p);        // jalur API (tes lewat browser)
  try {                                                    // halaman cadangan (opsional): perlu file HTML bernama Index
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Bamboo')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return json_({ ok: false, error: 'This address is used by the app on your Home Screen. Open the app from there.' });
  }
}

function doPost(e) {
  var p = {}, k;
  if (e && e.parameter) { for (k in e.parameter) p[k] = e.parameter[k]; }
  try {
    var body = e && e.postData && e.postData.contents;
    if (body && /^\s*\{/.test(body)) {
      var j = JSON.parse(body);
      for (k in j) p[k] = j[k];
    }
  } catch (err) { /* abaikan, pakai parameter biasa */ }
  if (p.action) return api_(p);
  return handle_(p);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet_(ss, name, header, rows) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    if (rows && rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRules_(ss) {
  var sh = getOrCreateSheet_(ss, SHEET_RULES, ['Kata kunci (huruf kecil)', 'Kategori'], [
    ['contoh: kopi tuku', 'Jajan'], ['contoh: sate khas senayan', 'Makan']
  ]);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 2).getValues(), rules = [];
  for (var i = 0; i < vals.length; i++) {
    var kw = String(vals[i][0] || '').toLowerCase().trim();
    var cat = String(vals[i][1] || '').trim();
    if (kw && cat && kw.indexOf('contoh:') !== 0) rules.push([kw, cat]);
  }
  return rules;
}

function logRow_(ss, source, text, result, detail) {
  var sh = getOrCreateSheet_(ss, SHEET_LOG, ['Waktu', 'Sumber', 'Teks notifikasi', 'Hasil', 'Detail']);
  sh.appendRow([new Date(), source, text, result, detail || '']);
}

function handle_(p) {
  if (!p.token || String(p.token) !== TOKEN) return out_({ status: 'error', msg: 'token salah' });
  // isi notifikasi boleh dikirim sebagai "text", atau terpisah sebagai "title", "subtitle", "body"
  var text = String(p.text || [p.title, p.subtitle, p.body].filter(function (x) { return x; }).join(' ')).trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var source = String(p.app || '');
  if (!text) {
    if (!p.dry) logRow_(ss, source, '(kosong)', 'TEKS KOSONG', 'Shortcut jalan tapi tidak mengirim isi notifikasi');
    return out_({ status: 'error', msg: 'notification text is empty' });
  }
  var rules = readRules_(ss);
  var entry = buildEntry_({ app: source, text: text }, rules);

  if (!entry.ok) {
    if (!p.dry) logRow_(ss, source, text, 'PERLU DICEK', entry.reason);
    return out_({ status: 'skip', msg: 'Not recorded: ' + entry.reason });
  }
  var detail = entry.amount + ' | ' + entry.tipe + ' | ' + (entry.metode || '?') + ' | ' + entry.kategori + ' | ' + entry.merchant +
               (entry.flags.length ? ' | cek: ' + entry.flags.join(', ') : '');
  if (p.dry) return out_({ status: 'dry', msg: detail });

  // anti-duplikat
  var cache = CacheService.getScriptCache();
  var key = 'n' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, source + '|' + text)).slice(0, 40);
  if (cache.get(key)) {
    logRow_(ss, source, text, 'DUPLIKAT', detail);
    return out_({ status: 'duplicate', msg: 'Already recorded' });
  }
  cache.put(key, '1', DEDUPE_SECONDS);

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var fr = ss.getSheetByName(SHEET_FR);
    if (!fr) { logRow_(ss, source, text, 'ERROR', 'sheet ' + SHEET_FR + ' tidak ditemukan'); return out_({ status: 'error', msg: 'sheet not found' }); }
    var now = new Date();
    var today = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd');   // teks, sama seperti yang ditulis Tally
    var emoji = CATEGORY_EMOJI[entry.kategori];
    fr.appendRow([
      Utilities.getUuid().substring(0, 7),                 // Submission ID
      'notif',                                             // Respondent ID
      now,                                                 // Submitted at
      today,                                               // Tanggal Transaksi
      entry.merchant,                                      // Untuk apa?
      emoji ? emoji + ' ' + entry.kategori : entry.kategori,
      TIPE_LABEL[entry.tipe],
      entry.metode ? METHOD_LABEL[entry.metode] : '',
      entry.flags.length ? 'otomatis (cek)' : 'otomatis',  // kolom "Kebutuhan atau Keinginan?" dipakai sebagai penanda
      'Nominal lain (isi manual)',
      entry.amount,
      '', ''
    ]);
    logRow_(ss, source, text, entry.flags.length ? 'OK (CEK)' : 'OK', detail);
  } finally {
    lock.releaseLock();
  }
  var msg = 'Recorded: Rp ' + String(entry.amount).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' ' + entry.kategori + ' (' + entry.merchant + ')';
  return out_({ status: 'ok', msg: msg });
}

// =====================================================================
//  BAGIAN 3 - APLIKASI WEB (tampilan di HP, membaca sheet "Form Responses 1")
// =====================================================================

var LOAN_CAT = 'Hutang / Piutang';
var APP_EXPENSE_CATS = ['Makan', 'Jajan', 'Transportasi', 'Perawatan Kendaraan', 'Cicilan', 'Belanja', 'Belanja Pakaian / Fashion',
  'Belanja Kebutuhan Harian', 'Tagihan & Utilitas', 'Hiburan', 'Kesehatan', 'Pendidikan',
  'Kos / Sewa Tempat', 'Sumbangan / Kondangan', 'BBM',
  'E-Money / Dompet Digital', 'Tithe & Offering', 'Kasih ke Orang Tua / Keluarga', 'Lainnya'];
var APP_INCOME_CATS = ['Gaji', 'Bonus', 'Hadiah', 'Investasi Masuk', 'Lainnya'];
var METHOD_ALIASES = {
  'Kartu Kredit CIMB': 'Kartu Kredit Octo',
  'Kartu Kredit CIMB Niaga': 'Kartu Kredit Octo',
  'Octo': 'Kartu Kredit Octo',
  'OCTO': 'Kartu Kredit Octo'
};
var METHOD_ORDER = ['Cash', 'Transfer', 'QRIS', 'GoPay', 'OVO', 'DANA', 'ShopeePay', 'Kartu Kredit BCA', 'Kartu Kredit Danamon', 'Kartu Kredit DBS', 'Kartu Kredit BNI', 'Kartu Kredit Octo'];
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pad2_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
function stripLead_(s) { return String(s == null ? '' : s).replace(/^[^A-Za-z]+/, '').trim(); }

function toNumber_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v == null ? '' : v);
  if (!/[0-9]/.test(s)) return 0;
  var n = parseAmount_(s);
  return isNaN(n) ? 0 : n;
}

function dateOf_(v, fmtDate) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : fmtDate(v);
  var s = String(v == null ? '' : v), m;
  if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(s))) return m[1] + '-' + m[2] + '-' + m[3];
  if ((m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) return m[3] + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
  return '';
}

function addMonths_(ym, n) {
  var y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + pad2_(m + 1);
}
function prevDay_(ymd) {
  var d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}
function monthLabel_(ym) { return MONTH_NAMES[parseInt(ym.slice(5, 7), 10) - 1] + ' ' + ym.slice(0, 4); }

/** Baris Form Responses 1 -> daftar transaksi yang sudah bersih */
function parseRows_(rows, fmtDate) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var desc = String(r[4] == null ? '' : r[4]).trim();
    var tipeRaw = String(r[6] == null ? '' : r[6]);
    var tipe = /masuk/i.test(tipeRaw) ? 'Masuk' : (/keluar/i.test(tipeRaw) ? 'Keluar' : '');
    var amount = toNumber_(r[10]);
    if (!amount) amount = toNumber_(r[9]);        // "Rp 100.000" dari preset cepat
    if (!desc || !tipe || !amount) continue;
    var date = dateOf_(r[3], fmtDate) || dateOf_(r[2], fmtDate);
    if (!date) continue;
    var cat = stripLead_(r[5]);
    var metode = stripLead_(r[7]);
  // Nama lama / varian di form diperlakukan sama.
  if (METHOD_ALIASES[metode]) metode = METHOD_ALIASES[metode];
    var jenisRaw = String(r[12] == null ? '' : r[12]);
    var marker = String(r[8] == null ? '' : r[8]);
    out.push({
      idx: i, id: String(r[0] == null ? '' : r[0]), src: String(r[1] || '') === 'notif' ? 'notif' : (String(r[1] || '') === 'app' ? 'app' : 'form'),
      date: date, desc: desc, cat: cat, tipe: tipe, metode: metode, amount: amount,
      nama: String(r[11] == null ? '' : r[11]).trim(),
      jenis: /piutang/i.test(jenisRaw) ? 'Piutang' : (/hutang/i.test(jenisRaw) ? 'Hutang' : ''),
      isLoan: cat.indexOf(LOAN_CAT) === 0,
      isKK: metode.indexOf('Kartu Kredit') === 0,
      flag: /cek/i.test(marker),
      auto: String(r[1] || '') === 'notif'
    });
  }
  return out;
}

function sumWhere_(list, fn) { var s = 0; for (var i = 0; i < list.length; i++) if (fn(list[i])) s += list[i].amount; return s; }
function isIncome_(t) { return t.tipe === 'Masuk' && !t.isLoan && !(t.isKK); }   // bayar tagihan kartu bukan pemasukan
function isExpense_(t) { return t.tipe === 'Keluar' && !t.isLoan; }

/** Fungsi murni: tidak memakai layanan Google, jadi bisa diuji. ctx = {today, fmtDate, emoji} */
function buildData_(rows, month, ctx) {
  var tx = parseRows_(rows, ctx.fmtDate);
  var today = ctx.today, curMonth = today.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month || '')) month = curMonth;
  if (month > curMonth) month = curMonth;

  var sorted = tx.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b.idx - a.idx; });
  var period = periodFor_(month, ctx.settings || {});
  var mtx = sorted.filter(function (t) { return t.date >= period.start && t.date <= period.end; });

  var masuk = sumWhere_(mtx, isIncome_), keluar = sumWhere_(mtx, isExpense_);

  var catMap = {};
  mtx.forEach(function (t) { if (isExpense_(t)) catMap[t.cat || 'Lainnya'] = (catMap[t.cat || 'Lainnya'] || 0) + t.amount; });
  var categories = Object.keys(catMap).map(function (k) {
    return { name: k, emoji: (ctx.emoji && ctx.emoji[k]) || '🏷️', amount: catMap[k], pct: keluar ? Math.round(catMap[k] / keluar * 1000) / 10 : 0 };
  }).sort(function (a, b) { return b.amount - a.amount; });

  var trend = [];
  for (var k = 5; k >= 0; k--) {
    var ym = addMonths_(month, -k);
    var pr = periodFor_(ym, ctx.settings || {});
    var sub = tx.filter(function (t) { return t.date >= pr.start && t.date <= pr.end; });
    trend.push({ month: ym, label: MONTH_NAMES[parseInt(ym.slice(5, 7), 10) - 1].slice(0, 3), masuk: sumWhere_(sub, isIncome_), keluar: sumWhere_(sub, isExpense_) });
  }

  var methods = [], kkTotal = 0;
  METHOD_ORDER.forEach(function (name) {
    var mine = tx.filter(function (t) { return t.metode.indexOf(name) === 0; });
    var inn = sumWhere_(mine, function (t) { return t.tipe === 'Masuk'; });
    var out = sumWhere_(mine, function (t) { return t.tipe === 'Keluar'; });
    var kk = name.indexOf('Kartu Kredit') === 0;
    var monthOut = sumWhere_(mtx, function (t) { return t.metode.indexOf(name) === 0 && t.tipe === 'Keluar'; });
    var value = kk ? out - inn : inn - out;
    if (kk) kkTotal += value;
    var row = { name: name, kind: kk ? 'utang' : 'saldo', value: value, monthOut: monthOut, empty: !mine.length };
    if (kk) {
      var cyc = (ctx.cardCycles && ctx.cardCycles[name]) || { cutoff: 25, dueAfter: 15 };
      var card = cardCycle_(mine, ctx.today, cyc.cutoff, cyc.dueAfter);
      row.cutoff = cyc.cutoff; row.periodEnd = card.periodEnd; row.dueDate = card.dueDate;
      row.bill = card.bill; row.paid = card.paid; row.dueAmount = card.dueAmount; row.unbilled = card.unbilled;
    }
    // Kartu kredit selalu ditampilkan (walau belum ada transaksi) supaya tumpukannya terlihat.
    if (mine.length || kk) methods.push(row);
  });

  var people = {}, totalPiutang = 0, totalHutang = 0;
  tx.forEach(function (t) {
    if (!t.isLoan || !t.nama || !t.jenis) return;
    var key = t.nama.toLowerCase();
    var p = people[key] || (people[key] = { name: t.nama, piutang: 0, hutang: 0 });
    if (t.jenis === 'Piutang') p.piutang += t.tipe === 'Keluar' ? t.amount : -t.amount;
    else p.hutang += t.tipe === 'Masuk' ? t.amount : -t.amount;
  });
  var persons = Object.keys(people).map(function (k) { var p = people[k]; totalPiutang += p.piutang; totalHutang += p.hutang; p.net = p.piutang - p.hutang; return p; })
    .sort(function (a, b) { return Math.abs(b.net) - Math.abs(a.net); });

  var days = {}; tx.forEach(function (t) { days[t.date] = true; });
  ((ctx.settings && ctx.settings.noSpendDays) || []).forEach(function (d0) { days[d0] = true; });
  var streak = 0, guard = 0;
  var cursor = days[today] ? today : prevDay_(today);   // hari ini belum diisi: rantai tetap hidup sampai hari berakhir
  while (days[cursor] && guard < 400) { streak++; guard++; cursor = prevDay_(cursor); }

  var recent = mtx.slice(0, 300).map(function (t) {
    return { id: t.id, src: t.src, date: t.date, desc: t.desc, cat: t.cat, emoji: (ctx.emoji && ctx.emoji[t.cat]) || (t.isLoan ? '🤝' : '🏷️'),
             tipe: t.tipe, amount: t.amount, metode: t.metode, loan: t.isLoan, nama: t.nama, jenis: t.jenis, flag: t.flag, auto: t.auto };
  });

  var instalments = ctx.instalments || [];
  var instalMonthly = instalments.reduce(function (s, x) { return s + (x.left > 0 ? x.per : 0); }, 0);
  var budgetMap = ctx.budgets || {};
  var budgets = Object.keys(budgetMap).map(function (n) {
    var limit = budgetMap[n], spent = catMap[n] || 0;
    return { name: n, limit: limit, spent: spent, pct: limit ? Math.round(spent / limit * 100) : 0, over: spent > limit };
  }).sort(function (a, b) { return b.pct - a.pct; });

  return {
    month: month, label: monthLabel_(month), prev: addMonths_(month, -1), next: month < curMonth ? addMonths_(month, 1) : '',
    today: today, period: period,
    kpi: { masuk: masuk, keluar: keluar, selisih: masuk - keluar, count: mtx.length },
    categories: categories, trend: trend, recent: recent, methods: methods, kkTotal: kkTotal,
    loans: { piutang: totalPiutang, hutang: totalHutang, persons: persons }, week: weekStats_(tx, today),
    budgets: budgets,
    instalments: instalments,
    instalMonthly: instalMonthly,
    settings: ctx.settings || null,
    accounts: (ctx.accountDefs || []).map(function (a) {
      var inn = 0, out2 = 0;
      tx.forEach(function (x) {
        if (String(x.metode || '').indexOf(a.name) !== 0) return;
        if (x.tipe === 'Masuk') inn += x.amount; else if (x.tipe === 'Keluar') out2 += x.amount;
      });
      var trIn = 0, trOut = 0;
      (ctx.transfers || []).forEach(function (tr) {
        if (tr.to === a.name) trIn += tr.amount;
        if (tr.from === a.name) trOut += tr.amount;
      });
      return { name: a.name, kind: a.kind, opening: a.opening, masuk: inn + trIn, keluar: out2 + trOut,
               transferIn: trIn, transferOut: trOut, balance: a.opening + inn + trIn - out2 - trOut };
    }),
    assets: ctx.assetDefs || [],
    transfers: ctx.transfers || [],
    health: healthScore_(tx, mtx, today, kkTotal, budgetMap, catMap, streak, trend, instalMonthly, ctx.settings || {}),
    behavior: behaviorStats_(tx, mtx, month, today, catMap, keluar),
    streak: streak, todayFilled: !!days[today], flagged: mtx.filter(function (t) { return t.flag; }).length
  };
}

function isoOf_(d) {
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

/** Ringkasan minggu berjalan (Senin–hari ini) dibanding minggu sebelumnya. */
function weekStats_(tx, today) {
  var t = new Date(today + 'T00:00:00Z');
  var dow = (t.getUTCDay() + 6) % 7;                      // 0 = Senin
  var start = new Date(t); start.setUTCDate(t.getUTCDate() - dow);
  var startStr = isoOf_(start);
  var prevStart = new Date(start); prevStart.setUTCDate(start.getUTCDate() - 7);
  var prevEnd = new Date(start); prevEnd.setUTCDate(start.getUTCDate() - 1);
  var prevStartStr = isoOf_(prevStart), prevEndStr = isoOf_(prevEnd);
  var cur = { masuk: 0, keluar: 0, count: 0 }, prev = { masuk: 0, keluar: 0 }, cats = {};
  tx.forEach(function (x) {
    var d = x.date;
    if (d >= startStr && d <= today) {
      cur.count++;
      if (x.tipe === 'Masuk') cur.masuk += x.amount;
      else if (!x.isLoan) { cur.keluar += x.amount; cats[x.cat || 'Lainnya'] = (cats[x.cat || 'Lainnya'] || 0) + x.amount; }
    } else if (d >= prevStartStr && d <= prevEndStr) {
      if (x.tipe === 'Masuk') prev.masuk += x.amount;
      else if (!x.isLoan) prev.keluar += x.amount;
    }
  });
  var topCat = '', topAmount = 0;
  Object.keys(cats).forEach(function (k) { if (cats[k] > topAmount) { topCat = k; topAmount = cats[k]; } });
  return {
    start: startStr, end: today, masuk: cur.masuk, keluar: cur.keluar, count: cur.count,
    prevMasuk: prev.masuk, prevKeluar: prev.keluar, topCat: topCat, topCatAmount: topAmount
  };
}

// ---------- siklus tagihan kartu kredit ----------

function addDays_(ymd, n) {
  var d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf_(d);
}

/** Tanggal cetak terakhir pada/atau sebelum `today` untuk hari cetak tertentu. */
function cutoffOnOrBefore_(today, day) {
  var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), d = Number(today.slice(8, 10));
  var dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  var dd = Math.min(day, dim);
  if (d >= dd) return y + '-' + pad2_(m) + '-' + pad2_(dd);
  var py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  var pdim = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return py + '-' + pad2_(pm) + '-' + pad2_(Math.min(day, pdim));
}

/**
 * Membagi pemakaian kartu menjadi tagihan periode terakhir (jatuh tempo)
 * dan pemakaian setelah cetak (masuk tagihan berikutnya).
 */
function cardCycle_(rows, today, cutoff, dueAfter) {
  var end = cutoffOnOrBefore_(today, cutoff);
  var prev = cutoffOnOrBefore_(addDays_(end, -1), cutoff);
  var bill = 0, paid = 0, unbilled = 0;
  rows.forEach(function (t) {
    if (t.date > prev && t.date <= end) {
      if (t.tipe === 'Keluar') bill += t.amount;
    } else if (t.date > end && t.date <= today) {
      if (t.tipe === 'Keluar') unbilled += t.amount;
      else if (t.tipe === 'Masuk') paid += t.amount;
    }
  });
  return {
    periodStart: prev, periodEnd: end, bill: bill, paid: paid,
    dueAmount: Math.max(bill - paid, 0), unbilled: unbilled,
    dueDate: addDays_(end, dueAfter || 15)
  };
}

/** Membaca (dan membuat bila belum ada) tab pengaturan "Kartu". */
function cardCycles_(ss) {
  var defaults = [
    ['Kartu Kredit BCA', 25, 15],
    ['Kartu Kredit Danamon', 17, 15],
    ['Kartu Kredit BNI', 18, 15],
    ['Kartu Kredit DBS', 19, 15],
    ['Kartu Kredit Octo', 25, 15]
  ];
  var sh = getOrCreateSheet_(ss, 'Kartu', ['Kartu', 'Tanggal cetak', 'Jatuh tempo (hari setelah cetak)'], defaults);
  var out = {}, last = sh.getLastRow();
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
    var name = String(r[0] == null ? '' : r[0]).trim();
    var cutoff = Number(r[1]), due = Number(r[2]);
    if (name && cutoff >= 1 && cutoff <= 31) out[name] = { cutoff: Math.round(cutoff), dueAfter: due > 0 ? Math.round(due) : 15 };
  });
  return out;
}

// ---------- jembatan ke halaman (dipanggil lewat google.script.run) ----------

function appAuth_(token) {
  if (token && String(token) === TOKEN) return true;
  try {
    var a = Session.getActiveUser().getEmail(), b = Session.getEffectiveUser().getEmail();
    return !!a && a === b;       // hanya pemilik spreadsheet yang login
  } catch (err) { return false; }
}

function reviewInfo_(ss) {
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh || sh.getLastRow() < 2) return { pending: 0, items: [] };
  var from = Math.max(2, sh.getLastRow() - 199);
  var vals = sh.getRange(from, 1, sh.getLastRow() - from + 1, 5).getValues(), items = [];
  for (var i = vals.length - 1; i >= 0 && items.length < 5; i--) {
    if (String(vals[i][3]) === 'PERLU DICEK') items.push({ text: String(vals[i][2]).slice(0, 120), reason: String(vals[i][4]) });
  }
  var pending = 0;
  for (var j = 0; j < vals.length; j++) if (String(vals[j][3]) === 'PERLU DICEK') pending++;
  return { pending: pending, items: items };
}

function appGetData(month, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone();
    var fr = ss.getSheetByName(SHEET_FR);
    var rows = [];
    if (fr && fr.getLastRow() > 1) {
      rows = fr.getRange(2, 1, fr.getLastRow() - 1, Math.min(13, fr.getMaxColumns())).getValues();
    }
    var data = buildData_(rows, month, {
      today: Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'),
      fmtDate: function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); },
      emoji: CATEGORY_EMOJI,
      cardCycles: cardCycles_(ss),
      budgets: readBudgets_(ss),
      instalments: readInstalments_(ss),
      settings: readSettings_(ss),
      accountDefs: readAccountDefs_(ss),
      assetDefs: readAssetDefs_(ss),
      transfers: readTransfers_(ss)
    });
    data.review = reviewInfo_(ss);
    data.options = { expense: APP_EXPENSE_CATS, income: APP_INCOME_CATS, loan: LOAN_CAT, methods: METHOD_ORDER, emoji: CATEGORY_EMOJI };
    data.ok = true;
    return data;
  } catch (err) {
    return { ok: false, error: 'Could not read the sheet: ' + err };
  }
}

function appAddTransaction(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var desc = String(p.desc || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  var amount = Math.round(Number(p.amount));
  var tipe = p.tipe === 'Masuk' ? 'Masuk' : (p.tipe === 'Keluar' ? 'Keluar' : '');
  var kat = String(p.kategori || '');
  var metode = String(p.metode || '');
  var nowStr = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  var tanggal = /^\d{4}-\d{2}-\d{2}$/.test(String(p.tanggal || '')) ? String(p.tanggal) : nowStr;
  if (tanggal > nowStr) return { ok: false, error: 'Date cannot be in the future' };
  if (!desc) return { ok: false, error: 'Enter a description first' };
  if (!(amount > 0 && amount < 10000000000)) return { ok: false, error: 'Amount is not valid' };
  if (!tipe) return { ok: false, error: 'Choose Income or Expense' };
  if (APP_EXPENSE_CATS.concat(APP_INCOME_CATS, [LOAN_CAT]).indexOf(kat) < 0) return { ok: false, error: 'Choose a category' };
  if (!METHOD_LABEL[metode]) return { ok: false, error: 'Choose a payment method' };

  var nama = '', jenisLabel = '';
  if (kat === LOAN_CAT) {
    nama = String(p.nama || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!nama) return { ok: false, error: 'Enter the person\'s name' };
    if (p.jenis === 'Hutang') jenisLabel = '🔴 Hutang (saya pinjam)';
    else if (p.jenis === 'Piutang') jenisLabel = '🟢 Piutang (saya pinjamkan)';
    else return { ok: false, error: 'Choose Debt or Receivable' };
  }

  var cache = CacheService.getScriptCache();
  var key = 'a' + String(p.reqId || '').slice(0, 40);
  if (p.reqId && cache.get(key)) return { ok: true, msg: 'Already saved' };

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var fr = ss.getSheetByName(SHEET_FR);
    if (!fr) return { ok: false, error: 'Sheet ' + SHEET_FR + ' not found' };
    var emoji = CATEGORY_EMOJI[kat];
    fr.appendRow([
      Utilities.getUuid().substring(0, 7), 'app', new Date(), tanggal, desc,
      emoji ? emoji + ' ' + kat : kat, TIPE_LABEL[tipe], METHOD_LABEL[metode], '',
      'Nominal lain (isi manual)', amount, nama, jenisLabel
    ]);
    if (p.reqId) cache.put(key, '1', 600);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, msg: 'Saved' };
}

/** Hapus permanen baris-baris lama yang dulu hanya dikosongkan (bertanda "dihapus"). */
function appPurgeDeleted(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  var removed = 0;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var fr = ss.getSheetByName(SHEET_FR);
    if (!fr || fr.getLastRow() < 2) return { ok: true, removed: 0, msg: 'Nothing to tidy' };
    var rows = fr.getRange(2, 1, fr.getLastRow() - 1, 2).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0]) === '' && String(rows[i][1]) === 'dihapus') { fr.deleteRow(i + 2); removed++; }
      else if (String(rows[i][1]) === 'dihapus') { fr.deleteRow(i + 2); removed++; }
    }
  } finally { lock.releaseLock(); }
  return { ok: true, removed: removed, msg: removed + ' empty row(s) removed' };
}

function appDeleteTransaction(id, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  id = String(id || '').trim();
  if (!id) return { ok: false, error: 'Entry ID is empty' };
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var fr = ss.getSheetByName(SHEET_FR);
    if (!fr || fr.getLastRow() < 2) return { ok: false, error: 'Entry not found' };
    var cols = Math.min(13, fr.getMaxColumns());
    var ids = fr.getRange(2, 1, fr.getLastRow() - 1, 1).getValues(), row = -1;
    for (var i = ids.length - 1; i >= 0; i--) { if (String(ids[i][0]) === id) { row = i + 2; break; } }
    if (row < 0) return { ok: false, error: 'Entry not found (it may have been deleted)' };
    var vals = fr.getRange(row, 1, 1, cols).getValues()[0];
    var trash = getOrCreateSheet_(ss, 'Sampah', ['Dihapus pada', 'Submission ID', 'Respondent ID', 'Submitted at', 'Tanggal Transaksi',
      'Untuk apa?', 'Kategori', 'Tipe', 'Metode Pembayaran', 'Penanda', 'Jumlah cepat', 'Jumlah', 'Nama orang', 'Hutang atau Piutang?']);
    trash.appendRow([new Date()].concat(vals));
    // salinan sudah aman di tab Sampah; barisnya benar-benar dihapus agar sheet rapi
    fr.deleteRow(row);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, msg: 'Deleted (a copy is in the Trash tab)' };
}

/** Uji tanpa menulis apa pun: pilih fungsi "tes" lalu Run, lihat hasil di Execution log. */
function tes() {
  var samples = [
    { app: 'Danamon', text: 'Transaksi kartu kredit sebesar Rp 150.000 di STARBUCKS pada 25/10/2026. Limit tersedia Rp 8.500.000' },
    { app: 'BCA', text: 'Pembayaran QRIS Rp25.000 ke WARUNG BU TINI berhasil. Saldo Rp 1.200.000' },
    { app: 'BNI', text: 'Anda menerima transfer Rp 2.500.000,00 dari BUDI SANTOSO' }
  ];
  samples.forEach(function (s) {
    s.token = TOKEN; s.dry = '1';
    Logger.log(handle_(s).getContent());
  });
}

// =====================================================================
//  BAGIAN 4 - UBAH CATATAN (dipakai tombol "Ubah" di aplikasi)
// =====================================================================

/**
 * action=update. Baris dicari lewat Submission ID di kolom A, jadi nomor baris,
 * tanggal submit, dan rumus di sheet lain tidak ikut bergeser.
 * Kolom yang ditulis: D Tanggal, E Untuk apa?, F Kategori, G Tipe, H Metode,
 * K Jumlah, L Nama orang, M Hutang atau Piutang?. Kolom I (penanda) dipertahankan.
 */
function appUpdateTransaction(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var id = String(p.id || '').trim();
  if (!id) return { ok: false, error: 'Entry ID is empty' };

  var desc = String(p.desc || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  var amount = Math.round(Number(p.amount));
  var tipe = p.tipe === 'Masuk' ? 'Masuk' : (p.tipe === 'Keluar' ? 'Keluar' : '');
  var kat = String(p.kategori || '').trim();
  var metode = String(p.metode || '').trim();
  var nowStr = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  var tanggal = /^\d{4}-\d{2}-\d{2}$/.test(String(p.tanggal || '')) ? String(p.tanggal) : nowStr;
  var nama = '', jenisLabel = '';

  if (!desc) return { ok: false, error: 'Enter a description first' };
  if (!(amount > 0 && amount < 10000000000)) return { ok: false, error: 'Amount is not valid' };
  if (!tipe) return { ok: false, error: 'Choose Income or Expense' };
  if (tanggal > nowStr) return { ok: false, error: 'Date cannot be in the future' };
  if (!METHOD_LABEL[metode]) return { ok: false, error: 'Choose a payment method' };

  var allowed = APP_EXPENSE_CATS.concat(APP_INCOME_CATS, [LOAN_CAT]);
  var katKnown = allowed.indexOf(kat) >= 0;

  if (kat === LOAN_CAT) {
    nama = String(p.nama || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!nama) return { ok: false, error: 'Enter the person\'s name' };
    if (p.jenis === 'Hutang') jenisLabel = '🔴 Hutang (saya pinjam)';
    else if (p.jenis === 'Piutang') jenisLabel = '🟢 Piutang (saya pinjamkan)';
    else return { ok: false, error: 'Choose Debt or Receivable' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var fr = ss.getSheetByName(SHEET_FR);
    if (!fr || fr.getLastRow() < 2) return { ok: false, error: 'Entry not found' };
    var cols = Math.min(13, fr.getMaxColumns());
    var ids = fr.getRange(2, 1, fr.getLastRow() - 1, 1).getValues(), row = -1;
    for (var i = 0; i < ids.length; i++) { if (String(ids[i][0]).trim() === id) { row = i + 2; break; } }
    if (row < 0) return { ok: false, error: 'Entry not found (it may have been deleted)' };

    var vals = fr.getRange(row, 1, 1, cols).getValues()[0];
    if (String(vals[1] || '') === 'dihapus') return { ok: false, error: 'This entry was already deleted' };
    // kategori lama (mis. "Makanan & Minuman") tetap boleh disimpan apa adanya
    if (!katKnown && kat !== stripLead_(vals[5])) return { ok: false, error: 'Choose a category' };

    var emoji = CATEGORY_EMOJI[kat];
    // Menyunting sebuah entri berarti sudah diperiksa: penanda "cek" dilepas.
    var marker = String(vals[8] == null ? '' : vals[8]);
    if (/cek/i.test(marker)) marker = 'otomatis';
    fr.getRange(row, 4, 1, Math.min(10, cols - 3)).setValues([[
      tanggal,
      desc,
      emoji ? emoji + ' ' + kat : kat,
      TIPE_LABEL[tipe],
      METHOD_LABEL[metode],
      marker,
      'Nominal lain (isi manual)',
      amount,
      nama,
      jenisLabel
    ]]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, msg: 'Changes saved' };
}

// =====================================================================
//  BAGIAN 5 - NOTIFIKASI YANG BELUM TERBACA (tab "Log Notif", hasil PERLU DICEK)
// =====================================================================

function markLog_(sh, row, hasil, detail) {
  sh.getRange(row, 4, 1, 2).setValues([[hasil, detail || '']]);
}

/** Daftar notifikasi berstatus PERLU DICEK, lengkap dengan tebakan hasil bacaan. */
function appReviewList(token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET_LOG);
    if (!sh || sh.getLastRow() < 2) return { ok: true, items: [] };
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
    var rules = readRules_(ss), items = [];
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][3]) !== 'PERLU DICEK') continue;
      var text = String(vals[i][2] == null ? '' : vals[i][2]);
      var it = {
        row: i + 2, when: '', source: String(vals[i][1] == null ? '' : vals[i][1]),
        text: text, reason: String(vals[i][4] == null ? '' : vals[i][4]),
        amount: 0, tipe: '', kategori: '', metode: '', merchant: ''
      };
      try {
        if (vals[i][0] instanceof Date) it.when = Utilities.formatDate(vals[i][0], TIMEZONE, 'yyyy-MM-dd');
        var g = buildEntry_({ app: it.source, text: text }, rules);
        if (g && g.ok) {
          it.amount = g.amount; it.tipe = g.tipe; it.kategori = g.kategori;
          it.metode = g.metode || ''; it.merchant = g.merchant || '';
        } else if (g && g.reason) {
          it.reason = g.reason;
        }
      } catch (err) { /* tetap tampilkan teks aslinya */ }
      items.push(it);
    }
    items.reverse();   // yang terbaru di atas
    return { ok: true, items: items, total: items.length };
  } catch (err) {
    return { ok: false, error: 'Could not read the log sheet: ' + err };
  }
}

/** Catat satu notifikasi sebagai transaksi, lalu tandai barisnya beres. */
function appReviewAdd(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var row = Number(p.row);
  if (!(row >= 2)) return { ok: false, error: 'Invalid notification row' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh || row > sh.getLastRow()) return { ok: false, error: 'Notification not found' };
  if (String(sh.getRange(row, 4).getValue() || '') !== 'PERLU DICEK') return { ok: false, error: 'This notification was already handled' };

  var res = appAddTransaction({
    desc: p.desc, amount: p.amount, tipe: p.tipe, kategori: p.kategori, metode: p.metode,
    tanggal: p.tanggal, nama: p.nama, jenis: p.jenis, reqId: 'rev_' + row
  }, token);
  if (!res || !res.ok) return res || { ok: false, error: 'Could not record' };

  markLog_(sh, row, 'OK (dari aplikasi)', 'dicatat: ' + String(p.kategori || '') + ' | ' + String(p.tipe || '') + ' | ' + String(p.amount || ''));
  return { ok: true, msg: 'Recorded from notification' };
}

/** Buang notifikasi tanpa dicatat. */
function appReviewDiscard(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var row = Number(p.row);
  if (!(row >= 2)) return { ok: false, error: 'Invalid notification row' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh || row > sh.getLastRow()) return { ok: false, error: 'Notification not found' };
  if (String(sh.getRange(row, 4).getValue() || '') !== 'PERLU DICEK') return { ok: false, error: 'This notification was already handled' };

  markLog_(sh, row, 'DIBUANG', 'dibuang dari aplikasi');
  return { ok: true, msg: 'Dismissed' };
}

/** Buang banyak notifikasi sekaligus (mis. semua yang tanpa nominal). */
function appReviewDiscardBulk(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var rows = (p && p.rows) || [];
  if (!rows.length) return { ok: true, count: 0 };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh) return { ok: false, error: 'Log sheet not found' };
  var last = sh.getLastRow(), done = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = Number(rows[i]);
    if (!(r >= 2) || r > last) continue;
    if (String(sh.getRange(r, 4).getValue() || '') !== 'PERLU DICEK') continue;
    markLog_(sh, r, 'DIBUANG', 'dibuang dari aplikasi (massal)');
    done++;
  }
  return { ok: true, count: done };
}

/** Cari transaksi di semua bulan (bukan hanya bulan yang sedang dibuka). */
function appSearch(q, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var term = String(q || '').trim().toLowerCase();
  if (term.length < 2) return { ok: true, items: [], total: 0, term: term };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone();
    var fr = ss.getSheetByName(SHEET_FR);
    if (!fr || fr.getLastRow() < 2) return { ok: true, items: [], total: 0, term: term };
    var rows = fr.getRange(2, 1, fr.getLastRow() - 1, Math.min(13, fr.getMaxColumns())).getValues();
    var tx = parseRows_(rows, function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); });
    var hits = tx.filter(function (t) {
      return [t.desc, t.cat, t.metode, t.nama].join(' ').toLowerCase().indexOf(term) >= 0;
    });
    hits.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    var items = hits.slice(0, 80).map(function (t) {
      return {
        id: t.id, date: t.date, desc: t.desc, cat: t.cat, emoji: CATEGORY_EMOJI[t.cat] || (t.isLoan ? '🤝' : '🏷️'),
        tipe: t.tipe, amount: t.amount, metode: t.metode, loan: t.isLoan, nama: t.nama, src: t.src
      };
    });
    return { ok: true, items: items, total: hits.length, term: term };
  } catch (err) {
    return { ok: false, error: 'Search failed: ' + err };
  }
}

// =====================================================================
//  BAGIAN 11 - DOMPET & ASET
// =====================================================================

/** Definisi dompet: [{ name, kind, opening }] dari tab "Dompet". */
function readAccountDefs_(ss) {
  var sh = ss.getSheetByName(SHEET_ACCOUNTS);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  var out = [];
  vals.forEach(function (r) {
    var name = String(r[0] == null ? '' : r[0]).trim();
    if (!name) return;
    var kind = String(r[1] == null ? '' : r[1]).trim().toLowerCase() || 'bank';
    out.push({ name: name, kind: kind, opening: numOf_(r[2]) });
  });
  return out;
}

/** Perpindahan saldo antar dompet: [{ date, from, to, amount }]. */
function readTransfers_(ss) {
  var sh = ss.getSheetByName(SHEET_TRANSFERS);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  var out = [];
  vals.forEach(function (r) {
    var from = String(r[1] == null ? '' : r[1]).trim();
    var to = String(r[2] == null ? '' : r[2]).trim();
    var amount = numOf_(r[3]);
    if (!from || !to || !(amount > 0)) return;
    out.push({ date: String(r[0] == null ? '' : r[0]).slice(0, 10), from: from, to: to, amount: amount });
  });
  return out;
}

function appTransferAdd(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var from = String(p.dari || '').trim();
  var to = String(p.ke || '').trim();
  var amount = numOf_(p.jumlah);
  if (!from || !to) return { ok: false, error: 'Choose both wallets' };
  if (from === to) return { ok: false, error: 'Pick two different wallets' };
  if (!(amount > 0)) return { ok: false, error: 'Amount must be above zero' };
  var today = /^\d{4}-\d{2}-\d{2}$/.test(String(p.tanggal || ''))
    ? String(p.tanggal) : Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getOrCreateSheet_(ss, SHEET_TRANSFERS, ['Tanggal', 'Dari', 'Ke', 'Jumlah'], []);
  sh.appendRow([today, from, to, amount]);
  return { ok: true, msg: 'Moved ' + amount + ' from ' + from + ' to ' + to };
}

/** Definisi aset: [{ kind, code, name, units, buyPrice }] dari tab "Aset". */
function readAssetDefs_(ss) {
  var sh = ss.getSheetByName(SHEET_ASSETS);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  var out = [];
  vals.forEach(function (r) {
    var code = String(r[1] == null ? '' : r[1]).trim();
    if (!code) return;
    out.push({
      kind: String(r[0] == null ? '' : r[0]).trim().toLowerCase() || 'saham',
      code: code,
      name: String(r[2] == null ? '' : r[2]).trim() || code,
      units: numOf_(r[3]),
      buyPrice: numOf_(r[4]),
      priceManual: numOf_(r[5])
    });
  });
  return out;
}

function appDompetSet(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var name = String(p.nama || '').trim();
  if (!name) return { ok: false, error: 'Give the wallet a name' };
  var kind = String(p.jenis || 'bank').trim().toLowerCase();
  var opening = numOf_(p.saldo);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getOrCreateSheet_(ss, SHEET_ACCOUNTS, ['Nama', 'Jenis', 'Saldo Awal'], []);
  var last = sh.getLastRow(), row = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim().toLowerCase() === name.toLowerCase()) { row = i + 2; break; }
  }
  if (row > 0) sh.getRange(row, 2, 1, 2).setValues([[kind, opening]]);
  else sh.appendRow([name, kind, opening]);
  return { ok: true, msg: 'Wallet saved' };
}

function appNoSpend(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  writeSetting_(ss, 'nospend:' + today, '1');
  return { ok: true, date: today, msg: 'Today marked as no spending' };
}

function appAsetSet(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var code = String(p.kode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Give the asset a code' };
  var kind = String(p.jenis || 'saham').trim().toLowerCase();
  var name = String(p.nama || code).trim();
  var units = numOf_(p.jumlah);
  var buy = numOf_(p.hargaBeli);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var priceNow = numOf_(p.hargaKini);
  var sh = getOrCreateSheet_(ss, SHEET_ASSETS, ['Jenis', 'Kode', 'Nama', 'Jumlah', 'Harga Beli', 'Harga Kini / NAV'], []);
  var last = sh.getLastRow(), row = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 2, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim().toUpperCase() === code) { row = i + 2; break; }
  }
  if (row > 0) sh.getRange(row, 1, 1, 6).setValues([[kind, code, name, units, buy, priceNow]]);
  else sh.appendRow([kind, code, name, units, buy, priceNow]);
  return { ok: true, msg: 'Asset saved' };
}

function appAsetDelete(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var code = String((p && p.kode) || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Code is required' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_ASSETS);
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'Asset not found' };
  var vals = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toUpperCase() === code) { sh.deleteRow(i + 2); return { ok: true, msg: 'Asset removed' }; }
  }
  return { ok: false, error: 'Asset not found' };
}

// =====================================================================
//  BAGIAN 9 - PENGATURAN (tersimpan di spreadsheet)
// =====================================================================

var SETTING_DEFAULTS = {
  payday_mode: 'last',   // 'last' = hari kerja terakhir, 'fixed' = tanggal tetap
  payday_day: '25',
  target_needs: '50',
  target_wants: '30',
  target_savings: '20',
  period_mode: 'calendar'
};
var SETTING_KEYS = ['payday_mode', 'payday_day', 'target_needs', 'target_wants', 'target_savings', 'period_mode'];

// =====================================================================
//  BAGIAN 10 - PERIODE GAJIAN
// =====================================================================

/** Hari kerja terakhir pada bulan (y, m 0-based). */
function lastWeekdayDate_(y, m) {
  var d = new Date(Date.UTC(y, m + 1, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function paydayDateFor_(settings, y, m) {
  if (settings && settings.paydayMode === 'fixed') {
    var day = Math.max(1, Math.min(31, Number(settings.paydayDay) || 25));
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  }
  return lastWeekdayDate_(y, m);
}
function isoDay_(d) { return d.toISOString().slice(0, 10); }

/**
 * Rentang satu "bulan" untuk ym ('YYYY-MM').
 * - calendar: 1 .. akhir bulan
 * - payday:   gajian bulan sebelumnya .. sehari sebelum gajian bulan ini
 */
function periodFor_(ym, settings) {
  var y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10) - 1;
  if (!settings || settings.periodMode !== 'payday') {
    var endCal = new Date(Date.UTC(y, m + 1, 0));
    return { start: ym + '-01', end: isoDay_(endCal), mode: 'calendar', label: ym };
  }
  var startPay = paydayDateFor_(settings, y, m - 1);
  var endPay = paydayDateFor_(settings, y, m);
  var end = new Date(endPay.getTime() - 86400000);
  return { start: isoDay_(startPay), end: isoDay_(end), mode: 'payday', label: ym };
}

/** { paydayMode, paydayDay, needs, wants, savings } dari tab "Pengaturan". */
function readSettings_(ss) {
  var out = {
    paydayMode: SETTING_DEFAULTS.payday_mode,
    paydayDay: Number(SETTING_DEFAULTS.payday_day),
    needs: Number(SETTING_DEFAULTS.target_needs),
    wants: Number(SETTING_DEFAULTS.target_wants),
    savings: Number(SETTING_DEFAULTS.target_savings),
    periodMode: SETTING_DEFAULTS.period_mode,
    buckets: {}
  };
  var sh = ss.getSheetByName(SHEET_SETTINGS);
  if (!sh || sh.getLastRow() < 2) return out;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  var map = {};
  vals.forEach(function (r) {
    var k = String(r[0] == null ? '' : r[0]).trim();
    if (k) map[k] = String(r[1] == null ? '' : r[1]).trim();
  });
  if (map.payday_mode === 'fixed' || map.payday_mode === 'last') out.paydayMode = map.payday_mode;

  if (map.period_mode === 'payday' || map.period_mode === 'calendar') out.periodMode = map.period_mode;
  out.noSpendDays = [];
  Object.keys(map).forEach(function (k) {
    if (k.indexOf('nospend:') === 0) out.noSpendDays.push(k.slice(8));
  });
  out.paid = {};
  Object.keys(map).forEach(function (k) {
    if (k.indexOf('paid:') === 0 && map[k]) out.paid[k.slice(5)] = map[k];
  });
  Object.keys(map).forEach(function (k) {
    if (k.indexOf('bucket:') === 0) {
      var v = map[k];
      if (v === 'needs' || v === 'wants' || v === 'off') out.buckets[k.slice(7)] = v;
    }
  });
  var pd = numOf_(map.payday_day);
  if (pd >= 1 && pd <= 31) out.paydayDay = pd;
  // nilai yang belum diisi memakai default, supaya menyimpan satu target tidak membatalkan yang lain
  var n = map.target_needs == null ? out.needs : numOf_(map.target_needs);
  var w = map.target_wants == null ? out.wants : numOf_(map.target_wants);
  var s = map.target_savings == null ? out.savings : numOf_(map.target_savings);
  if (n + w + s === 100 && n > 0 && w > 0) { out.needs = n; out.wants = w; out.savings = s; }
  return out;
}

function writeSetting_(ss, key, val) {
  var sh = getOrCreateSheet_(ss, SHEET_SETTINGS, ['Kunci', 'Nilai'], []);
  var last = sh.getLastRow(), row = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === key) { row = i + 2; break; }
  }
  if (row > 0) sh.getRange(row, 2).setValue(val); else sh.appendRow([key, val]);
}

function appSettingsSet(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var key = String(p.key || '').trim();
  var val = String(p.value == null ? '' : p.value).trim();
  var isBucket = key.indexOf('bucket:') === 0 && key.length > 7;
  if (SETTING_KEYS.indexOf(key) < 0 && !isBucket) return { ok: false, error: 'Unknown setting' };
  if (isBucket && ['needs', 'wants', 'off'].indexOf(val) < 0) return { ok: false, error: 'Bucket must be needs, wants or off' };

  if (key === 'payday_mode' && val !== 'last' && val !== 'fixed') return { ok: false, error: 'Invalid payday rule' };


  if (key === 'period_mode' && val !== 'payday' && val !== 'calendar') return { ok: false, error: 'Invalid period mode' };
  if (key === 'payday_day') { var d = numOf_(val); if (!(d >= 1 && d <= 31)) return { ok: false, error: 'Payday must be 1-31' }; val = String(d); }
  if (key === 'target_needs' || key === 'target_wants' || key === 'target_savings') {
    var n = numOf_(val);
    if (!(n >= 0 && n <= 100)) return { ok: false, error: 'Target must be 0-100' };
    val = String(n);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getOrCreateSheet_(ss, SHEET_SETTINGS, ['Kunci', 'Nilai'], []);
  var last = sh.getLastRow(), row = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === key) { row = i + 2; break; }
  }
  if (row > 0) sh.getRange(row, 2).setValue(val); else sh.appendRow([key, val]);

  var cur = readSettings_(ss);
  if (cur.needs + cur.wants + cur.savings !== 100) {
    return { ok: true, msg: 'Saved — but Needs + Wants + Savings do not add up to 100% yet', warning: true };
  }
  return { ok: true, msg: 'Saved' };
}

// =====================================================================
//  BAGIAN 8 - PAYLATER & CICILAN
// =====================================================================

/**
 * Catat pembayaran satu cicilan: menulis pengeluaran ke sheet utama
 * (kategori "Cicilan") sekaligus menaikkan hitungan bulan yang sudah dibayar.
 */
function appCicilanPay(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var name = String(p.nama || '').trim();
  if (!name) return { ok: false, error: 'Name is required' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_CICILAN);
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'Instalment not found' };

  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  var row = -1, per = 0, tenor = 0, paid = 0;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toLowerCase() === name.toLowerCase()) {
      row = i + 2; per = numOf_(vals[i][1]); tenor = numOf_(vals[i][2]); paid = numOf_(vals[i][3]);
      break;
    }
  }
  if (row < 0) return { ok: false, error: 'Instalment not found' };
  if (tenor > 0 && paid >= tenor) return { ok: false, error: 'This instalment is already fully paid' };

  var amount = numOf_(p.amount) || per;
  if (!(amount > 0)) return { ok: false, error: 'Amount is not valid' };

  var res = appAddTransaction({
    desc: name, amount: amount, tipe: 'Keluar', kategori: 'Cicilan',
    metode: String(p.metode || 'Transfer'), tanggal: String(p.tanggal || '')
  }, token);
  if (!res || res.ok === false) return res || { ok: false, error: 'Could not record the payment' };

  sh.getRange(row, 4).setValue(paid + 1);
  // tandai bulan ini sudah dibayar supaya pengingat jatuh tempo berhenti
  var ymNow = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM');
  writeSetting_(ss, 'paid:' + name, ymNow);
  return { ok: true, paid: paid + 1, left: Math.max(0, tenor - paid - 1), month: ymNow, msg: 'Payment recorded' };
}


// =====================================================================

function numOf_(v) {
  if (typeof v === 'number') return v;
  var n = Number(String(v == null ? '' : v).replace(/[^0-9]/g, ''));
  return isFinite(n) ? n : 0;
}

/** Daftar cicilan dari tab "Cicilan". */
function readInstalments_(ss) {
  var sh = ss.getSheetByName(SHEET_CICILAN);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  var out = [];
  vals.forEach(function (r) {
    var name = String(r[0] == null ? '' : r[0]).trim();
    if (!name) return;
    var per = numOf_(r[1]), tenor = numOf_(r[2]), paid = numOf_(r[3]), due = numOf_(r[4]);
    if (per <= 0 || tenor <= 0) return;
    if (paid > tenor) paid = tenor;
    out.push({ name: name, per: per, tenor: tenor, paid: paid, dueDay: due,
               left: tenor - paid, remaining: per * (tenor - paid) });
  });
  return out;
}

function appCicilanAdd(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  p = p || {};
  var name = String(p.nama || '').trim();
  var per = numOf_(p.per);
  var tenor = numOf_(p.tenor);
  var paid = numOf_(p.paid);
  var due = numOf_(p.due);
  if (!name) return { ok: false, error: 'Give the instalment a name' };
  if (per <= 0) return { ok: false, error: 'The monthly amount must be above zero' };
  if (tenor <= 0) return { ok: false, error: 'The tenor must be at least 1 month' };
  if (paid > tenor) paid = tenor;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getOrCreateSheet_(ss, SHEET_CICILAN, ['Nama', 'Per Bulan', 'Tenor', 'Sudah Bayar', 'Jatuh Tempo'], []);
  var last = sh.getLastRow(), row = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim().toLowerCase() === name.toLowerCase()) { row = i + 2; break; }
  }
  if (row > 0) sh.getRange(row, 2, 1, 4).setValues([[per, tenor, paid, due]]);
  else sh.appendRow([name, per, tenor, paid, due]);
  return { ok: true, msg: 'Instalment saved' };
}

function appCicilanDelete(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var name = String((p && p.nama) || '').trim();
  if (!name) return { ok: false, error: 'Name is required' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_CICILAN);
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'Instalment not found' };
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toLowerCase() === name.toLowerCase()) { sh.deleteRow(i + 2); return { ok: true, msg: 'Instalment removed' }; }
  }
  return { ok: false, error: 'Instalment not found' };
}

// =====================================================================
//  BAGIAN 7 - ANGGARAN, SKOR KESEHATAN, DAN PERILAKU BELANJA
// =====================================================================

function budgetSheet_(ss) {
  return getOrCreateSheet_(ss, 'Anggaran', ['Kategori', 'Batas bulanan'], []);
}

/** { kategori: batas } dari tab "Anggaran". */
function readBudgets_(ss) {
  var sh = ss.getSheetByName('Anggaran');
  if (!sh || sh.getLastRow() < 2) return {};
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues(), out = {};
  vals.forEach(function (r) {
    var n = String(r[0] == null ? '' : r[0]).trim();
    var lim = Number(String(r[1] == null ? '' : r[1]).replace(/[^0-9]/g, ''));
    if (n && lim > 0) out[n] = lim;
  });
  return out;
}

function appBudgetSet(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var name = String((p && p.kategori) || '').trim();
  var limit = Number(String((p && p.limit) || '').replace(/[^0-9]/g, ''));
  if (!name) return { ok: false, error: 'Choose a category' };
  if (!(limit > 0)) return { ok: false, error: 'The limit must be above zero' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = budgetSheet_(ss);
  var last = sh.getLastRow(), row = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) { if (String(vals[i][0]).trim() === name) { row = i + 2; break; } }
  }
  if (row > 0) sh.getRange(row, 2).setValue(limit); else sh.appendRow([name, limit]);
  return { ok: true, msg: 'Budget saved' };
}

function appBudgetDelete(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var name = String((p && p.kategori) || '').trim();
  if (!name) return { ok: false, error: 'Choose a category' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Anggaran');
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'Budget not found' };
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === name) { sh.deleteRow(i + 2); return { ok: true, msg: 'Budget removed' }; }
  }
  return { ok: false, error: 'Budget not found' };
}

/** Skor 0-100 dari lima komponen yang bisa dijelaskan. */
function healthScore_(tx, mtx, today, kkTotal, budgetMap, catMap, streak, trend, instalMonthly, settings) {
  instalMonthly = instalMonthly || 0;
  var curMonth = today.slice(0, 7);
  var from = periodFor_(addMonths_(curMonth, -2), settings || {}).start;
  var recent = tx.filter(function (t) { return t.date >= from && t.date <= today; });
  var inc = sumWhere_(recent, isIncome_), exp = sumWhere_(recent, isExpense_);
  var savings = inc > 0 ? (inc - exp) / inc : 0;

  var p1 = Math.max(0, Math.min(1, savings / 0.30)) * 40;
  var parts = [{ key: 'savings', label: 'Savings rate', score: Math.round(p1), max: 40,
    detail: inc > 0 ? Math.round(savings * 100) + '% of income kept (3 months)' : 'No income recorded yet' }];

  var monthlyInc = inc / 3;
  var debtService = Math.max(0, kkTotal) + instalMonthly;
  var debtRatio = monthlyInc > 0 ? debtService / monthlyInc : (debtService > 0 ? 3 : 0);
  var p2 = Math.max(0, 1 - debtRatio) * 20;
  parts.push({ key: 'debt', label: 'Card debt', score: Math.round(p2), max: 20,
    detail: debtService > 0
      ? 'Card debt + instalments = ' + Math.round(debtRatio * 100) + '% of monthly income'
      : 'No card debt or instalments' });

  var keys = Object.keys(budgetMap || {});
  var p3 = 12, detail3 = 'No budgets set yet';
  if (keys.length) {
    var ok = 0;
    keys.forEach(function (k) { if ((catMap[k] || 0) <= budgetMap[k]) ok++; });
    p3 = 20 * ok / keys.length;
    detail3 = ok + ' of ' + keys.length + ' budgets within limit';
  }
  parts.push({ key: 'budget', label: 'Budgets', score: Math.round(p3), max: 20, detail: detail3 });

  var series = (trend || []).map(function (x) { return x.keluar; }).filter(function (v) { return v > 0; });
  var cv = 0;
  if (series.length > 1) {
    var mean = series.reduce(function (a, b) { return a + b; }, 0) / series.length;
    var vari = series.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / series.length;
    cv = mean > 0 ? Math.sqrt(vari) / mean : 0;
  }
  var p4 = Math.max(0, Math.min(1, 1 - cv)) * 10;
  parts.push({ key: 'stability', label: 'Spending stability', score: Math.round(p4), max: 10,
    detail: series.length > 1 ? 'Month-to-month variation ' + Math.round(cv * 100) + '%' : 'Not enough months yet' });

  var p5 = Math.min(streak, 30) / 30 * 10;
  parts.push({ key: 'habit', label: 'Daily tracking', score: Math.round(p5), max: 10, detail: streak + '-day streak' });

  var score = Math.round(p1 + p2 + p3 + p4 + p5);
  var grade = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 50 ? 'Fair' : 'Needs attention';
  return { score: score, grade: grade, parts: parts, savingsRate: Math.round(savings * 1000) / 10, debtRatio: Math.round(debtRatio * 100) / 100 };
}

/** Fakta perilaku belanja bulan terpilih. */
function behaviorStats_(tx, mtx, month, today, catMap, keluar) {
  var isCur = month === today.slice(0, 7);
  var dim = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  var elapsed = isCur ? Number(today.slice(8, 10)) : dim;
  var avgDaily = elapsed ? keluar / elapsed : 0;

  var total = 0, weekend = 0, small = 0, count = 0, largest = null;
  mtx.forEach(function (t) {
    if (!isExpense_(t)) return;
    total += t.amount; count++;
    var dow = new Date(t.date + 'T00:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6) weekend += t.amount;
    if (t.amount <= 50000) small++;
    if (!largest || t.amount > largest.amount) largest = t;
  });

  var prev = addMonths_(month, -1), prevMap = {};
  tx.forEach(function (t) {
    if (t.date.slice(0, 7) === prev && isExpense_(t)) prevMap[t.cat || 'Lainnya'] = (prevMap[t.cat || 'Lainnya'] || 0) + t.amount;
  });
  var movers = Object.keys(catMap).map(function (k) {
    return { name: k, delta: catMap[k] - (prevMap[k] || 0), now: catMap[k], before: prevMap[k] || 0 };
  }).sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });

  var top = Object.keys(catMap).sort(function (a, b) { return catMap[b] - catMap[a]; })[0] || '';
  return {
    avgDaily: Math.round(avgDaily),
    projected: isCur ? Math.round(avgDaily * dim) : keluar,
    weekendShare: total ? Math.round(weekend / total * 100) : 0,
    smallShare: count ? Math.round(small / count * 100) : 0,
    topCat: top, topShare: keluar && top ? Math.round(catMap[top] / keluar * 100) : 0,
    count: count,
    largest: largest ? { desc: largest.desc, amount: largest.amount, date: largest.date } : null,
    movers: movers.slice(0, 3)
  };
}

// =====================================================================
//  BAGIAN 6 - LEPAS PENANDA "CEK" (entri otomatis yang sudah diperiksa)
// =====================================================================

/** Menghapus penanda "cek" pada satu entri tanpa mengubah isinya. */
function appClearFlag(p, token) {
  if (!appAuth_(token)) return { ok: false, error: 'auth' };
  var id = String((p && p.id) || '').trim();
  if (!id) return { ok: false, error: 'Entry ID is empty' };

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var fr = ss.getSheetByName(SHEET_FR);
    if (!fr || fr.getLastRow() < 2) return { ok: false, error: 'Entry not found' };
    var ids = fr.getRange(2, 1, fr.getLastRow() - 1, 1).getValues(), row = -1;
    for (var i = 0; i < ids.length; i++) { if (String(ids[i][0]).trim() === id) { row = i + 2; break; } }
    if (row < 0) return { ok: false, error: 'Entry not found (it may have been deleted)' };

    var marker = String(fr.getRange(row, 9).getValue() || '');
    if (/cek/i.test(marker)) fr.getRange(row, 9).setValue('otomatis');
  } finally {
    lock.releaseLock();
  }
  return { ok: true, msg: 'Marked as checked' };
}
