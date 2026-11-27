import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const SECRET = 'test-secret';
const STORE = 'test-store.myshopify.com';

async function setup() {
  const shopifyCalls = [];
  const fakeShopify = async (url, options) => {
    if (url.endsWith('/access_token')) return Response.json({ access_token: 't', expires_in: 86399 });
    const { query, variables } = JSON.parse(options.body);
    shopifyCalls.push({ query, variables });
    if (query.includes('discountCodeBasicCreate')) return Response.json({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://d/1' }, userErrors: [] } } });
    if (query.includes('discountCodeDeactivate')) return Response.json({ data: { discountCodeDeactivate: { userErrors: [] } } });
    if (query.includes('webhookSubscriptionCreate')) return Response.json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: '1' }, userErrors: [] } } });
    return Response.json({ data: { products: { pageInfo: { hasNextPage: false }, nodes: [{ legacyResourceId: '555', title: 'Shelf', handle: 'shelf', featuredMedia: null, priceRangeV2: { minVariantPrice: { amount: '1000.0' } } }] } } });
  };
  const config = loadConfig({
    APP_URL: 'http://localhost:3999', ADMIN_EMAIL: 'admin@t.test', ADMIN_PASSWORD: 'admin-pass-123', TRUST_PROXY: '1',
    SHOPIFY_STORE: STORE, SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: SECRET, SHOPIFY_ACCESS_TOKEN: '', SHOPIFY_WEBHOOK_SECRET: '',
  });
  const db = openDb(':memory:');
  const server = createApp({ config, db, fetchImpl: fakeShopify });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let ipCounter = 0;
  const client = () => {
    let cookie = '';
    const ip = `10.0.0.${++ipCounter}`;
    return async (path, method = 'GET', body, headers = {}) => {
      const res = await fetch(base + path, {
        method, redirect: 'manual',
        headers: { ...(method !== 'GET' && { 'Content-Type': 'application/json' }), 'X-Forwarded-For': ip, Cookie: cookie, ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const textBody = await res.text();
      let data = textBody;
      try { data = JSON.parse(textBody); } catch { /* text */ }
      return { status: res.status, data, headers: res.headers };
    };
  };

  const hook = async (topic, payload, secret = SECRET, shop = STORE) => {
    const raw = JSON.stringify(payload);
    const res = await fetch(`${base}/webhooks/shopify`, {
      method: 'POST', body: raw,
      headers: { 'X-Shopify-Topic': topic, 'X-Shopify-Shop-Domain': shop, 'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', secret).update(raw).digest('base64') },
    });
    return res.status;
  };

  const admin = client();
  await admin('/api/login', 'POST', { email: 'admin@t.test', password: 'admin-pass-123' });
  const makeAffiliate = async (name) => {
    const mail = `${name}@t.test`;
    const r = await admin('/api/affiliates', 'POST', { name, email: mail, password: 'aff-pass-1234', phone: name === 'sara' ? '03001234567' : '' });
    const as = client();
    await as('/api/login', 'POST', { email: mail, password: 'aff-pass-1234' });
    return { ...r.data.affiliate, as };
  };
  const click = async (aff, ua = 'Mozilla/5.0 Chrome', query = '') => {
    const r = await client()(`/r/${aff.code}${query}`, 'GET', undefined, { 'User-Agent': ua });
    return r.headers.get('location');
  };
  return { db, server, admin, client, hook, makeAffiliate, click, shopifyCalls };
}

const order = (id, extra = {}) => ({
  id, name: `#${id}`, currency: 'PKR', total_price: '2200.00', financial_status: 'pending', created_at: new Date().toISOString(),
  line_items: [{ id: id * 10, product_id: 555, title: 'Shelf', price: '1000.00', quantity: 2, discount_allocations: [] }], ...extra,
});
const fromLink = (location) => {
  const u = new URL(location);
  const target = u.searchParams.get('redirect') ? new URL(u.searchParams.get('redirect'), u) : u;
  return [{ name: 'aff_ref', value: target.searchParams.get('aff') }, { name: 'aff_click', value: target.searchParams.get('clk') }];
};

test('signup pending rehta hai, approval ke baad login', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const visitor = s.client();
  const body = { name: 'New', email: 'new@t.test', password: 'new-pass-1234', role: 'admin', status: 'active' };
  assert.equal((await visitor('/api/signup', 'POST', body)).status, 400, 'rules qabool kiye baghair nahi');
  assert.equal((await visitor('/api/signup', 'POST', { ...body, accept_rules: '1' })).status, 200);
  assert.equal((await visitor('/api/login', 'POST', body)).status, 403);
  const [a] = (await s.admin('/api/affiliates')).data.affiliates;
  assert.equal(a.role, 'affiliate');
  await s.admin(`/api/affiliates/${a.id}`, 'PUT', { status: 'active' });
  assert.equal((await visitor('/api/login', 'POST', body)).status, 200);
  assert.equal((await visitor('/api/me')).data.user.pass_hash, undefined);
});

test('affiliate admin kaam nahi kar sakta, doosron ka data nahi dekhta', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const ali = await s.makeAffiliate('ali');
  const sara = await s.makeAffiliate('sara');
  await s.hook('orders/create', order(1, { note_attributes: fromLink(await s.click(ali)) }));
  for (const [path, method] of [['/api/affiliates', 'GET'], ['/api/settings', 'GET'], ['/api/discounts', 'POST'], ['/api/products', 'POST'], ['/api/orders/1', 'PUT'], ['/api/payouts/1', 'PUT']]) {
    assert.equal((await sara.as(path, method)).status, 403, path);
  }
  assert.equal((await sara.as('/api/orders')).data.orders.length, 0);
  assert.equal((await ali.as('/api/orders')).data.orders.length, 1);
  assert.equal((await s.client()('/api/orders')).status, 401);
  // Ghair site se request
  assert.equal((await s.admin('/api/settings', 'PUT', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.admin('/api/settings', 'PUT', {}, { Origin: 'null' })).status, 403);
  // Block hote hi session khatam
  await s.admin(`/api/affiliates/${ali.id}`, 'PUT', { status: 'blocked' });
  assert.equal((await ali.as('/api/orders')).status, 401);
});

test('click tracking: unique, bot, redirect sirf store par', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const ali = await s.makeAffiliate('ali');
  const location = await s.click(ali, 'Mozilla/5.0', '?url=https://evil.example&p=999');
  assert.ok(location.startsWith(`https://${STORE}/?aff=${ali.code}&clk=`));
  assert.equal(await s.click(ali, 'facebookexternalhit/1.1'), `https://${STORE}/`);
  await s.click(ali, 'Mozilla/5.0 (Linux; Android 12; CUBOT NOTE)');
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM clicks').n, 2);
});

test('webhook signature aur shop check hota hai', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  assert.equal(await s.hook('orders/create', order(1), 'wrong'), 401);
  assert.equal(await s.hook('orders/create', order(1), SECRET, 'other.myshopify.com'), 401);
  assert.equal(await s.hook('orders/create', order(1)), 200);
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM orders').n, 0, 'bina affiliate wala order save nahi hota');
});

test('COD safar: pending, paid, partial refund, duplicate, cancel', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const ali = await s.makeAffiliate('ali');
  const o = order(5, { note_attributes: fromLink(await s.click(ali)), total_discount: '0' });
  o.line_items[0].discount_allocations = [{ amount: '200.00' }];
  await s.hook('orders/create', o);
  const get = async () => (await ali.as('/api/orders')).data.orders[0];
  assert.deepEqual([(await get()).sales, (await get()).commission, (await get()).status], [180000, 18000, 'pending']);
  await s.hook('orders/paid', { ...o, financial_status: 'paid' });
  assert.equal((await get()).status, 'holding');
  await s.admin('/api/settings', 'PUT', { hold_days: 0 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await get()).status, 'approved');
  const refund = { id: 90, order_id: 5, refund_line_items: [{ line_item_id: 50, subtotal: '900.00', total_tax: '0' }] };
  await s.hook('refunds/create', refund);
  await s.hook('refunds/create', refund);
  await s.hook('orders/create', o);
  assert.equal((await get()).commission, 9000);
  assert.equal((await get()).status, 'approved', 'purana create webhook paid status nahi hatata');
  await s.hook('orders/cancelled', { ...o, cancelled_at: new Date().toISOString() });
  await s.hook('orders/paid', o);
  assert.equal((await get()).status, 'cancelled');
});

test('refund order se pehle aaye, tax-included store, sirf raqam wala refund', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const ali = await s.makeAffiliate('ali');
  await s.hook('refunds/create', { id: 91, order_id: 6, refund_line_items: [{ line_item_id: 60, subtotal: '1160.00', total_tax: '160.00' }] });
  const o = order(6, { taxes_included: true, note_attributes: fromLink(await s.click(ali)) });
  o.line_items[0] = { ...o.line_items[0], price: '1160.00', tax_lines: [{ price: '320.00' }] };
  await s.hook('orders/create', o);
  assert.equal(s.db.get("SELECT sales FROM orders WHERE shopify_id = '6'").sales, 100000);
  await s.hook('orders/create', order(7, { total_price: '2000.00', note_attributes: fromLink(await s.click(ali)) }));
  await s.hook('refunds/create', { id: 92, order_id: 7, transactions: [{ kind: 'refund', status: 'success', amount: '500.00' }] });
  assert.equal(s.db.get("SELECT commission FROM orders WHERE shopify_id = '7'").commission, 15000);
});

test('discount code Shopify par banta hai aur link se upar hai', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const ali = await s.makeAffiliate('ali');
  const sara = await s.makeAffiliate('sara');
  const r = await s.admin('/api/discounts', 'POST', { affiliate_id: sara.id, code: 'sara15', percent: 15 });
  assert.equal(r.data.synced, true);
  const input = s.shopifyCalls[0].variables.basicCodeDiscount;
  assert.deepEqual([input.code, input.customerGets.value.percentage, input.context.all], ['SARA15', 0.15, 'ALL']);
  await s.hook('orders/create', order(8, { discount_codes: [{ code: 'Sara15' }], note_attributes: fromLink(await s.click(ali)) }));
  assert.equal((await sara.as('/api/orders')).data.orders[0].method, 'code');
  // Auto discount wala link: zariya link hi rehta hai
  const location = await s.click(sara);
  assert.ok(location.includes('/discount/SARA15?redirect='));
  await s.hook('orders/create', order(9, { discount_codes: [{ code: 'SARA15' }], note_attributes: fromLink(location) }));
  assert.equal(s.db.get("SELECT method FROM orders WHERE shopify_id = '9'").method, 'link');
  const id = (await s.admin('/api/discounts')).data.discounts[0].id;
  assert.equal((await s.admin(`/api/discounts/${id}/disable`, 'POST')).status, 200);
});

test('product import, product commission, webhooks https ke baghair nahi', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const ali = await s.makeAffiliate('ali');
  await s.admin('/api/products', 'POST', { title: 'Shelf', handle: 'https://x.com/products/shelf?a=1', price: 1000, commission_rate: 20 });
  assert.equal((await s.admin('/api/products/import', 'POST')).data.imported, 1);
  const { products } = (await s.admin('/api/products')).data;
  assert.deepEqual([products.length, products[0].shopify_id, products[0].commission_rate], [1, '555', 20]);
  await s.hook('orders/create', order(10, { note_attributes: fromLink(await s.click(ali, 'Mozilla', `?p=${products[0].id}`)) }));
  assert.equal(s.db.get('SELECT commission FROM orders').commission, 40000);
  assert.equal((await s.admin('/api/products', 'POST', { title: 'x', handle: 'x', price: 1, image_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await s.admin('/api/shopify/webhooks', 'POST')).status, 400);
});

test('payout, self-referral review, refund ke baad payment rukti hai', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const sara = await s.makeAffiliate('sara');
  await s.admin('/api/settings', 'PUT', { hold_days: 0, min_payout: 100 });
  await s.hook('orders/paid', order(11, { phone: '+92 300 1234567', note_attributes: fromLink(await s.click(sara)) }));
  assert.equal((await sara.as('/api/orders')).data.orders[0].status, 'review');
  await sara.as('/api/profile', 'PUT', { payout_method: 'JazzCash', payout_account: 'x' });
  assert.equal((await sara.as('/api/payouts', 'POST')).status, 400);
  await s.admin('/api/orders/11', 'PUT', { decision: 'approve' });
  assert.equal((await sara.as('/api/payouts', 'POST')).status, 200);
  assert.equal((await sara.as('/api/payouts', 'POST')).status, 409);
  await s.hook('orders/cancelled', order(11));
  const id = (await s.admin('/api/payouts')).data.payouts[0].id;
  assert.equal((await s.admin(`/api/payouts/${id}`, 'PUT', { status: 'paid' })).status, 409);
  assert.equal((await s.admin(`/api/payouts/${id}`, 'PUT', { status: 'rejected' })).status, 200);
  const o = (await s.admin('/api/overview?days=7')).data;
  assert.equal(o.series.length, 7);
});

test('deliver na hone wala order: commission khatam, baad ke webhooks wapas nahi laate', async (t) => {
  const s = await setup(); t.after(() => s.server.close());
  const ali = await s.makeAffiliate('ali');
  await s.admin('/api/settings', 'PUT', { hold_days: 0 });
  const o = order(12, { note_attributes: fromLink(await s.click(ali)) });
  await s.hook('orders/create', o);
  await s.admin('/api/orders/12', 'PUT', { decision: 'reject' });
  await s.hook('orders/paid', o);
  assert.equal((await ali.as('/api/orders')).data.orders[0].status, 'rejected');
  const { balance } = (await ali.as('/api/overview')).data;
  assert.deepEqual([balance.pending, balance.holding, balance.available], [0, 0, 0]);
});
