import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function loadConfig(overrides = {}) {
  const env = { ...readEnvFile(path.join(ROOT, '.env')), ...process.env, ...overrides };
  const port = Number(env.PORT || 3000);
  return {
    port,
    appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    dbPath: env.DB_PATH ? path.resolve(ROOT, env.DB_PATH) : path.join(ROOT, 'data', 'app.db'),
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    trustProxy: env.TRUST_PROXY === '1',
    shopify: {
      store: (env.SHOPIFY_STORE || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^your-store\.myshopify\.com$/, ''),
      clientId: env.SHOPIFY_CLIENT_ID || '',
      clientSecret: env.SHOPIFY_CLIENT_SECRET || '',
      accessToken: env.SHOPIFY_ACCESS_TOKEN || '',
      webhookSecret: env.SHOPIFY_WEBHOOK_SECRET || '',
      apiVersion: env.SHOPIFY_API_VERSION || '2026-10',
    },
  };
}
