import { randomId, sha256, now, fail, hashPassword } from './util.js';

const SESSION_DAYS = 14;
const COOKIE = 'ab_session';
const PUBLIC_USER = 'id, role, name, email, phone, social, status, code, commission_rate, payout_method, payout_account, created_at';

export const publicUser = (db, id) => db.get(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`, id);

export function ensureAdmin(db, config) {
  if (db.get("SELECT id FROM users WHERE role = 'admin'")) return false;
  if (!config.adminEmail || config.adminPassword.length < 10) {
    throw new Error('.env mein ADMIN_EMAIL aur ADMIN_PASSWORD (kam az kam 10 characters) set karein.');
  }
  db.run(
    "INSERT INTO users (role, name, email, pass_hash, status, created_at) VALUES ('admin', 'Admin', ?, ?, 'active', ?)",
    config.adminEmail, hashPassword(config.adminPassword), now(),
  );
  return true;
}

export function newAffiliateCode(db, name) {
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'AFF';
  for (;;) {
    const code = base + randomId(4).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (!db.get('SELECT id FROM users WHERE code = ?', code)) return code;
  }
}

const cookie = (config, value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.appUrl.startsWith('https:') ? '; Secure' : ''}`;

export function startSession(db, config, res, userId) {
  const token = randomId(32);
  db.run('DELETE FROM sessions WHERE expires_at < ?', now());
  db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    sha256(token), userId, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  res.setHeader('Set-Cookie', cookie(config, token, SESSION_DAYS * 86400));
}

const readToken = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)ab_session=([^;]+)/)?.[1];

export function endSession(db, config, req, res) {
  const token = readToken(req);
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.setHeader('Set-Cookie', cookie(config, '', 0));
}

export function currentUser(db, req) {
  const token = readToken(req);
  if (!token) return null;
  const row = db.get(
    "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'",
    sha256(token), now(),
  );
  return row ? publicUser(db, row.user_id) : null;
}

const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const t = Date.now();
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowMs }); return; }
  if (++b.n > max) fail(429, 'Bohat zyada koshishen. Thori dair baad dobara karein.');
}
