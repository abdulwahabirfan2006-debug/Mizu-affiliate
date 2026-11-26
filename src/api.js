import { fail, text, email, password, number, optionalRate, httpUrl, toMinor, now, daysAgo, hashPassword, checkPassword } from './util.js';
import { publicUser, newAffiliateCode, startSession, endSession, rateLimit } from './auth.js';
import { balance, STATUS_SQL } from './orders.js';
import { DEFAULT_SETTINGS } from './db.js';

const routes = [];
/** access: 'public' | 'user' | 'admin' | 'affiliate' */
function route(method, pattern, access, handler) {
  const regex = new RegExp(`^${pattern.replace(/:id/g, '(\\d+)')}$`);
  routes.push({ method, regex, access, handler });
}

export function matchRoute(method, path) {
  for (const r of routes) {
    const m = r.method === method && path.match(r.regex);
    if (m) return { ...r, id: m[1] ? Number(m[1]) : null };
  }
  return null;
}

const found = (row) => row || fail(404, 'Record nahi mila');
const affiliateOf = (db, id) => found(db.get("SELECT * FROM users WHERE id = ? AND role = 'affiliate'", Number(id)));
const publicSettings = (db) => {
  const { store_name, currency, default_commission, cookie_days, hold_days, min_payout } = db.settings();
  return { store_name, currency, default_commission, cookie_days, hold_days, min_payout };
};

// ---------- Auth ----------
route('GET', '/api/me', 'public', ({ db, config, user }) => ({
  user, settings: publicSettings(db), appUrl: config.appUrl,
}));

route('POST', '/api/login', 'public', ({ db, config, res, body, ip }) => {
  const mail = String(body.email || '').trim().toLowerCase();
  rateLimit(`login:${ip}:${mail}`, 10, 15 * 60000);
  const row = db.get('SELECT * FROM users WHERE email = ?', mail);
  if (!row || !checkPassword(String(body.password || ''), row.pass_hash)) fail(401, 'Email ya password ghalat hai');
  if (row.status === 'pending') fail(403, 'Aap ka account abhi approval ke intezar mein hai');
  if (row.status === 'blocked') fail(403, 'Yeh account band hai');
  startSession(db, config, res, row.id);
  return { ok: true };
});

route('POST', '/api/logout', 'public', ({ db, config, req, res }) => { endSession(db, config, req, res); return { ok: true }; });

function createAffiliate(db, body, status) {
  const name = text(body.name, 'Naam', { max: 60 });
  const mail = email(body.email);
  const pass = password(body.password);
  if (db.get('SELECT id FROM users WHERE email = ?', mail)) fail(409, 'Is email se account pehle se hai');
  const info = db.run(
    `INSERT INTO users (role, name, email, phone, social, pass_hash, status, code, created_at)
     VALUES ('affiliate', ?, ?, ?, ?, ?, ?, ?, ?)`,
    name, mail, text(body.phone, 'Phone', { max: 30, min: 0 }), text(body.social, 'Social link', { max: 200, min: 0 }),
    hashPassword(pass), status, newAffiliateCode(db, name), now(),
  );
  return publicUser(db, Number(info.lastInsertRowid));
}

route('POST', '/api/signup', 'public', ({ db, body, ip }) => {
  rateLimit(`signup:${ip}`, 5, 60 * 60000);
  createAffiliate(db, body, 'pending');
  return { ok: true };
});

route('POST', '/api/password', 'user', ({ db, config, res, user, body }) => {
  const row = db.get('SELECT pass_hash FROM users WHERE id = ?', user.id);
  if (!checkPassword(String(body.current || ''), row.pass_hash)) fail(400, 'Purana password ghalat hai');
  db.run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(password(body.password)), user.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  startSession(db, config, res, user.id);
  return { ok: true };
});

route('PUT', '/api/profile', 'affiliate', ({ db, user, body }) => {
  db.run('UPDATE users SET phone = ?, social = ?, payout_method = ?, payout_account = ? WHERE id = ?',
    text(body.phone, 'Phone', { max: 30, min: 0 }), text(body.social, 'Social link', { max: 200, min: 0 }),
    text(body.payout_method, 'Payment tareeqa', { max: 40, min: 0 }), text(body.payout_account, 'Account detail', { max: 200, min: 0 }), user.id);
  return { ok: true };
});

// ---------- Overview ----------
route('GET', '/api/overview', 'user', ({ db, user, query }) => {
  const days = [7, 30, 90].includes(Number(query.get('days'))) ? Number(query.get('days')) : 30;
  const settings = db.settings();
  const shift = `${settings.tz_offset >= 0 ? '+' : ''}${Math.round(settings.tz_offset)} minutes`;
  const dayOf = (ms) => new Date(ms + settings.tz_offset * 60000).toISOString().slice(0, 10);
  // Range local din ke shuru se
  const firstDay = dayOf(Date.now() - (days - 1) * 86400000);
  const since = new Date(Date.parse(`${firstDay}T00:00:00Z`) - settings.tz_offset * 60000).toISOString();

  const mine = user.role === 'affiliate';
  const filter = mine ? ' AND affiliate_id = ?' : '';
  const args = mine ? [since, user.id] : [since];
  const valid = "cancelled = 0 AND review != 'rejected'";

  const clicks = db.get(`SELECT COUNT(*) AS clicks, COALESCE(SUM(is_unique), 0) AS visitors FROM clicks WHERE created_at >= ?${filter}`, ...args);
  const sales = db.get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(sales), 0) AS sales, COALESCE(SUM(commission), 0) AS commission,
            COALESCE(SUM(method = 'link'), 0) AS by_link
     FROM orders WHERE created_at >= ?${filter} AND ${valid} AND (sales > 0 OR commission > 0)`, ...args);

  const series = new Map();
  for (let i = 0; i < days; i++) {
    const d = dayOf(Date.now() - (days - 1 - i) * 86400000);
    series.set(d, { date: d, clicks: 0, orders: 0, sales: 0, commission: 0 });
  }
  for (const r of db.all(`SELECT date(created_at, ?) AS d, COUNT(*) AS clicks FROM clicks WHERE created_at >= ?${filter} GROUP BY d`, shift, ...args)) {
    if (series.has(r.d)) series.get(r.d).clicks = r.clicks;
  }
  for (const r of db.all(
    `SELECT date(created_at, ?) AS d, COUNT(*) AS orders, SUM(sales) AS sales, SUM(commission) AS commission
     FROM orders WHERE created_at >= ?${filter} AND ${valid} AND (sales > 0 OR commission > 0) GROUP BY d`, shift, ...args)) {
    if (series.has(r.d)) Object.assign(series.get(r.d), { orders: r.orders, sales: r.sales, commission: r.commission });
  }

  const out = {
    days,
    totals: { ...clicks, ...sales, conversion: clicks.visitors ? (sales.by_link / clicks.visitors) * 100 : 0 },
    series: [...series.values()],
  };
  if (mine) {
    out.balance = balance(db, user.id);
  } else {
    out.top = db.all(
      `SELECT u.id, u.name, u.code,
        (SELECT COUNT(*) FROM clicks c WHERE c.affiliate_id = u.id AND c.created_at >= ?) AS clicks,
        COUNT(o.shopify_id) AS orders, COALESCE(SUM(o.sales), 0) AS sales, COALESCE(SUM(o.commission), 0) AS commission
       FROM users u LEFT JOIN orders o ON o.affiliate_id = u.id AND o.created_at >= ? AND o.cancelled = 0
         AND o.review != 'rejected' AND (o.sales > 0 OR o.commission > 0)
       WHERE u.role = 'affiliate' AND u.status = 'active'
       GROUP BY u.id ORDER BY sales DESC, clicks DESC LIMIT 5`, since, since);
    out.todo = {
      affiliates: db.get("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").n,
      payouts: db.get("SELECT COUNT(*) AS n FROM payouts WHERE status = 'requested'").n,
      reviews: db.get("SELECT COUNT(*) AS n FROM orders WHERE review = 'flagged' AND cancelled = 0").n,
    };
  }
  return out;
});

// ---------- Products ----------
route('GET', '/api/products', 'user', ({ db, user }) => ({
  products: db.all(
    `SELECT p.*,
       (SELECT COUNT(*) FROM clicks c WHERE c.product_id = p.id ${user.role === 'affiliate' ? 'AND c.affiliate_id = ?' : ''}) AS clicks
     FROM products p ${user.role === 'affiliate' ? 'WHERE p.active = 1' : ''} ORDER BY p.id DESC`,
    ...(user.role === 'affiliate' ? [user.id] : [])),
  myRate: user.role === 'affiliate' ? user.commission_rate ?? db.settings().default_commission : null,
}));

function productFields(body) {
  const handle = String(body.handle || '').trim().replace(/^.*\/products\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  if (handle && !/^[\p{L}\p{N}_-]+$/u.test(handle)) fail(400, 'Product handle ya link sahi nahi hai');
  if (!handle) fail(400, 'Shopify product ka link ya handle zaroori hai');
  return [
    text(body.title, 'Product ka naam', { max: 200 }), handle, toMinor(number(body.price, 'Price')),
    httpUrl(body.image_url, 'Image link'), optionalRate(body.commission_rate), body.active === false ? 0 : 1,
  ];
}

route('POST', '/api/products', 'admin', ({ db, body }) => {
  db.run('INSERT INTO products (title, handle, price, image_url, commission_rate, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ...productFields(body), now());
  return { ok: true };
});

route('PUT', '/api/products/:id', 'admin', ({ db, body, id }) => {
  found(db.get('SELECT id FROM products WHERE id = ?', id));
  db.run('UPDATE products SET title = ?, handle = ?, price = ?, image_url = ?, commission_rate = ?, active = ? WHERE id = ?',
    ...productFields(body), id);
  return { ok: true };
});

route('DELETE', '/api/products/:id', 'admin', ({ db, id }) => { db.run('DELETE FROM products WHERE id = ?', id); return { ok: true }; });

route('POST', '/api/products/import', 'admin', async ({ db, shopify }) => ({ imported: await shopify.importProducts(db) }));

// ---------- Affiliates ----------
route('GET', '/api/affiliates', 'admin', ({ db }) => ({
  affiliates: db.all("SELECT id FROM users WHERE role = 'affiliate' ORDER BY status = 'pending' DESC, id DESC").map(({ id }) => ({
    ...publicUser(db, id),
    ...db.get('SELECT COUNT(*) AS clicks FROM clicks WHERE affiliate_id = ?', id),
    ...db.get("SELECT COUNT(*) AS orders, COALESCE(SUM(sales), 0) AS sales FROM orders WHERE affiliate_id = ? AND cancelled = 0 AND review != 'rejected' AND (sales > 0 OR commission > 0)", id),
    balance: balance(db, id),
  })),
}));

route('POST', '/api/affiliates', 'admin', ({ db, body }) => ({ affiliate: createAffiliate(db, body, 'active') }));

route('PUT', '/api/affiliates/:id', 'admin', ({ db, body, id }) => {
  const a = affiliateOf(db, id);
  if (body.status !== undefined) {
    if (!['active', 'blocked'].includes(body.status)) fail(400, 'Status ghalat hai');
    db.run('UPDATE users SET status = ? WHERE id = ?', body.status, a.id);
    if (body.status === 'blocked') db.run('DELETE FROM sessions WHERE user_id = ?', a.id);
  }
  if (body.commission_rate !== undefined) db.run('UPDATE users SET commission_rate = ? WHERE id = ?', optionalRate(body.commission_rate), a.id);
  if (body.password) {
    db.run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(password(body.password)), a.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', a.id);
  }
  return { ok: true };
});

// ---------- Discount codes ----------
route('GET', '/api/discounts', 'user', ({ db, user }) => ({
  discounts: db.all(
    `SELECT d.id, d.affiliate_id, d.code, d.percent, d.status, d.created_at, u.name AS affiliate,
       (SELECT COUNT(*) FROM orders o WHERE o.code = d.code AND o.cancelled = 0 AND o.review != 'rejected') AS orders
     FROM discounts d JOIN users u ON u.id = d.affiliate_id
     ${user.role === 'affiliate' ? 'WHERE d.affiliate_id = ?' : ''} ORDER BY d.id DESC`,
    ...(user.role === 'affiliate' ? [user.id] : [])),
}));

const pendingCodes = new Set();
route('POST', '/api/discounts', 'admin', async ({ db, body, shopify }) => {
  const a = affiliateOf(db, body.affiliate_id);
  const code = text(body.code, 'Code', { max: 30, min: 3 }).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) fail(400, 'Code mein sirf A-Z, 0-9, - aur _ chalte hain');
  const percent = number(body.percent, 'Discount %', { min: 1, max: 90 });
  if (pendingCodes.has(code) || db.get('SELECT id FROM discounts WHERE code = ?', code)) fail(409, 'Yeh code pehle se bana hua hai');
  pendingCodes.add(code);
  try {
    const gid = shopify.connected ? await shopify.createDiscount({ code, percent, title: `Affiliate ${a.name} - ${code}` }) : null;
    db.run('INSERT INTO discounts (affiliate_id, code, percent, shopify_gid, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      a.id, code, percent, gid, gid ? 'synced' : 'manual', now());
    return { ok: true, synced: Boolean(gid) };
  } finally {
    pendingCodes.delete(code);
  }
});

route('POST', '/api/discounts/:id/disable', 'admin', async ({ db, id, shopify }) => {
  const d = found(db.get('SELECT * FROM discounts WHERE id = ?', id));
  if (d.shopify_gid) await shopify.disableDiscount(d.shopify_gid);
  db.run("UPDATE discounts SET status = 'disabled' WHERE id = ?", id);
  return { ok: true, manual: !d.shopify_gid };
});

// ---------- Orders ----------
route('GET', '/api/orders', 'user', ({ db, user }) => ({
  orders: db.all(
    `SELECT o.shopify_id AS id, o.name, o.method, o.code, o.currency, o.sales, o.commission, o.created_at,
       u.name AS affiliate, ${STATUS_SQL} AS status
     FROM orders o JOIN users u ON u.id = o.affiliate_id
     ${user.role === 'affiliate' ? 'WHERE o.affiliate_id = ?' : ''} ORDER BY o.created_at DESC LIMIT 500`,
    daysAgo(db.settings().hold_days), ...(user.role === 'affiliate' ? [user.id] : [])),
}));

route('PUT', '/api/orders/:id', 'admin', ({ db, body, id }) => {
  const review = { approve: 'approved', reject: 'rejected' }[body.decision] || fail(400, 'Faisla ghalat hai');
  found(db.get('SELECT shopify_id FROM orders WHERE shopify_id = ?', String(id)));
  db.run('UPDATE orders SET review = ? WHERE shopify_id = ?', review, String(id));
  return { ok: true };
});

// ---------- Payouts ----------
route('GET', '/api/payouts', 'user', ({ db, user }) => ({
  payouts: db.all(
    `SELECT p.*, u.name AS affiliate FROM payouts p JOIN users u ON u.id = p.affiliate_id
     ${user.role === 'affiliate' ? 'WHERE p.affiliate_id = ?' : ''} ORDER BY p.status = 'requested' DESC, p.id DESC`,
    ...(user.role === 'affiliate' ? [user.id] : [])),
  balance: user.role === 'affiliate' ? balance(db, user.id) : null,
}));

route('POST', '/api/payouts', 'affiliate', ({ db, user }) => {
  const settings = db.settings();
  if (!user.payout_method || !user.payout_account) fail(400, 'Pehle Settings mein apni payment detail save karein');
  if (db.get("SELECT id FROM payouts WHERE affiliate_id = ? AND status = 'requested'", user.id)) fail(409, 'Aik request pehle se pending hai');
  const { available } = balance(db, user.id);
  if (available <= 0 || available < toMinor(settings.min_payout)) fail(400, `Kam az kam ${settings.currency} ${settings.min_payout} hone chahiye`);
  db.run('INSERT INTO payouts (affiliate_id, amount, method, account, created_at) VALUES (?, ?, ?, ?, ?)',
    user.id, available, user.payout_method, user.payout_account, now());
  return { ok: true };
});

route('PUT', '/api/payouts/:id', 'admin', ({ db, body, id }) => {
  const p = found(db.get('SELECT * FROM payouts WHERE id = ?', id));
  if (p.status !== 'requested') fail(409, 'Is request par faisla ho chuka hai');
  if (!['paid', 'rejected'].includes(body.status)) fail(400, 'Status ghalat hai');
  // Request ke baad refund aa gaya ho to zyada payment rok dein
  if (body.status === 'paid' && balance(db, p.affiliate_id).available < 0) {
    fail(409, 'Request ke baad refund/cancel hua hai. Is ko reject karein taake nayi raqam se request aaye.');
  }
  db.run('UPDATE payouts SET status = ?, reference = ?, processed_at = ? WHERE id = ?',
    body.status, text(body.reference, 'Reference', { max: 100, min: 0 }), now(), id);
  return { ok: true };
});

// ---------- Settings ----------
route('GET', '/api/settings', 'admin', ({ db, config, shopify }) => ({
  settings: db.settings(),
  shopify: {
    store: config.shopify.store,
    connected: shopify.connected,
    webhookSecret: Boolean(config.shopify.webhookSecret || config.shopify.clientSecret),
    webhookUrl: `${config.appUrl}/webhooks/shopify`,
    snippet: `<script src="${config.appUrl}/tracker.js" defer></script>`,
    https: config.appUrl.startsWith('https:'),
  },
}));

route('PUT', '/api/settings', 'admin', ({ db, body }) => {
  const limits = {
    default_commission: [0, 90], cookie_days: [1, 365], hold_days: [0, 120],
    min_payout: [0, 1e9], tz_offset: [-720, 840], auto_apply_discount: [0, 1],
  };
  const clean = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (body[key] === undefined) continue;
    if (key in limits) clean[key] = number(body[key], key, { min: limits[key][0], max: limits[key][1] });
    else if (key === 'storefront_url') {
      const url = httpUrl(body[key], 'Store link');
      clean[key] = url ? new URL(url).origin : '';
    } else clean[key] = text(body[key], key, { max: key === 'currency' ? 3 : 60 });
  }
  if (clean.currency) {
    clean.currency = clean.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(clean.currency)) fail(400, 'Currency 3 letters ki ho, jaise PKR');
  }
  for (const [k, v] of Object.entries(clean)) db.setSetting(k, v);
  return { ok: true };
});

route('POST', '/api/shopify/webhooks', 'admin', async ({ config, shopify }) => {
  if (!config.appUrl.startsWith('https:')) fail(400, 'Webhooks ke liye APP_URL https wala public address hona chahiye');
  return { results: await shopify.registerWebhooks(`${config.appUrl}/webhooks/shopify`) };
});
