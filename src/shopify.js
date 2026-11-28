// Shopify Admin GraphQL API
import crypto from 'node:crypto';
import { fail, toMinor, now } from './util.js';

export const WEBHOOK_TOPICS = ['ORDERS_CREATE', 'ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'];
export const REQUIRED_SCOPES = ['read_products', 'read_orders', 'write_discounts'];

/** App start par: keys aur permissions check karo, webhooks khud lagao, aur nateeja log mein likho */
export async function connectOnStart(config, shopify, log = console.log) {
  if (!shopify.connected) return log('Shopify keys nahi lagin: sales tracking band hai.');
  try {
    const missing = await shopify.missingScopes();
    log(missing.length ? `Shopify login OK, magar yeh scopes nahi mile: ${missing.join(', ')}` : 'Shopify login OK, saare scopes mil gaye.');
    if (!config.appUrl.startsWith('https://')) return log('Webhooks ke liye APP_URL https wala hona chahiye.');
    for (const r of await shopify.registerWebhooks(`${config.appUrl}/webhooks/shopify`)) {
      log(`Webhook ${r.topic}: ${r.ok ? 'OK' : 'FAIL'} (${r.message})`);
    }
  } catch (e) {
    log(`Shopify connect nahi ho saka: ${e.message}`);
  }
}

export function verifyWebhook(config, rawBody, header) {
  const given = Buffer.from(String(header || ''), 'base64');
  return [config.shopify.webhookSecret, config.shopify.clientSecret].filter(Boolean).some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/** Naya product add karo, ya pehle wale ko update (commission aur chhupa/dikhna admin ka rehta hai) */
function saveProduct(db, { id, title, handle, price, image }) {
  // Haath se add kiya wohi product ho to usay jor do, duplicate na bane
  db.run(
    `UPDATE products SET shopify_id = ? WHERE id = (SELECT id FROM products WHERE shopify_id IS NULL AND handle = ? LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM products WHERE shopify_id = ?)`,
    id, handle, id,
  );
  db.run(
    `INSERT INTO products (shopify_id, title, handle, price, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(shopify_id) DO UPDATE SET title = excluded.title, handle = excluded.handle,
       price = excluded.price, image_url = excluded.image_url`,
    id, title, handle, toMinor(price), image, now(),
  );
}

export function createShopify(config, fetchImpl = fetch) {
  const s = config.shopify;
  const connected = Boolean(s.store && (s.accessToken || (s.clientId && s.clientSecret)));
  let cached = null;

  async function token() {
    if (s.accessToken) return s.accessToken;
    if (cached && cached.expires > Date.now()) return cached.value;
    const res = await fetchImpl(`https://${s.store}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.clientId, client_secret: s.clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      fail(502, `Shopify login fail (${res.status}). Client ID/Secret check karein, aur app store par install ho.`);
    }
    // 5 minute pehle hi naya token
    cached = { value: data.access_token, expires: Date.now() + ((data.expires_in || 86399) - 300) * 1000 };
    return cached.value;
  }

  async function graphql(query, variables = {}) {
    if (!connected) fail(400, 'Shopify abhi connect nahi hai. Railway ke Variables mein keys dalein.');
    let res;
    try {
      res = await fetchImpl(`https://${s.store}/admin/api/${s.apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      if (e.status) throw e;
      fail(502, 'Shopify tak pohanch nahi ho saki. Store domain aur internet check karein.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors) {
      const msg = Array.isArray(body.errors) ? body.errors.map((e) => e.message).join('; ') : body.errors || res.statusText;
      fail(502, `Shopify error: ${msg}`);
    }
    return body.data;
  }

  async function importFromAdmin(db) {
    let after = null;
    let count = 0;
    do {
      const data = await graphql(
        `query Products($after: String) {
          products(first: 100, after: $after, query: "status:active") {
            pageInfo { hasNextPage endCursor }
            nodes {
              legacyResourceId title handle
              featuredMedia { preview { image { url } } }
              priceRangeV2 { minVariantPrice { amount } }
            }
          }
        }`,
        { after },
      );
      for (const p of data.products.nodes) {
        saveProduct(db, {
          id: String(p.legacyResourceId), title: p.title, handle: p.handle,
          price: p.priceRangeV2.minVariantPrice.amount, image: p.featuredMedia?.preview?.image?.url || '',
        });
        count++;
      }
      after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (after);
    return count;
  }

  /** API keys ke baghair: store ki public product list (sirf live products) */
  async function importFromStorefront(db) {
    const base = db.settings().storefront_url;
    if (!base) fail(400, 'Pehle Settings mein "Store link" dalein.');
    let count = 0;
    for (let page = 1; page <= 40; page++) {
      let list;
      try {
        const res = await fetchImpl(`${base}/products.json?limit=250&page=${page}`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000),
        });
        if (res.ok) list = (await res.json()).products;
      } catch { /* neeche error */ }
      if (!Array.isArray(list)) fail(502, 'Store se products nahi mile. Store link check karein, aur store par password na laga ho.');
      for (const p of list) {
        const prices = (p.variants || []).map((v) => Number(v.price)).filter(Number.isFinite);
        const image = String(p.images?.[0]?.src || '');
        saveProduct(db, {
          id: String(p.id), title: String(p.title), handle: String(p.handle),
          price: prices.length ? Math.min(...prices) : 0, image: image.startsWith('https://') ? image : '',
        });
        count++;
      }
      if (list.length < 250) break;
    }
    return count;
  }

  const userErrors = (list) => { if (list?.length) fail(400, `Shopify: ${list.map((e) => e.message).join('; ')}`); };

  return {
    connected,

    async createDiscount({ code, percent, title }) {
      const data = await graphql(
        `mutation CreateCode($basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
            codeDiscountNode { id }
            userErrors { field message }
          }
        }`,
        { basicCodeDiscount: {
          title, code, startsAt: now(),
          context: { all: 'ALL' },
          customerGets: { value: { percentage: percent / 100 }, items: { all: true } },
          appliesOncePerCustomer: false,
        } },
      );
      userErrors(data.discountCodeBasicCreate.userErrors);
      return data.discountCodeBasicCreate.codeDiscountNode.id;
    },

    async disableDiscount(id) {
      const data = await graphql(
        `mutation DisableCode($id: ID!) {
          discountCodeDeactivate(id: $id) { userErrors { field message } }
        }`,
        { id },
      );
      userErrors(data.discountCodeDeactivate.userErrors);
    },

    async missingScopes() {
      const data = await graphql('query { currentAppInstallation { accessScopes { handle } } }');
      const have = new Set(data.currentAppInstallation.accessScopes.map((s) => s.handle));
      // write_ scope mein read_ shamil hota hai
      return REQUIRED_SCOPES.filter((s) => !have.has(s) && !have.has(s.replace(/^read_/, 'write_')));
    },

    importProducts: (db) => (connected ? importFromAdmin(db) : importFromStorefront(db)),

    async registerWebhooks(uri) {
      const results = [];
      for (const topic of WEBHOOK_TOPICS) {
        const data = await graphql(
          `mutation Hook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
              webhookSubscription { id }
              userErrors { field message }
            }
          }`,
          { topic, webhookSubscription: { uri, format: 'JSON' } },
        );
        const errors = data.webhookSubscriptionCreate.userErrors;
        const exists = errors.some((e) => /already been taken/i.test(e.message));
        results.push({ topic, ok: !errors.length || exists, message: exists ? 'pehle se laga hua' : errors.map((e) => e.message).join('; ') || 'lag gaya' });
      }
      return results;
    },
  };
}
