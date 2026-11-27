import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { HttpError, fail, randomId, sha256, now, daysAgo } from './util.js';
import { currentUser, ensureAdmin } from './auth.js';
import { matchRoute } from './api.js';
import { createShopify, verifyWebhook } from './shopify.js';
import { handleOrder, handleRefund } from './orders.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const BOTS = /(?<!cu)bot|crawl|spider|slurp|facebookexternalhit|^whatsapp\/|link.?preview|headless|curl\/|wget|python-requests/i;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request bohat bari hai')); req.resume(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function createApp({ config, db, fetchImpl }) {
  ensureAdmin(db, config);
  const shopify = createShopify(config, fetchImpl);
  const ipSalt = db.secret('ip_salt', () => randomId(24));

  const clientIp = (req) =>
    (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';

  /** Affiliate link: click record karo aur store par bhejo */
  function click(req, res, code, url) {
    const settings = db.settings();
    const base = settings.storefront_url;
    const product = db.get('SELECT * FROM products WHERE id = ? AND active = 1', Number(url.searchParams.get('p')) || 0);
    const affiliate = db.get("SELECT id, code FROM users WHERE code = ? AND status = 'active'", code.toUpperCase());
    let target = product ? `/products/${encodeURIComponent(product.handle)}` : '/';
    const ua = String(req.headers['user-agent'] || '');

    if (affiliate && req.method === 'GET' && ua && !BOTS.test(ua)) {
      const visitor = sha256(`${ipSalt}|${clientIp(req)}|${ua}`);
      const seen = db.get('SELECT 1 AS x FROM clicks WHERE visitor_hash = ? AND affiliate_id = ? AND created_at >= ?', visitor, affiliate.id, daysAgo(1));
      const id = randomId(12);
      let referrer = '';
      try { referrer = new URL(req.headers.referer).hostname; } catch { /* referrer nahi */ }
      db.run('INSERT INTO clicks (id, affiliate_id, product_id, visitor_hash, is_unique, referrer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, affiliate.id, product?.id ?? null, visitor, seen ? 0 : 1, referrer, now());
      target += `?aff=${affiliate.code}&clk=${id}`;
      const discount = settings.auto_apply_discount &&
        db.get("SELECT code FROM discounts WHERE affiliate_id = ? AND status = 'synced' ORDER BY id DESC", affiliate.id);
      if (discount) target = `/discount/${encodeURIComponent(discount.code)}?redirect=${encodeURIComponent(target)}`;
    }
    res.writeHead(302, { Location: base + target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer-when-downgrade' });
    res.end();
  }

  async function webhook(req, res) {
    const raw = await readBody(req, 2_000_000);
    if (!verifyWebhook(config, raw, req.headers['x-shopify-hmac-sha256'])) return send(res, 401, { error: 'invalid signature' });
    const shop = String(req.headers['x-shopify-shop-domain'] || '').toLowerCase();
    if (config.shopify.store && shop && shop !== config.shopify.store) return send(res, 401, { error: 'unknown shop' });
    const topic = String(req.headers['x-shopify-topic'] || '');
    const payload = JSON.parse(raw.toString('utf8'));
    let result = { ignored: topic };
    if (['orders/create', 'orders/paid', 'orders/cancelled'].includes(topic)) result = handleOrder(db, topic, payload);
    else if (topic === 'refunds/create') result = handleRefund(db, payload);
    console.log(`webhook ${topic}:`, JSON.stringify(result));
    send(res, 200, { ok: true });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const link = p.match(/^\/r\/([A-Za-z0-9]{1,24})$/);
    if (link && ['GET', 'HEAD'].includes(req.method)) return click(req, res, link[1], url);

    if (p === '/webhooks/shopify' && req.method === 'POST') return webhook(req, res);

    if (p === '/tracker.js' && req.method === 'GET') {
      const js = fs.readFileSync(path.join(ROOT, 'public', 'tracker.js'), 'utf8').replace('__COOKIE_DAYS__', String(db.settings().cookie_days));
      return send(res, 200, js, 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=300' });
    }

    if (STATIC[p] && req.method === 'GET') {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), type, {
        'Content-Security-Policy': "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'Referrer-Policy': 'same-origin',
      });
    }

    const route = p.startsWith('/api/') && matchRoute(req.method, p);
    if (!route) return send(res, 404, { error: 'Nahi mila' });

    let body = {};
    if (req.method !== 'GET') {
      // CSRF se bachao: sirf apni site se JSON requests
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'JSON chahiye');
      const origin = req.headers.origin;
      if (origin && origin !== new URL(config.appUrl).origin && URL.parse(origin)?.host !== req.headers.host) fail(403, 'Origin ghalat hai');
      const raw = await readBody(req, 100_000);
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { fail(400, 'Data ghalat hai'); }
      if (!body || typeof body !== 'object') fail(400, 'Data ghalat hai');
    }
    const user = currentUser(db, req);
    if (route.access !== 'public' && !user) fail(401, 'Pehle login karein');
    if (['admin', 'affiliate'].includes(route.access) && user.role !== route.access) fail(403, 'Is ki ijazat nahi');
    const out = await route.handler({ db, config, shopify, req, res, body, user, id: route.id, query: url.searchParams, ip: clientIp(req) });
    send(res, 200, out);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!(e instanceof HttpError)) console.error(e);
      if (res.headersSent) return res.end();
      send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Server mein masla aa gaya' });
    });
  });
}
