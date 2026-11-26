import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export const now = () => new Date().toISOString();
export const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** "1,299.50" -> 129950 (paisa/cents) */
export const toMinor = (v) => Math.round(Number(String(v ?? 0).replace(/,/g, '')) * 100) || 0;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function text(value, label, { max = 120, min = 1 } = {}) {
  const s = String(value ?? '').trim();
  if (s.length < min) fail(400, `${label} zaroori hai`);
  if (s.length > max) fail(400, `${label} bohat lamba hai`);
  return s;
}
export function email(value) {
  const s = text(value, 'Email', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, 'Email sahi nahi hai');
  return s;
}
export function password(value) {
  const s = String(value ?? '');
  if (s.length < 10) fail(400, 'Password kam az kam 10 characters ka ho');
  if (s.length > 200) fail(400, 'Password bohat lamba hai');
  return s;
}
export function number(value, label, { min = 0, max = 1e12 } = {}) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n < min || n > max) {
    fail(400, `${label} ${min} se ${max} ke darmiyan hona chahiye`);
  }
  return n;
}
export const optionalRate = (v) => (v === '' || v === null || v === undefined ? null : number(v, 'Commission %', { min: 0, max: 90 }));
export function httpUrl(value, label) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { fail(400, `${label} sahi URL nahi hai`); }
  if (!['http:', 'https:'].includes(u.protocol)) fail(400, `${label} http ya https se shuru ho`);
  return u.href;
}
