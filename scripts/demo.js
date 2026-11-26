// Farzi data ke sath app chalata hai. Asli database ko nahi chhoota. Sirf isi computer par khulta hai.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { handleOrder } from '../src/orders.js';
import { hashPassword, now, daysAgo, randomId } from '../src/util.js';

const PASSWORD = 'demo-pass-123';
const dbPath = path.join(ROOT, 'data', 'demo.db');
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });

const port = Number(process.env.PORT || 3000);
const config = loadConfig({
  APP_URL: `http://localhost:${port}`, PORT: String(port), ADMIN_EMAIL: 'admin@demo.test', ADMIN_PASSWORD: PASSWORD,
  SHOPIFY_STORE: '', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '', SHOPIFY_ACCESS_TOKEN: '', SHOPIFY_WEBHOOK_SECRET: '',
});
const db = openDb(dbPath);
const server = createApp({ config, db });

db.setSetting('store_name', 'Demo Home Store');
db.setSetting('storefront_url', 'https://example.com');

// Har dafa ek jaisa data
let seed = 7;
const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const pick = (list) => list[Math.floor(random() * list.length)];

const products = [
  ['Bamboo Drawer Organizer', 1850], ['Floating Wall Shelf Set', 2400], ['Rotating Spice Rack', 2950],
  ['Under-Bed Storage Box', 1450], ['Ceramic Planter Trio', 2200], ['Over-Door Hanger', 950],
].map(([title, price], i) => {
  db.run('INSERT INTO products (shopify_id, title, handle, price, commission_rate, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    String(100 + i), title, title.toLowerCase().replace(/\s+/g, '-'), price * 100, i === 2 ? 15 : null, now());
  return { id: 100 + i, title, price };
});

const affiliates = [['Ayesha Demo', 'AYESHA10', 'active'], ['Bilal Demo', 'BILAL10', 'active'], ['Hira Demo', 'HIRA10', 'active'], ['Usman Demo', null, 'pending']]
  .map(([name, discount, status], i) => {
    const code = `${name.split(' ')[0].toUpperCase()}DEMO`;
    const id = Number(db.run(
      `INSERT INTO users (role, name, email, pass_hash, status, code, payout_method, payout_account, created_at)
       VALUES ('affiliate', ?, ?, ?, ?, ?, 'Bank transfer', 'Demo account', ?)`,
      name, `${name.split(' ')[0].toLowerCase()}@demo.test`, hashPassword(PASSWORD), status, code, now()).lastInsertRowid);
    if (discount) db.run("INSERT INTO discounts (affiliate_id, code, percent, status, created_at) VALUES (?, ?, 10, 'synced', ?)", id, discount, now());
    return { id, code, discount, status };
  }).filter((a) => a.status === 'active');

let orderNo = 1001;
for (let day = 29; day >= 0; day--) {
  for (const [i, a] of affiliates.entries()) {
    const clicks = Math.floor(random() * (22 - i * 6)) + 2;
    for (let c = 0; c < clicks; c++) {
      const at = new Date(Date.now() - day * 86400000 - random() * 3600000).toISOString();
      const clickId = randomId(12);
      const product = pick(products);
      db.run('INSERT INTO clicks (id, affiliate_id, product_id, visitor_hash, is_unique, created_at) VALUES (?, ?, (SELECT id FROM products WHERE shopify_id = ?), ?, ?, ?)',
        clickId, a.id, String(product.id), randomId(8), random() > 0.2 ? 1 : 0, at);
      if (random() > 0.09) continue;
      const qty = random() > 0.8 ? 2 : 1;
      const orderId = String(orderNo);
      handleOrder(db, 'orders/create', {
        id: orderId, name: `#${orderNo++}`, created_at: at, currency: 'PKR', total_price: String(product.price * qty + 200),
        note_attributes: [{ name: 'aff_ref', value: a.code }, { name: 'aff_click', value: clickId }],
        discount_codes: random() > 0.6 ? [{ code: a.discount }] : [],
        line_items: [{ id: `${orderId}1`, product_id: product.id, title: product.title, price: String(product.price), quantity: qty }],
      });
      // COD: purane orders deliver ho kar paid, kuch cancel
      if (day > 2 && random() > 0.12) db.run('UPDATE orders SET paid_at = ? WHERE shopify_id = ?', daysAgo(day - 2), orderId);
      else if (day > 2) db.run('UPDATE orders SET cancelled = 1 WHERE shopify_id = ?', orderId);
    }
  }
}
db.run("INSERT INTO payouts (affiliate_id, amount, method, account, created_at) VALUES (?, 100000, 'Bank transfer', 'Demo account', ?)", affiliates[1].id, now());

server.listen(port, '127.0.0.1', () => {
  console.log(`\nDEMO chal raha hai: http://localhost:${port}
  Admin:     admin@demo.test  /  ${PASSWORD}
  Affiliate: ayesha@demo.test /  ${PASSWORD}
Band karne ke liye Ctrl+C\n`);
});
