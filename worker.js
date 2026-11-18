// Bamboo push relay.
// Web Push untuk Cloudflare Workers — hanya memakai WebCrypto (tanpa dependensi).
// Format: RFC 8291 (aes128gcm) + RFC 8292 (VAPID ES256).

const enc = new TextEncoder();

function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// HKDF-Extract + Expand (satu panggilan WebCrypto = keduanya).
async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * Enkripsi payload untuk satu langganan.
 * @returns {Uint8Array} body siap dikirim (header aes128gcm + ciphertext)
 */
async function encryptPayload(payload, p256dhB64u, authB64u) {
  const uaPublic = b64uToBytes(p256dhB64u);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh tidak valid');
  const authSecret = b64uToBytes(authB64u);
  if (authSecret.length !== 16) throw new Error('auth tidak valid');

  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(ecdh, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  const record = concat(enc.encode(payload), new Uint8Array([2])); // satu record, delimiter 0x02
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/** JWT VAPID (ES256) untuk endpoint tertentu. */
async function vapidJwt(endpoint, publicKeyB64u, privateKeyB64u, subject, ttlSeconds = 12 * 3600) {
  const pub = b64uToBytes(publicKeyB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key tidak valid');
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
    d: privateKeyB64u
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    sub: subject
  })));
  const input = header + '.' + claims;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input)));
  return input + '.' + bytesToB64u(sig);
}

/** Kirim satu notifikasi push. Mengembalikan status HTTP. */
async function sendPush(subscription, payloadObj, env) {
  const jwt = await vapidJwt(subscription.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT || 'mailto:noreply@example.com');
  const body = await encryptPayload(JSON.stringify(payloadObj), subscription.keys.p256dh, subscription.keys.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC_KEY,
      'TTL': '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Urgency': 'normal'
    },
    body
  });
  return res.status;
}

/** Buat pasangan kunci VAPID (dipakai tools/vapid.mjs). */
async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: bytesToB64u(pub), privateKey: jwk.d };
}

// Bamboo — push relay (Cloudflare Worker)
// Tugas: menyimpan langganan push, memeriksa Google Sheets tiap 5 menit lewat Apps Script,
// dan mengirim notifikasi saat ada catatan otomatis baru.


const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
});

const SHEET_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+\/)?macros\/s\/[^/]+\/exec$/;
const encIdx = new TextEncoder();

const rp = (n) => 'Rp ' + String(Math.round(Math.abs(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

async function kvKey(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', encIdx.encode(endpoint));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'sub:' + hex.slice(0, 40);
}

async function callSheet(url, token, action, extra) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action, token }, extra || {})),
    redirect: 'follow'
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: 'bad response' }; }
}

async function subscribe(req, env) {
  const body = await req.json().catch(() => null);
  const s = body && body.subscription;
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) ||
      !s.keys || !s.keys.p256dh || !s.keys.auth) {
    return json({ ok: false, error: 'Invalid subscription' }, 400);
  }
  const sheetUrl = String(body.url || ''), token = String(body.token || '');
  if (!SHEET_RE.test(sheetUrl)) return json({ ok: false, error: 'Invalid sheet URL' }, 400);
  if (token.length < 8) return json({ ok: false, error: 'Invalid token' }, 400);

  const data = await callSheet(sheetUrl, token, 'data', { month: '' });
  if (!data || data.ok === false) {
    return json({ ok: false, error: data && data.error === 'auth' ? 'auth' : 'Sheet rejected the request' }, 403);
  }

  const seen = (data.recent || []).filter((t) => t.src === 'notif' && t.id).map((t) => String(t.id));
  const record = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, sheetUrl, token, seen, updatedAt: Date.now() };
  await env.SUBS.put(await kvKey(s.endpoint), JSON.stringify(record));
  return json({ ok: true });
}

async function unsubscribe(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.endpoint !== 'string') return json({ ok: false, error: 'Invalid endpoint' }, 400);
  await env.SUBS.delete(await kvKey(body.endpoint));
  return json({ ok: true });
}

async function checkOne(env, key, record) {
  const data = await callSheet(record.sheetUrl, record.token, 'data', { month: '' });
  if (!data || data.ok === false) {
    if (data && data.error === 'auth') await env.SUBS.delete(key);
    return;
  }
  const items = (data.recent || []).filter((t) => t.src === 'notif' && t.id);
  const seen = new Set(record.seen || []);
  const fresh = items.filter((t) => !seen.has(String(t.id)));

  if (fresh.length) {
    const payload = fresh.length === 1
      ? { title: 'New automatic entry', body: (fresh[0].emoji ? fresh[0].emoji + ' ' : '') + (fresh[0].desc || 'Transaction') + ' · ' + rp(fresh[0].amount), tag: 'notif-' + fresh[0].id }
      : { title: fresh.length + ' new automatic entries', body: fresh.slice(0, 3).map((t) => t.desc || 'Transaction').join(' · '), tag: 'notif-batch' };

    const status = await sendPush({ endpoint: record.endpoint, keys: record.keys }, payload, env);
    if (status === 404 || status === 410) { await env.SUBS.delete(key); return; }
  }

  // Pengingat tagihan kartu kredit + cicilan: H-3 sampai hari jatuh tempo, sekali per tagihan.
  const reminders = dueReminders(data, record).concat(instalmentReminders(data, record));
  for (const r of reminders) {
    const st = await sendPush({ endpoint: record.endpoint, keys: record.keys }, r.payload, env);
    if (st === 404 || st === 410) { await env.SUBS.delete(key); return; }
    record.reminded = record.reminded || {};
    record.reminded[r.key] = true;
  }
  if (record.reminded && data.today) {
    const cutoff = addDays(data.today, -30);
    Object.keys(record.reminded).forEach((k) => {
      const d = String(k).split('|')[1];
      if (d && d < cutoff) delete record.reminded[k];
    });
  }

  const next = items.map((t) => String(t.id)).slice(-300);
  await env.SUBS.put(key, JSON.stringify({ ...record, seen: next, updatedAt: Date.now() }));
}

/**
 * Pengingat cicilan/paylater: H-3 sampai hari-H, sekali per nama + bulan jatuh tempo.
 * Memakai data.instalments dari skrip (nama, per, tenor, paid, left, dueDay).
 */
function instalmentReminders(data, record) {
  const today = data && data.today;
  if (!today || !Array.isArray(data.instalments)) return [];
  const parts = today.split('-').map(Number);
  const y = parts[0], m = parts[1];
  const reminded = record.reminded || {};
  const out = [];

  const paidMarks = (data.settings && data.settings.paid) || {};
  (data.instalments || []).forEach((x) => {
    if (!x || !(x.left > 0) || !x.dueDay) return;
    const dueDay = Math.max(1, Math.min(31, Number(x.dueDay) || 1));
    const lastOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const clamp = Math.min(dueDay, lastOfMonth);
    let due = new Date(Date.UTC(y, m - 1, clamp));
    const now = new Date(today + 'T00:00:00Z');
    if (due < now) {
      const nextLast = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      due = new Date(Date.UTC(y, m, Math.min(dueDay, nextLast)));
    }
    const days = Math.round((due - now) / 86400000);
    if (days < 0 || days > 3) return;

    // H-3, H-1, hari-H: tiga pengingat bertahap supaya tidak terlewat (H-2 dilewati agar tidak berisik).
    if (days !== 3 && days !== 1 && days !== 0) return;
    const iso = due.toISOString().slice(0, 10);
    if (paidMarks[x.name] === iso.slice(0, 7)) return;
    const key = 'cicilan|' + x.name + '|' + iso + '|' + days;
    if (reminded[key]) return;
    out.push({
      key: key,
      payload: {
        title: days === 0 ? 'Instalment due today' : 'Instalment due in ' + days + ' day' + (days === 1 ? '' : 's'),
        body: x.name + ' · ' + rp(x.per) + ' · ' + x.left + ' month' + (x.left === 1 ? '' : 's') + ' left',
        tag: 'cicilan-' + x.name + '-' + iso
      }
    });
  });
  return out;
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dueReminders(data, record) {
  const today = data && data.today;
  if (!today) return [];
  const reminded = record.reminded || {};
  const out = [];
  (data.methods || []).forEach((m) => {
    if (m.kind !== 'utang' || !m.dueDate || !(m.dueAmount > 0)) return;
    const days = Math.round((Date.parse(m.dueDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    if (days !== 3 && days !== 1 && days !== 0) return;
    const key = 'kartu|' + m.name + '|' + m.dueDate + '|' + days;
    if (reminded[key]) return;
    const shortName = String(m.name).replace(/^Kartu Kredit\s*/i, '');
    out.push({
      key: key,
      payload: {
        title: days === 0 ? 'Bill due today' : 'Bill due in ' + days + ' day' + (days === 1 ? '' : 's'),
        body: shortName + ' · ' + rp(m.dueAmount) + ' · ' + m.dueDate,
        tag: 'due-' + key
      }
    });
  });
  return out;
}

async function testPush(req, env) {
  const body = await req.json().catch(() => null);
  const token = body && String(body.token || '');
  if (!token) return json({ ok: false, error: 'token required' }, 400);
  const list = await env.SUBS.list({ prefix: 'sub:' });
  let sent = 0;
  for (const k of list.keys) {
    const raw = await env.SUBS.get(k.name);
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (rec.token !== token) continue;
    const st = await sendPush({ endpoint: rec.endpoint, keys: rec.keys }, { title: 'Bamboo test', body: 'If you can read this, push notifications work.', tag: 'test' }, env);
    if (st >= 200 && st < 300) sent++;
    else if (st === 404 || st === 410) await env.SUBS.delete(k.name);
  }
  return json({ ok: sent > 0, sent });
}

async function checkAll(env) {
  const list = await env.SUBS.list({ prefix: 'sub:' });
  for (const k of list.keys) {
    const raw = await env.SUBS.get(k.name);
    if (!raw) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    try { await checkOne(env, k.name, record); } catch (e) { console.log('check failed', k.name, e && e.message); }
  }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function aiInsight(req, env) {
  const body = await req.json().catch(() => null);
  const digest = body && body.digest;
  if (!digest) return json({ ok: false, error: 'digest required' }, 400);
  if (!env.AI_API_KEY) return json({ ok: false, error: 'AI not configured' }, 503);

  const cacheKey = 'ai:' + (await sha256Hex(JSON.stringify(digest))).slice(0, 40);
  const cached = await env.SUBS.get(cacheKey);
  if (cached) return json({ ok: true, text: cached, cached: true });

  const endpoint = env.AI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
  const model = env.AI_MODEL || 'gpt-4o-mini';
  let res, raw;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.AI_API_KEY },
      body: JSON.stringify({
        model: model,
        temperature: 0.4,
        max_tokens: 320,
        messages: [
          { role: 'system', content: 'You are a concise personal finance coach. Answer in English, at most 110 words, plain text, three short paragraphs: what stands out, the main risk, one concrete action for this week. Use only the numbers given; never invent figures.' },
          { role: 'user', content: JSON.stringify(digest) }
        ]
      })
    });
    raw = await res.text();
  } catch (e) {
    return json({ ok: false, error: 'Cannot reach the AI provider' }, 502);
  }

  let data = null;
  try { data = JSON.parse(raw); } catch { data = null; }

  if (!res.ok) {
    const detail = (data && data.error && (data.error.message || data.error.type || JSON.stringify(data.error))) || String(raw || '').slice(0, 180) || '';
    return json({ ok: false, error: 'AI provider error (' + res.status + '): ' + detail }, 502);
  }
  if (!data) return json({ ok: false, error: 'AI provider returned non-JSON (check AI_BASE_URL)' }, 502);

  // OpenAI-compatible, plus Gemini native shape.
  let text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
    text = data.candidates[0].content.parts.map((p) => p.text || '').join('');
  }
  if (!text) {
    const hint = Object.keys(data).slice(0, 4).join(',') || 'empty';
    return json({ ok: false, error: 'AI did not answer (response keys: ' + hint + ') — check AI_MODEL / AI_BASE_URL' }, 502);
  }
  await env.SUBS.put(cacheKey, text.trim(), { expirationTtl: 43200 });
  return json({ ok: true, text: text.trim() });
}

async function aiStatus(env) {
  return json({
    ok: true,
    configured: !!env.AI_API_KEY,
    model: env.AI_MODEL || 'gpt-4o-mini',
    base: env.AI_BASE_URL || 'https://api.openai.com/v1/chat/completions'
  });
}

// Harga saham IDX (delay 15-20 menit) lewat Yahoo Finance, di-cache 10 menit di KV.
async function fetchQuote(code) {
  const sym = encodeURIComponent(code + '.JK');
  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  let lastErr = 'unknown';
  for (const host of hosts) {
    try {
      const r = await fetch(host + '/v8/finance/chart/' + sym + '?range=5d&interval=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bamboo/1.0)' },
        cf: { cacheTtl: 300 }
      });
      if (!r.ok) { lastErr = 'http ' + r.status; continue; }
      const d = await r.json();
      const res = d && d.chart && d.chart.result && d.chart.result[0];
      const meta = (res && res.meta) || {};
      const price = meta.regularMarketPrice;
      if (typeof price !== 'number') { lastErr = 'no price'; continue; }
      const prev = (typeof meta.chartPreviousClose === 'number') ? meta.chartPreviousClose
        : (typeof meta.previousClose === 'number' ? meta.previousClose : null);
      return {
        code: code,
        price: price,
        prev: prev,
        currency: meta.currency || 'IDR',
        asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
        delayed: true
      };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return { code: code, error: lastErr };
}

async function prices(url, env) {
  const raw = (url.searchParams.get('codes') || '')
    .toUpperCase().split(',')
    .map(function (s) { return s.trim().replace(/\.JK$/, ''); })
    .filter(Boolean)
    .slice(0, 30);
  if (!raw.length) return json({ ok: false, error: 'codes required' }, 400);
  const out = {};
  for (const code of raw) {
    const key = 'price:' + code;
    let cached = null;
    if (env.SUBS) {
      try { cached = await env.SUBS.get(key, 'json'); } catch (e) { cached = null; }
    }
    if (cached && typeof cached.price === 'number') { out[code] = cached; continue; }
    const q = await fetchQuote(code);
    out[code] = q;
    if (env.SUBS && typeof q.price === 'number') {
      try { await env.SUBS.put(key, JSON.stringify(q), { expirationTtl: 600 }); } catch (e) {}
    }
  }
  return json({ ok: true, prices: out, note: 'Harga saham IDX tertinggal 15-20 menit' });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    try {
      if (path === '/api/push/key' && req.method === 'GET') return json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY });
      if (path === '/api/push/subscribe' && req.method === 'POST') return await subscribe(req, env);
      if (path === '/api/push/unsubscribe' && req.method === 'POST') return await unsubscribe(req, env);
      if (path === '/api/push/test' && req.method === 'POST') return await testPush(req, env);
      if (path === '/api/ai/insight' && req.method === 'POST') return await aiInsight(req, env);
      if (path === '/api/ai/status' && req.method === 'GET') return await aiStatus(env);
      if (path === '/api/prices' && req.method === 'GET') return await prices(new URL(req.url), env);
      if (path === '' || path === '/') return json({ ok: true, service: 'bamboo-push' });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
    return json({ ok: false, error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAll(env));
  }
};
