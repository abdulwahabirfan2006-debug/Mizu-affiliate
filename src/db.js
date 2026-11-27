import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','affiliate')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  social TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','blocked')),
  code TEXT UNIQUE,
  commission_rate REAL,
  payout_method TEXT NOT NULL DEFAULT '',
  payout_account TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  shopify_id TEXT UNIQUE,
  title TEXT NOT NULL,
  handle TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  image_url TEXT NOT NULL DEFAULT '',
  commission_rate REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER,
  visitor_hash TEXT NOT NULL,
  is_unique INTEGER NOT NULL,
  referrer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clicks_aff ON clicks(affiliate_id, created_at);
CREATE INDEX IF NOT EXISTS clicks_visitor ON clicks(visitor_hash, affiliate_id, created_at);
CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL UNIQUE,
  percent REAL NOT NULL,
  shopify_gid TEXT,
  status TEXT NOT NULL CHECK (status IN ('synced','manual','disabled')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  shopify_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  affiliate_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  total INTEGER NOT NULL,
  taxes_included INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL,
  sales INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  paid_at TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  review TEXT NOT NULL DEFAULT '' CHECK (review IN ('','flagged','approved','rejected')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_aff ON orders(affiliate_id, created_at);
CREATE TABLE IF NOT EXISTS refunds (
  shopify_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  items TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS refunds_order ON refunds(order_id);
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')),
  reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const DEFAULT_SETTINGS = {
  store_name: 'Mizu Affiliate Program',
  logo_url: '',
  rules: [
    'Commission 10% hai.',
    'Order deliver na ho, cancel ho ya parcel wapas aaye to commission nahi milega.',
    'Creators ko bheja gaya product wapas dena hoga.',
    'Video mein product ki sirf wohi khoobiyan batayein jo us mein waqai hain. Apni taraf se koi khoobi nahi.',
    'Video mein songs ya music istemal nahi hoga.',
  ].join('\n'),
  storefront_url: '',
  currency: 'PKR',
  default_commission: 10,
  cookie_days: 30,
  hold_days: 7,
  min_payout: 1000,
  tz_offset: 300,
  auto_apply_discount: 1,
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA);
  const db = {
    all: (sql, ...p) => raw.prepare(sql).all(...p),
    get: (sql, ...p) => raw.prepare(sql).get(...p),
    run: (sql, ...p) => raw.prepare(sql).run(...p),
    close: () => raw.close(),
    settings() {
      const out = { ...DEFAULT_SETTINGS };
      for (const r of db.all('SELECT key, value FROM settings')) {
        if (r.key in DEFAULT_SETTINGS) out[r.key] = typeof DEFAULT_SETTINGS[r.key] === 'number' ? Number(r.value) : r.value;
      }
      return out;
    },
    setSetting(key, value) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
    },
    secret(key, make) {
      const row = db.get('SELECT value FROM settings WHERE key = ?', key);
      if (row) return row.value;
      const value = make();
      db.setSetting(key, value);
      return value;
    },
  };
  return db;
}
