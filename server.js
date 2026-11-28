import { loadConfig } from './src/config.js';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { createShopify, connectOnStart } from './src/shopify.js';

/** Pehli dafa products khud le aao, taake dashboard khaali na ho */
async function firstImport(config, db) {
  if (db.get('SELECT 1 AS x FROM products WHERE shopify_id IS NOT NULL LIMIT 1')) return;
  try {
    const total = await createShopify(config).importProducts(db);
    const sample = db.get('SELECT title, price FROM products WHERE shopify_id IS NOT NULL ORDER BY id LIMIT 1');
    console.log(`Shopify se ${total} products import hue.${sample ? ` Misal: ${sample.title} = ${sample.price / 100}` : ''}`);
  } catch (e) {
    console.error(`Products import nahi ho sake: ${e.message}`);
  }
}

try {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const server = createApp({ config, db });
  server.listen(config.port, () => {
    console.log(`Mizu Affiliate Program chal raha hai: ${config.appUrl}`);
    firstImport(config, db);
    connectOnStart(config, createShopify(config));
  });
} catch (e) {
  console.error(`Start nahi ho saka: ${e.message}`);
  process.exit(1);
}
