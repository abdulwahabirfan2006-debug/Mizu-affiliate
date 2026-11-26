// Shopify order/refund webhooks ko affiliate commission mein badalta hai.
import { toMinor, now, daysAgo } from './util.js';

const attr = (order, key) => String((order.note_attributes || []).find((a) => a.name === key)?.value ?? '');
const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** Discount code ko link par tarjeeh hai: customer ne jo code lagaya us ka affiliate jeet-ta hai. */
function attribute(db, order, settings) {
  const ref = attr(order, 'aff_ref').toUpperCase();
  const clickId = attr(order, 'aff_click');
  const clicked = ref && clickId ? db.get(
    `SELECT u.* FROM clicks c JOIN users u ON u.id = c.affiliate_id
     WHERE c.id = ? AND u.code = ? AND u.status = 'active' AND c.created_at >= ?`,
    clickId, ref,
    new Date(new Date(order.created_at || Date.now()).getTime() - settings.cookie_days * 86400000).toISOString(),
  ) : null;
  for (const d of order.discount_codes || []) {
    const row = db.get(
      `SELECT d.code AS discount_code, u.* FROM discounts d JOIN users u ON u.id = d.affiliate_id
       WHERE d.code = ? AND d.status != 'disabled' AND u.status = 'active'`,
      String(d.code || '').toUpperCase(),
    );
    // Link se aaya aur usi affiliate ka code laga (auto discount) to zariya "link" hai
    if (row) return { affiliate: row, method: clicked?.id === row.id ? 'link' : 'code', code: row.discount_code };
  }
  return clicked ? { affiliate: clicked, method: 'link', code: '' } : null;
}

/** Har line ki net qeemat (discount ke baad, tax aur shipping ke baghair) aur us ka rate. */
function lineItems(db, order, affiliate, settings) {
  return (order.line_items || []).map((li) => {
    const gross = toMinor(li.price) * Number(li.quantity || 0);
    const discount = li.discount_allocations?.length
      ? li.discount_allocations.reduce((s, d) => s + toMinor(d.amount), 0)
      : toMinor(li.total_discount);
    const tax = order.taxes_included ? (li.tax_lines || []).reduce((s, t) => s + toMinor(t.price), 0) : 0;
    // Import kiye products ID se milte hain, haath se add kiye naam se
    const product = db.get(
      `SELECT commission_rate FROM products
       WHERE shopify_id = ? OR (shopify_id IS NULL AND lower(title) = lower(?))
       ORDER BY shopify_id IS NULL LIMIT 1`,
      String(li.product_id || ''), String(li.title || ''),
    );
    // Gift card par commission nahi
    const rate = li.gift_card ? 0 : product?.commission_rate ?? affiliate.commission_rate ?? settings.default_commission;
    return { id: String(li.id), net: Math.max(0, gross - discount - tax), rate };
  });
}

export function recompute(db, orderId) {
  const order = db.get('SELECT * FROM orders WHERE shopify_id = ?', orderId);
  if (!order) return;
  const items = JSON.parse(order.items);
  const refunded = {};
  let looseAmount = 0;
  for (const r of db.all('SELECT items, amount FROM refunds WHERE order_id = ?', orderId)) {
    looseAmount += r.amount;
    for (const i of JSON.parse(r.items)) {
      // Tax-included store mein refund subtotal ke andar tax hota hai
      refunded[i.id] = (refunded[i.id] || 0) + i.amount - (order.taxes_included ? i.tax : 0);
    }
  }
  // Items ke baghair refund (sirf raqam wapas) -> usi tanasub se kami
  const keep = order.total > 0 ? Math.max(0, 1 - looseAmount / order.total) : 1;
  let sales = 0;
  let commission = 0;
  for (const i of items) {
    const left = Math.max(0, i.net - (refunded[i.id] || 0)) * keep;
    sales += left;
    commission += (left * i.rate) / 100;
  }
  db.run('UPDATE orders SET sales = ?, commission = ? WHERE shopify_id = ?', Math.round(sales), Math.round(commission), orderId);
}

export function handleOrder(db, topic, order) {
  const id = String(order.id || '');
  if (!id) return { ignored: 'no id' };
  const settings = db.settings();
  const paid = topic === 'orders/paid' || ['paid', 'partially_refunded', 'refunded'].includes(order.financial_status);
  const cancelled = topic === 'orders/cancelled' || Boolean(order.cancelled_at);
  const existing = db.get('SELECT shopify_id FROM orders WHERE shopify_id = ?', id);

  if (!existing) {
    if (order.test) return { ignored: 'test order' };
    const match = attribute(db, order, settings);
    if (!match) return { ignored: 'not an affiliate order' };
    const { affiliate } = match;
    // Apni hi link se khareedari: admin review kare
    const buyerEmail = String(order.email || order.customer?.email || '').toLowerCase();
    const buyerPhones = [order.phone, order.customer?.phone, order.shipping_address?.phone, order.billing_address?.phone].map(normPhone);
    const own = normPhone(affiliate.phone);
    const self = (buyerEmail && buyerEmail === affiliate.email) || (own.length === 10 && buyerPhones.includes(own));
    db.run(
      `INSERT INTO orders (shopify_id, name, affiliate_id, method, code, currency, total, taxes_included, items, sales, commission, review, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      id, String(order.name || `#${id}`), affiliate.id, match.method, match.code,
      String(order.currency || settings.currency), toMinor(order.total_price), order.taxes_included ? 1 : 0,
      JSON.stringify(lineItems(db, order, affiliate, settings)),
      self ? 'flagged' : '', new Date(order.created_at || Date.now()).toISOString(),
    );
  }
  // Flags sirf aagay barhte hain, is liye webhooks kisi bhi tarteeb mein aayen to theek rahta hai
  if (paid) db.run('UPDATE orders SET paid_at = COALESCE(paid_at, ?) WHERE shopify_id = ?', now(), id);
  if (cancelled) db.run('UPDATE orders SET cancelled = 1 WHERE shopify_id = ?', id);
  recompute(db, id);
  return { attributed: id };
}

export function handleRefund(db, refund) {
  const id = String(refund.id || '');
  const orderId = String(refund.order_id || '');
  if (!id || !orderId) return { ignored: 'no id' };
  const items = (refund.refund_line_items || []).map((r) => ({
    id: String(r.line_item_id),
    amount: toMinor(r.subtotal),
    tax: toMinor(r.total_tax),
  }));
  const shippingOnly = refund.refund_shipping_lines?.length || (refund.order_adjustments || []).some((a) => a.kind === 'shipping_refund');
  const amount = items.length || shippingOnly ? 0 : (refund.transactions || [])
    .filter((t) => t.kind === 'refund' && ['success', 'pending'].includes(t.status))
    .reduce((s, t) => s + toMinor(t.amount), 0);
  db.run('INSERT OR IGNORE INTO refunds (shopify_id, order_id, items, amount) VALUES (?, ?, ?, ?)', id, orderId, JSON.stringify(items), amount);
  recompute(db, orderId);
  return { refunded: orderId };
}

/** SQL expression: order ka status. Bind param: hold cutoff date. */
export const STATUS_SQL = `CASE
  WHEN o.cancelled = 1 THEN 'cancelled'
  WHEN o.review = 'rejected' THEN 'rejected'
  WHEN o.review = 'flagged' THEN 'review'
  WHEN o.commission = 0 AND o.sales = 0 THEN 'refunded'
  WHEN o.paid_at IS NULL THEN 'pending'
  WHEN o.paid_at > ? THEN 'holding'
  ELSE 'approved' END`;

export function balance(db, affiliateId) {
  const settings = db.settings();
  const cutoff = daysAgo(settings.hold_days);
  const sums = { pending: 0, holding: 0, approved: 0 };
  const rows = db.all(
    `SELECT status, SUM(commission) AS total FROM
       (SELECT ${STATUS_SQL} AS status, o.commission FROM orders o WHERE o.affiliate_id = ?)
     GROUP BY status`,
    cutoff, affiliateId,
  );
  for (const r of rows) {
    if (r.status === 'review') sums.pending += r.total;
    else if (r.status in sums) sums[r.status] += r.total;
  }
  const p = db.get(
    `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
            COALESCE(SUM(CASE WHEN status = 'requested' THEN amount END), 0) AS requested
     FROM payouts WHERE affiliate_id = ?`,
    affiliateId,
  );
  return { ...sums, paid: p.paid, requested: p.requested, available: sums.approved - p.paid - p.requested };
}
