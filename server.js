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
      rate: Number(s.rate) || 0,
      min: Number.isFinite(Number(s.min)) && Number(s.min) > 0 ? Number(s.min) : 1,
      max: Number.isFinite(Number(s.max)) && Number(s.max) > 0 ? Number(s.max) : 1000000000,
      refill: !!s.refill, cancel: !!s.cancel
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Turns low-level Firebase/Firestore failures into a message you can act on (instead of a blank "Server error").
function describeError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  if (code === 5 || (/\bNOT_FOUND\b/.test(msg) && /firestore|database|project/i.test(msg)))
    return 'Firestore database not found. Open Firebase Console > Firestore Database and create the database (Native mode) for this project.';
  if (code === 7 || /PERMISSION_DENIED|Missing or insufficient permissions|API has not been used|SERVICE_DISABLED/i.test(msg))
    return 'Firestore refused access. Enable the "Cloud Firestore API" in Google Cloud and give the service account the "Cloud Datastore User" (or Firebase Admin) role.';
  if (code === 16 || /UNAUTHENTICATED|invalid_grant|DECODER|invalid.*private key|Getting metadata from plugin failed|Could not load the default credentials/i.test(msg))
    return 'Firebase rejected the service account key (invalid, revoked or altered). Generate a new key and update FIREBASE_SERVICE_ACCOUNT.';
  if (code === 8 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return 'Firestore quota exceeded. Try again later or upgrade the plan.';
  if (code === 4 || code === 14 || /DEADLINE_EXCEEDED|UNAVAILABLE|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg))
    return 'The database is temporarily unreachable. Please try again.';
  return '';
}

async function updateWithRetry(ref, data, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await ref.update(data); }
    catch (e) { if (i === tries - 1) throw e; await sleep(500 * (i + 1)); }
  }
}

// An order stuck in 'sending' (server crashed / DB error mid-approval) is released after 5 minutes.
const STALE_SENDING_MS = 5 * 60 * 1000;
function isStaleSending(o) {
  if (!o || o.status !== 'sending') return false;
  const t = o.updatedAt && typeof o.updatedAt.toMillis === 'function' ? o.updatedAt.toMillis() : 0;
  return Date.now() - t > STALE_SENDING_MS;
}

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
const normOrigin = (o) => String(o).trim().toLowerCase().replace(/\/$/, '').replace('://www.', '://');
const ORIGINS_N = ORIGINS.map(normOrigin);
app.use(cors({
  origin(origin, cb) {
    if (!origin || !ORIGINS_N.length || ORIGINS_N.includes(normOrigin(origin))) return cb(null, true);
    console.warn('Blocked by CORS. Add this exact origin to ALLOWED_ORIGINS: ' + origin);
    cb(new HttpError(403, 'Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

/* ---------- diagnostics (admin only): shows exactly what is misconfigured ---------- */
app.get('/api/admin/diagnostics', requireAdmin, ah(async (req, res) => {
  const out = { node: process.version, adminEmail: ADMIN_EMAIL, allowedOrigins: ORIGINS, providerKeySet: !!PROVIDER_KEY, firestore: 'ok', provider: 'ok' };
  try { await db.collection('platforms').limit(1).get(); }
  catch (e) { out.firestore = describeError(e) || ('error: ' + String(e.message).slice(0, 200)); }
  try { const b = await provider({ action: 'balance' }); out.providerBalance = b.balance + ' ' + (b.currency || ''); }
  catch (e) { out.provider = e.message; }
  try { out.ordersStuckInSending = (await db.collection('orders').where('status', '==', 'sending').limit(50).get()).size; }
  catch (e) { out.ordersStuckInSending = 'unknown'; }
  res.json(out);
}));

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
    const stale = isStaleSending(order);
    if (!['processing', 'cancelled'].includes(order.status) && !stale) throw new HttpError(409, 'Order is already ' + order.status);
    if (stale) prev = 'processing';
    tx.update(ref, { status: 'sending', updatedAt: FV.serverTimestamp() });
  });

  const release = (e) => ref.update({ status: prev, lastError: String((e && e.message) || e).slice(0, 300), updatedAt: FV.serverTimestamp() })
    .catch((x) => console.error('Could not release order ' + ref.id + ':', x.message));

  const stamp = { approvedBy: req.admin.email, approvedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(), lastError: FV.delete() };
  let warning = '', pid = '', providerOrderId = '';
  try {
    const [mapSnap, svcSnap] = await Promise.all([
      db.collection('serviceMap').doc(String(order.serviceId)).get(),
      db.collection('services').doc(String(order.serviceId)).get()
    ]);
    if (svcSnap.exists) {
      const expected = round2(Number(svcSnap.data().rate) * Number(order.quantity) / 1000);
      if (Math.abs(expected - Number(order.amount)) > 1) warning = `Amount differs from the price list (paid ${order.amount}, list ${expected}). Check the payment.`;
    }
    if (!mapSnap.exists) { // service without provider mapping = manual fulfilment
      await updateWithRetry(ref, { ...stamp, status: 'completed', fulfilment: 'manual' });
      return res.json({ ok: true, status: 'completed', manual: true, warning });
    }
    pid = String(mapSnap.data().providerServiceId);
    if (!order.link || !(Number(order.quantity) > 0)) throw new HttpError(422, 'Order has no link or quantity');
    const r = await provider({ action: 'add', service: pid, link: String(order.link), quantity: Number(order.quantity) });
    if (!r || !r.order) throw new HttpError(502, 'Provider did not return an order ID');
    providerOrderId = String(r.order);
  } catch (e) {
    await release(e);   // nothing was sent: put the order back so it can be approved/declined again
    throw e;
  }

  // The provider has the order now. Saving must not silently fail, or the order could be sent twice.
  console.log(`Order ${req.params.id} -> provider order ${providerOrderId}`);
  try {
    await updateWithRetry(ref, { ...stamp, status: 'inprogress', providerOrderId, providerServiceId: pid, providerStatus: 'Pending' });
  } catch (e) {
    console.error(`!! Order ${req.params.id} WAS SENT to provider as ${providerOrderId} but saving failed:`, e);
    throw new HttpError(500, `Order was sent to the provider (provider order ${providerOrderId}) but saving it failed. Do NOT approve it again; note this ID.`);
  }
  res.json({ ok: true, status: 'inprogress', providerOrderId, warning });
}));

app.post('/api/admin/orders/:id/decline', requireAdmin, ah(async (req, res) => {
  const ref = db.collection('orders').doc(String(req.params.id));
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpError(404, 'Order not found');
    const o = s.data();
    if (o.providerOrderId) throw new HttpError(409, 'Already sent to the provider, it cannot be declined here');
    if (o.status === 'sending' && !isStaleSending(o)) throw new HttpError(409, 'Order is being sent right now. Try again in a few minutes');
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
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const st = err && (err.status || err.statusCode);
  if (st >= 400 && st < 500) { // body-parser etc. (bad JSON, body too large)
    const msg = err.type === 'entity.parse.failed' ? 'Invalid JSON in request body'
      : err.type === 'entity.too.large' ? 'Request body too large' : (err.message || 'Bad request');
    return res.status(st).json({ error: msg });
  }
  console.error(`[${req.method} ${req.originalUrl}]`, err);       // full details are in the server logs
  const friendly = describeError(err);
  const body = { error: friendly || 'Server error' };
  if (req.admin) body.detail = String((err && err.message) || err).slice(0, 200); // only admins see the raw reason
  res.status(friendly ? 503 : 500).json(body);
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

app.listen(PORT, () => {
  console.log('VENOMIX backend listening on ' + PORT);
  if (!PROVIDER_KEY) console.warn('WARNING: PROVIDER_API_KEY is not set');
  if (!ORIGINS.length) console.warn('WARNING: ALLOWED_ORIGINS is empty, any website can call this API (admin routes still need a login)');
  db.collection('platforms').limit(1).get()
    .then(() => console.log('Firestore connection OK'))
    .catch((e) => console.error('!! FIRESTORE CHECK FAILED:', describeError(e) || e.message, '(code ' + e.code + ')'));
});
// background sync while the instance is awake
setInterval(() => { syncAll().catch((e) => console.error('sync failed:', e.message)); }, 10 * 60 * 1000);
