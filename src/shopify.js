// Shopify Admin GraphQL API
import crypto from 'node:crypto';
import { fail, toMinor, now } from './util.js';

export const WEBHOOK_TOPICS = ['ORDERS_CREATE', 'ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'];

export function verifyWebhook(config, rawBody, header) {
  const given = Buffer.from(String(header || ''), 'base64');
  return [config.shopify.webhookSecret, config.shopify.clientSecret].filter(Boolean).some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
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
    if (!connected) fail(400, 'Shopify abhi connect nahi hai. .env file mein keys dalein.');
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

    async importProducts(db) {
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
          // Haath se add kiya wohi product ho to usay jor do, duplicate na bane
          db.run(
            `UPDATE products SET shopify_id = ? WHERE id = (SELECT id FROM products WHERE shopify_id IS NULL AND handle = ? LIMIT 1)
               AND NOT EXISTS (SELECT 1 FROM products WHERE shopify_id = ?)`,
            String(p.legacyResourceId), p.handle, String(p.legacyResourceId),
          );
          db.run(
            `INSERT INTO products (shopify_id, title, handle, price, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(shopify_id) DO UPDATE SET title = excluded.title, handle = excluded.handle,
               price = excluded.price, image_url = excluded.image_url`,
            String(p.legacyResourceId), p.title, p.handle, toMinor(p.priceRangeV2.minVariantPrice.amount),
            p.featuredMedia?.preview?.image?.url || '', now(),
          );
          count++;
        }
        after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
      } while (after);
      return count;
    },

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
