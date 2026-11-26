import { loadConfig } from './src/config.js';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';

try {
  const config = loadConfig();
  const server = createApp({ config, db: openDb(config.dbPath) });
  server.listen(config.port, () => console.log(`Affiliate Board chal raha hai: ${config.appUrl}`));
} catch (e) {
  console.error(`Start nahi ho saka: ${e.message}`);
  process.exit(1);
}
