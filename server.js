'use strict';
/* VENOMIX SMM backend
 * - keeps the CheapSMMMarket API key private (never in frontend code)
 * - admin approves an order  -> order is sent to the provider (action=add)
 * - syncs provider status back into Firestore (inprogress -> completed/cancelled)
 * - admin adds services by provider service ID + own name/price
 */
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

/* ---------------- config ---------------- */
const env = (k, d = '') => String(process.env[k] || d).trim();
const PROVIDER_URL = env('PROVIDER_API_URL', 'https://cheapsmmmarket.com/api/v2');
const PROVIDER_KEY = env('PROVIDER_API_KEY');
const ADMIN_EMAIL = env('ADMIN_EMAIL').toLowerCase();
const CRON_SECRET = env('CRON_SECRET');
const ORIGINS = env('ALLOWED_ORIGINS').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const TO_INR = Number(env('PROVIDER_CURRENCY_TO_INR', '0')) || 0;   // e.g. 90 if provider prices are in USD
const MARKUP = Number(env('DEFAULT_MARKUP_PERCENT', '30')) || 0;    // used only to suggest a selling price
const PORT = Number(process.env.PORT) || 3000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseServiceAccount(value) {
  let v = String(value || '').trim();
  v = v.replace(/^(export\s+)?FIREBASE_SERVICE_ACCOUNT(_B64)?\s*=\s*/, '');       // pasted with the variable name
  if (v.length > 1 && /^(["'])[\s\S]*\1$/.test(v) && !v.startsWith('"type"')) v = v.slice(1, -1).trim(); // wrapping quotes
  if (!v) return null;
  const tryJson = (s) => {
    s = s.trim();
    if (!s.startsWith('{')) s = '{' + s;
    if (!s.endsWith('}')) s = s + '}';
    try { const o = JSON.parse(s); return o && o.private_key ? o : null; } catch { return null; }
  };
  let sa = null;
  if (v.startsWith('{') || v.startsWith('"type"')) sa = tryJson(v);          // plain JSON (any layout)
  if (!sa) {                                                                  // base64 (whitespace tolerated)
    const clean = v.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) sa = tryJson(Buffer.from(clean, 'base64').toString('utf8'));
  }
  if (!sa) sa = tryJson(v);
  return sa;
}
function loadServiceAccount() {
  const vars = ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_B64'];
  const seen = [];
  for (const name of vars) {
    const val = env(name);
    if (!val) continue;
    const sa = parseServiceAccount(val);
    if (sa) {
      sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
      return sa;
    }
    seen.push(`${name} (${val.length} chars, starts "${val.slice(0, 4).replace(/[^\x20-\x7e]/g, '?')}")`);
  }
  throw new Error(seen.length
    ? 'Could not read the Firebase key from ' + seen.join(' and ') + '. Value is incomplete or altered; re-copy the full key.'
    : 'Set FIREBASE_SERVICE_ACCOUNT (or FIREBASE_SERVICE_ACCOUNT_B64) in the environment');
}
if (!ADMIN_EMAIL) { console.error('ADMIN_EMAIL is required'); process.exit(1); }
try {
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
} catch (e) { console.error('Firebase init failed:', e.message); process.exit(1); }
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

/* ---------------- provider (CheapSMMMarket, standard SMM API v2) ---------------- */
async function provider(params) {
  if (!PROVIDER_KEY) throw new HttpError(500, 'PROVIDER_API_KEY is not set on the server');
  const body = new URLSearchParams({ key: PROVIDER_KEY, ...params });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  let text;
  try {
    const res = await fetch(PROVIDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'venomix-backend/1.0' },
      body,
      signal: ctl.signal
    });
    text = await res.text();
  } catch (e) {
    throw new HttpError(502, e.name === 'AbortError' ? 'Provider timed out' : 'Could not reach the provider');
  } finally { clearTimeout(timer); }
  let j;
  try { j = JSON.parse(text); } catch { throw new HttpError(502, 'Provider returned an invalid response'); }
  if (j && !Array.isArray(j) && typeof j === 'object' && j.error) throw new HttpError(422, 'Provider: ' + j.error);
  return j;
}

let svcCache = { at: 0, data: [] };
async function providerServices(force) {
  if (!force && svcCache.data.length && Date.now() - svcCache.at < 5 * 60 * 1000) return svcCache.data;
  const list = await provider({ action: 'services' });
  if (!Array.isArray(list)) throw new HttpError(502, 'Provider returned an unexpected service list');
  svcCache = {
    at: Date.now(),
    data: list.map((s) => ({
      id: String(s.service), name: String(s.name || ''), category: String(s.category || ''), type: String(s.type || ''),
      rate: Number(s.rate), min: Number(s.min), max: Number(s.max), refill: !!s.refill, cancel: !!s.cancel
    }))
  };
  return svcCache.data;
}

function mapStatus(s) {
  s = String(s || '').toLowerCase();
  if (s === 'completed' || s === 'partial') return 'completed';
  if (s === 'canceled' || s === 'cancelled' || s === 'refunded' || s === 'fail' || s === 'failed') return 'cancelled';
  return 'inprogress'; // pending, processing, in progress
}
const round2 = (n) => Math.round(n * 100) / 100;

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, cb) {
    if (!origin || !ORIGINS.length || ORIGINS.includes(origin.replace(/\/$/, ''))) return cb(null, true);
    cb(new HttpError(403, 'Origin not allowed'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
}));
app.use(express.json({ limit: '20kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function requireAdmin(req, res, next) {
  try {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) throw new HttpError(401, 'Please login');
    let t;
    try { t = await admin.auth().verifyIdToken(m[1]); } catch { throw new HttpError(401, 'Login expired. Please login again'); }
    const email = String(t.email || '').toLowerCase();
    if (!email || !t.email_verified) throw new HttpError(403, 'Verify your email address first');
    let ok = email === ADMIN_EMAIL;
    if (!ok) ok = (await db.collection('admins').doc(email).get()).exists;
    if (!ok) throw new HttpError(403, 'Not an admin');
    req.admin = { email, uid: t.uid };
    next();
  } catch (e) { next(e); }
}

app.get(['/', '/health'], (req, res) => res.json({ ok: true, service: 'venomix-backend', time: new Date().toISOString() }));

/* ---------- provider info ---------- */
app.get('/api/admin/provider/balance', requireAdmin, ah(async (req, res) => {
  const b = await provider({ action: 'balance' });
  res.json({ balance: b.balance, currency: b.currency || '' });
}));

app.get('/api/admin/provider/services', requireAdmin, ah(async (req, res) => {
  const all = await providerServices(req.query.refresh === '1');
  const q = String(req.query.q || '').trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const matched = words.length
    ? all.filter((s) => { const hay = (s.id + ' ' + s.name + ' ' + s.category).toLowerCase(); return words.every((w) => hay.includes(w)); })
    : all;
  const items = matched.slice(0, 60).map((s) => {
    const costInr = TO_INR ? round2((s.rate * TO_INR)) : 0;
    return { ...s, costInr, suggestedRate: costInr ? round2(costInr * (1 + MARKUP / 100)) : 0 };
  });
  res.json({ total: all.length, matched: matched.length, items });
}));

/* ---------- my services (public doc + private provider mapping) ---------- */
app.get('/api/admin/service-map', requireAdmin, ah(async (req, res) => {
  const snap = await db.collection('serviceMap').get();
  const map = {};
  snap.forEach((d) => { const x = d.data(); map[d.id] = { providerServiceId: x.providerServiceId, providerRate: x.providerRate }; });
  res.json({ map });
}));

app.post('/api/admin/services', requireAdmin, ah(async (req, res) => {
  const b = req.body || {};
  const platform = String(b.platform || '').trim();
  const name = String(b.name || '').trim();
  const desc = String(b.desc || '').trim().slice(0, 300);
  const rate = Number(b.rate);
  let min = Number(b.min), max = Number(b.max);
  const pid = String(b.providerServiceId || '').trim();
  if (!platform || !(await db.collection('platforms').doc(platform).get()).exists) throw new HttpError(422, 'Choose a valid platform');
  if (name.length < 2 || name.length > 120) throw new HttpError(422, 'Service name must be 2-120 characters');
  if (!(rate > 0) || !(min > 0) || !(max >= min)) throw new HttpError(422, 'Rate, min and max are invalid');

  let mapping = null, clamped = false;
  if (pid) {
    if (!/^\d+$/.test(pid)) throw new HttpError(422, 'Provider service ID must be a number');
    const p = (await providerServices(false)).find((s) => s.id === pid) || (await providerServices(true)).find((s) => s.id === pid);
    if (!p) throw new HttpError(422, 'Provider service ' + pid + ' was not found at CheapSMMMarket');
    const nmin = Math.max(min, p.min), nmax = Math.min(max, p.max);
    if (nmax < nmin) throw new HttpError(422, `Provider allows ${p.min} - ${p.max} for this service`);
    clamped = nmin !== min || nmax !== max;
    min = nmin; max = nmax;
    mapping = { providerServiceId: pid, providerRate: p.rate, providerName: p.name, providerMin: p.min, providerMax: p.max };
  }
  const ref = db.collection('services').doc();
  const batch = db.batch();
  batch.set(ref, { platform, name, rate: round2(rate), min, max, desc, active: true });
  if (mapping) batch.set(db.collection('serviceMap').doc(ref.id), { ...mapping, createdBy: req.admin.email, createdAt: FV.serverTimestamp() });
  await batch.commit();
  res.json({ ok: true, id: ref.id, clamped, min, max });
}));

app.delete('/api/admin/services/:id', requireAdmin, ah(async (req, res) => {
  const id = String(req.params.id);
  const batch = db.batch();
  batch.delete(db.collection('services').doc(id));
  batch.delete(db.collection('serviceMap').doc(id));
  await batch.commit();
  res.json({ ok: true });
}));

/* ---------- orders ---------- */
app.post('/api/admin/orders/:id/approve', requireAdmin, ah(async (req, res) => {
  const ref = db.collection('orders').doc(String(req.params.id));
  let order, prev;
  // claim the order so it can never be sent twice
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpError(404, 'Order not found');
    order = s.data(); prev = order.status;
    if (order.providerOrderId) throw new HttpError(409, 'This order was already sent to the provider');
    if (!['processing', 'cancelled'].includes(order.status)) throw new HttpError(409, 'Order is already ' + order.status);
    tx.update(ref, { status: 'sending', updatedAt: FV.serverTimestamp() });
  });

  const stamp = { approvedBy: req.admin.email, approvedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(), lastError: FV.delete() };
  const [mapSnap, svcSnap] = await Promise.all([
    db.collection('serviceMap').doc(String(order.serviceId)).get(),
    db.collection('services').doc(String(order.serviceId)).get()
  ]);
  let warning = '';
  if (svcSnap.exists) {
    const expected = round2(Number(svcSnap.data().rate) * Number(order.quantity) / 1000);
    if (Math.abs(expected - Number(order.amount)) > 1) warning = `Amount differs from the price list (paid ${order.amount}, list ${expected}). Check the payment.`;
  }

  if (!mapSnap.exists) { // service without provider mapping = manual fulfilment
    await ref.update({ ...stamp, status: 'completed', fulfilment: 'manual' });
    return res.json({ ok: true, status: 'completed', manual: true, warning });
  }

  const pid = String(mapSnap.data().providerServiceId);
  let r;
  try {
    r = await provider({ action: 'add', service: pid, link: order.link, quantity: Number(order.quantity) });
    if (!r || !r.order) throw new HttpError(502, 'Provider did not return an order ID');
  } catch (e) {
    await ref.update({ status: prev, lastError: String(e.message).slice(0, 300), updatedAt: FV.serverTimestamp() }).catch(() => {});
    throw e;
  }
  console.log(`Order ${req.params.id} -> provider order ${r.order}`);
  await ref.update({ ...stamp, status: 'inprogress', providerOrderId: String(r.order), providerServiceId: pid, providerStatus: 'Pending' });
  res.json({ ok: true, status: 'inprogress', providerOrderId: String(r.order), warning });
}));

app.post('/api/admin/orders/:id/decline', requireAdmin, ah(async (req, res) => {
  const ref = db.collection('orders').doc(String(req.params.id));
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpError(404, 'Order not found');
    const o = s.data();
    if (o.providerOrderId) throw new HttpError(409, 'Already sent to the provider, it cannot be declined here');
    if (o.status === 'sending') throw new HttpError(409, 'Order is being sent right now');
    tx.update(ref, { status: 'cancelled', declinedBy: req.admin.email, updatedAt: FV.serverTimestamp() });
  });
  res.json({ ok: true, status: 'cancelled' });
}));

async function syncOne(ref) {
  const o = (await ref.get()).data();
  if (!o || !o.providerOrderId) throw new HttpError(422, 'This order has no provider order ID');
  const st = await provider({ action: 'status', order: o.providerOrderId });
  const upd = { providerStatus: st.status || '', providerRemains: Number(st.remains || 0), providerStartCount: Number(st.start_count || 0) };
  const ns = mapStatus(st.status);
  if (ns !== o.status) { upd.status = ns; upd.updatedAt = FV.serverTimestamp(); }
  await ref.update(upd);
  return { status: upd.status || o.status, providerStatus: st.status };
}
app.post('/api/admin/orders/:id/sync', requireAdmin, ah(async (req, res) => {
  res.json({ ok: true, ...(await syncOne(db.collection('orders').doc(String(req.params.id)))) });
}));

let syncing = false;
async function syncAll() {
  if (syncing) return { checked: 0, updated: 0, busy: true };
  syncing = true;
  try {
    const snap = await db.collection('orders').where('status', '==', 'inprogress').limit(500).get();
    const docs = snap.docs.filter((d) => d.data().providerOrderId);
    let updated = 0;
    for (let i = 0; i < docs.length; i += 100) {
      const chunk = docs.slice(i, i + 100);
      const r = await provider({ action: 'status', orders: chunk.map((d) => d.data().providerOrderId).join(',') });
      const batch = db.batch();
      chunk.forEach((d) => {
        const o = d.data(), st = r && r[o.providerOrderId];
        if (!st || st.error) return;
        const upd = { providerStatus: st.status || '', providerRemains: Number(st.remains || 0), providerStartCount: Number(st.start_count || 0) };
        const ns = mapStatus(st.status);
        if (ns !== o.status) { upd.status = ns; upd.updatedAt = FV.serverTimestamp(); updated++; }
        batch.update(d.ref, upd);
      });
      await batch.commit();
    }
    return { checked: docs.length, updated };
  } finally { syncing = false; }
}
app.post('/api/admin/sync', requireAdmin, ah(async (req, res) => res.json({ ok: true, ...(await syncAll()) })));

// For a free cron pinger (cron-job.org / UptimeRobot): keeps Render awake and syncs statuses.
app.get('/api/cron/sync', ah(async (req, res) => {
  const a = Buffer.from(String(req.query.token || '')), b = Buffer.from(CRON_SECRET);
  if (!CRON_SECRET || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Bad token');
  res.json({ ok: true, ...(await syncAll()) });
}));

/* ---------- refills ---------- */
app.post('/api/admin/refills/:id/send', requireAdmin, ah(async (req, res) => {
  const rref = db.collection('refills').doc(String(req.params.id));
  const rs = await rref.get();
  if (!rs.exists) throw new HttpError(404, 'Refill request not found');
  const rf = rs.data();
  if (rf.status !== 'pending') throw new HttpError(409, 'Refill is already ' + rf.status);
  const o = (await db.collection('orders').doc(String(rf.orderId)).get()).data();
  if (!o || !o.providerOrderId) throw new HttpError(422, 'This order was fulfilled manually. Refill it yourself, then mark it done');
  const r = await provider({ action: 'refill', order: o.providerOrderId });
  const rid = r && (r.refill || r.id);
  if (r && r.error) throw new HttpError(422, 'Provider: ' + r.error);
  await rref.update({ status: 'sent', providerRefillId: rid ? String(rid) : '', sentBy: req.admin.email, updatedAt: FV.serverTimestamp() });
  res.json({ ok: true, providerRefillId: rid ? String(rid) : '' });
}));

/* ---------- errors ---------- */
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log('VENOMIX backend listening on ' + PORT);
  if (!PROVIDER_KEY) console.warn('WARNING: PROVIDER_API_KEY is not set');
  if (!ORIGINS.length) console.warn('WARNING: ALLOWED_ORIGINS is empty, any website can call this API (admin routes still need a login)');
});
// background sync while the instance is awake
setInterval(() => { syncAll().catch((e) => console.error('sync failed:', e.message)); }, 10 * 60 * 1000);
