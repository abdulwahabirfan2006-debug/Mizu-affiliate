const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const modal = $('#modal');
const state = { user: null, settings: {}, appUrl: '', days: 30, metric: 'sales', table: false, data: null, authMode: 'login' };

// ---------- Safe HTML ----------
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const render = (v) => (Array.isArray(v) ? v.map(render).join('') : v instanceof Safe ? v.s : v === false || v == null ? '' : esc(v));
const html = (parts, ...vals) => new Safe(parts.reduce((out, p, i) => out + p + (i < vals.length ? render(vals[i]) : ''), ''));

// ---------- Helpers ----------
async function api(path, method = 'GET', body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; show(); }
    throw new Error(data.error || 'Kuch masla ho gaya');
  }
  return data;
}
const money = (minor, cur = state.settings.currency) =>
  `${cur === 'PKR' ? 'Rs' : cur}\u00a0${(minor / 100).toLocaleString('en-PK', { maximumFractionDigits: minor % 100 ? 2 : 0, minimumFractionDigits: minor % 100 ? 2 : 0 })}`;
const count = (n) => Number(n || 0).toLocaleString('en-PK');
const date = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const isAdmin = () => state.user.role === 'admin';
const brand = () => html`<div class="brand">${state.settings.logo_url ? html`<img class="logo" src="${state.settings.logo_url}" alt="">` : html`<span class="mark"></span>`}${state.settings.store_name}</div>`;
const rulesList = () => html`<ul class="rules">${state.settings.rules.split('\n').filter((r) => r.trim()).map((r) => html`<li>${r}</li>`)}</ul>`;
// Shopify ki bari tasveer chhoti mangwao taake mobile par jaldi khule
const thumbUrl = (url) => (url.includes('cdn.shopify.com') ? `${url}${url.includes('?') ? '&' : '?'}width=600` : url);
const link = (productId) => `${state.appUrl}/r/${state.user.code}${productId ? `?p=${productId}` : ''}`;

let toastTimer;
function toast(message, error) {
  const t = $('#toast');
  (modal.open ? modal : document.body).append(t);
  t.textContent = message;
  t.className = error ? 'error' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ''; }, 4500);
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); toast('Copy ho gaya'); } catch {
    openModal('Copy karein', html`<form method="dialog"><input readonly value="${value}" aria-label="Link"><button>Band karein</button></form>`);
    $('input', modal).select();
  }
}

const STATUS = {
  pending: ['wait', '◷', 'Payment baqi'], holding: ['info', '◐', 'Return period'], approved: ['ok', '✓', 'Approved'],
  review: ['wait', '!', 'Review mein'], rejected: ['bad', '✕', 'Commission nahi'], cancelled: ['bad', '✕', 'Cancelled'], refunded: ['off', '↺', 'Refunded'],
  active: ['ok', '✓', 'Active'], blocked: ['bad', '✕', 'Blocked'], synced: ['ok', '✓', 'Shopify par live'],
  manual: ['wait', '!', 'Shopify mein khud banayein'], disabled: ['off', '–', 'Band'], requested: ['wait', '◷', 'Pending'], paid: ['ok', '✓', 'Paid'],
};
const chip = (s) => { const [cls, icon, label] = s === 'pending-user' ? ['wait', '◷', 'Approval baqi'] : STATUS[s]; return html`<span class="chip ${cls}"><span aria-hidden="true">${icon}</span>${label}</span>`; };

const head = (title, sub, actions = '') => html`<div class="head"><div><h1>${title}</h1><p>${sub}</p></div><div class="row">${actions}</div></div>`;
const empty = (title, textLine, action = '') => html`<div class="empty"><h3>${title}</h3><p>${textLine}</p>${action}</div>`;
/** columns: [label, cell(row), isNumber] */
const table = (columns, rows) => html`<div class="table"><table class="stack">
  <thead><tr>${columns.map(([l, , n]) => html`<th class="${n ? 'num' : ''}">${l}</th>`)}</tr></thead>
  <tbody>${rows.map((r) => html`<tr>${columns.map(([l, f, n]) => html`<td data-label="${l}" class="${n ? 'num' : ''}"><div>${f(r)}</div></td>`)}</tr>`)}</tbody></table></div>`;
const stat = (label, value) => html`<div class="stat"><span>${label}</span><b>${value}</b></div>`;

function openModal(title, body) {
  modal.innerHTML = html`<h2>${title}</h2>${body}`.s;
  if (!modal.open) modal.showModal();
}
const field = (label, name, attrs = '', hint = '') => html`<label>${label}<input name="${name}" ${new Safe(attrs)}>${hint && html`<small>${hint}</small>`}</label>`;
const val = (v) => `value="${esc(v)}"`;
const buttons = (label) => html`<div class="row"><button>${label}</button><button type="button" class="ghost" data-act="close">Wapas</button></div>`;

// ---------- Chart ----------
const METRICS = { sales: 'Sales', commission: 'Commission', clicks: 'Clicks', orders: 'Orders' };
const isMoney = (m) => m === 'sales' || m === 'commission';
const shortDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function chart(series) {
  const m = state.metric;
  const fmt = (v) => (isMoney(m) ? money(v) : count(v));
  if (state.table) {
    return table([['Date', (r) => shortDay(r.date)], [METRICS[m], (r) => fmt(r[m]), true]], [...series].reverse());
  }
  const values = series.map((r) => (isMoney(m) ? r[m] / 100 : r[m]));
  const peak = Math.max(...values, 0);
  const unit = 10 ** Math.floor(Math.log10(peak || 1));
  let top = [1, 2, 4, 6, 8, 10].map((k) => k * unit).find((v) => v >= peak) || 10 * unit;
  if (!isMoney(m)) top = Math.max(4, Math.ceil(top / 4) * 4);
  const W = Math.max(300, Math.min(1180, $('main').clientWidth - 80));
  const H = 250, L = 52, B = 24, T = 8;
  const step = (W - L) / series.length;
  const bw = Math.max(2, Math.min(24, step - 2));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const compact = (v) => Intl.NumberFormat('en', { notation: 'compact' }).format(v);
  const every = Math.ceil(series.length / Math.max(2, Math.floor((W - L) / 80)));
  return html`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rozana ${METRICS[m]}, pichle ${series.length} din">
    ${[0, 0.25, 0.5, 0.75, 1].map((f) => html`<line class="grid" x1="${L}" x2="${W}" y1="${y(top * f)}" y2="${y(top * f)}"/><text x="${L - 9}" y="${y(top * f) + 4}" text-anchor="end">${compact(top * f)}</text>`)}
    ${series.map((r, i) => {
      const x = L + i * step + (step - bw) / 2;
      const h = values[i] ? Math.max(2, H - B - y(values[i])) : 0;
      const rad = Math.min(4, bw / 2, h);
      const base = H - B;
      return html`${h > 0 && html`<path class="bar" d="M${x} ${base}v${-(h - rad)}q0 ${-rad} ${rad} ${-rad}h${bw - 2 * rad}q${rad} 0 ${rad} ${rad}v${h - rad}z"/>`}
        <rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${H - T - B}" tabindex="0" data-tip="${shortDay(r.date)}: ${fmt(r[m])}" aria-label="${shortDay(r.date)}: ${fmt(r[m])}"/>
        ${(series.length - 1 - i) % every === 0 && html`<text x="${Math.min(x + bw / 2, W - 20)}" y="${H - 5}" text-anchor="middle">${shortDay(r.date)}</text>`}`;
    })}
  </svg>`;
}
const chartPanel = (series) => html`<section class="panel"><header>
    <div class="seg" role="group" aria-label="Chart data">${Object.entries(METRICS).map(([k, l]) => html`<button data-act="metric" data-v="${k}" aria-pressed="${state.metric === k}">${l}</button>`)}</div>
    <button class="link" data-act="table">${state.table ? 'Chart dekhein' : 'Table dekhein'}</button>
  </header><div class="chart">${chart(series)}</div></section>`;

const period = () => html`<div class="seg" role="group" aria-label="Muddat">${[7, 30, 90].map((d) => html`<button data-act="days" data-v="${d}" aria-pressed="${state.days === d}">${d} din</button>`)}</div>`;

function wallet(b, action) {
  return html`<section class="wallet"><div class="top"><div><p>Nikalne ke liye tayyar</p><div class="big">${money(b.available)}</div></div>${action}</div>
    <ol class="flow">
      <li><span>Payment baqi</span><b>${money(b.pending)}</b></li>
      <li><span>Return period (${state.settings.hold_days} din)</span><b>${money(b.holding)}</b></li>
      <li class="now"><span>Available</span><b>${money(b.available)}</b></li>
      <li><span>Aap ko mil chuka</span><b>${money(b.paid)}</b></li>
    </ol>${b.requested > 0 && html`<p>${money(b.requested)} ki payout request pending hai.</p>`}</section>`;
}

const orderColumns = () => [
  ['Order', (o) => html`<b>${o.name}</b><div class="muted small">${date(o.created_at)}</div>`],
  ...(isAdmin() ? [['Affiliate', (o) => o.affiliate]] : []),
  ['Zariya', (o) => html`<span>${o.method === 'link' ? 'Link ' : ''}${o.code && html`<code>${o.code}</code>`}</span>`],
  ['Sale', (o) => money(o.sales, o.currency), true],
  ['Commission', (o) => money(o.commission, o.currency), true],
  ['Status', (o) => chip(o.status)],
];

// ---------- Pages ----------
const pages = {
  async overview() {
    const d = await api(`/overview?days=${state.days}`);
    state.data = d;
    const t = d.totals;
    const stats = html`<div class="stats">${[
      stat('Clicks', count(t.clicks)), stat('Unique visitors', count(t.visitors)), stat('Orders', count(t.orders)),
      stat('Link conversion', `${t.conversion.toFixed(1)}%`), stat('Sales', money(t.sales)), stat(isAdmin() ? 'Commission' : 'Aap ka commission', money(t.commission)),
    ]}</div>`;
    if (!isAdmin()) {
      return html`${head(`Salam, ${state.user.name.split(' ')[0]}`, 'Aap ki kamai aur performance', period())}
        ${wallet(d.balance, html`<div class="row"><button class="invert" data-act="copy" data-v="${link()}">Mera store link copy karein</button></div>`)}
        ${stats}${chartPanel(d.series)}`;
    }
    const todo = [['affiliates', d.todo.affiliates, 'affiliate approval ke intezar mein'], ['payouts', d.todo.payouts, 'payout request pending'], ['orders', d.todo.reviews, 'order review karne wale']].filter((x) => x[1]);
    return html`${head('Overview', 'Aap ke affiliate program ka haal', period())}
      ${todo.length > 0 && html`<div class="notice row">${todo.map(([p, n, l]) => html`<a href="#${p}">${n} ${l}</a>`)}</div>`}
      ${stats}${chartPanel(d.series)}
      <section class="panel"><header><h2>Top affiliates</h2></header>${d.top.length ? table([
        ['Affiliate', (a) => html`<b>${a.name}</b>`], ['Clicks', (a) => count(a.clicks), true], ['Orders', (a) => count(a.orders), true],
        ['Sales', (a) => money(a.sales), true], ['Commission', (a) => money(a.commission), true],
      ], d.top) : empty('Abhi koi affiliate nahi', 'Affiliate khud signup kar sakte hain, ya aap un ka account banayein.', html`<a href="#affiliates">Affiliate add karein</a>`)}</section>`;
  },

  async products() {
    const d = await api('/products');
    state.data = d;
    const add = html`<button class="ghost" data-act="import">Shopify se import karein</button><button data-act="product">Product add karein</button>`;
    return html`${head(isAdmin() ? 'Products' : 'Mere links', isAdmin() ? 'Jo products affiliates promote kar sakte hain' : 'Link copy karein, share karein, har sale par commission lein', isAdmin() ? add : '')}
      ${d.products.length ? html`<div class="products">${d.products.map((p) => {
        const rate = p.commission_rate ?? d.myRate;
        return html`<article class="product"><div class="thumb">${p.title.slice(0, 1).toUpperCase()}${p.image_url && html`<img src="${thumbUrl(p.image_url)}" alt="" loading="lazy">`}</div>
          <div class="body"><div><h3>${p.title}</h3><div class="muted small">${count(p.clicks)} clicks${!p.active && ' (chhupa hua)'}</div></div>
            <div class="price"><b>${money(p.price)}</b>${rate != null ? html`<span class="chip ok">${rate}% commission</span>` : html`<span class="chip off">Default rate</span>`}</div>
            ${isAdmin() ? html`<div class="row"><button class="ghost mini" data-act="product" data-id="${p.id}">Edit</button><button class="danger mini" data-act="delete-product" data-id="${p.id}">Delete</button></div>`
              : html`<div><div class="muted small">Taqreeban ${money(Math.round((p.price * rate) / 100))} fi sale</div><button data-act="copy" data-v="${link(p.id)}" style="width:100%;margin-top:8px">Affiliate link copy karein</button></div>`}
          </div></article>`;
      })}</div>` : html`<section class="panel">${isAdmin() ? empty('Abhi koi product nahi', 'Shopify se import karein ya haath se add karein.') : empty('Abhi koi product nahi', 'Jaise hi store products add karega, yahan nazar aayenge.')}</section>`}`;
  },

  async affiliates() {
    const d = await api('/affiliates');
    state.data = d;
    return html`${head('Affiliates', 'Influencers aur un ki performance', html`<button data-act="affiliate-new">Affiliate add karein</button>`)}
      <section class="panel">${d.affiliates.length ? table([
        ['Affiliate', (a) => html`<b>${a.name}</b><div class="muted small">${a.email}${a.social && html`<br>${a.social}`}</div>`],
        ['Status', (a) => chip(a.status === 'pending' ? 'pending-user' : a.status)],
        ['Clicks', (a) => count(a.clicks), true], ['Orders', (a) => count(a.orders), true], ['Sales', (a) => money(a.sales), true],
        ['Available', (a) => money(a.balance.available), true],
        ['Rate', (a) => `${a.commission_rate ?? state.settings.default_commission}%`, true],
        ['', (a) => html`<div class="row">${a.status === 'pending' && html`<button class="mini" data-act="status" data-id="${a.id}" data-v="active">Approve</button>`}<button class="ghost mini" data-act="affiliate-edit" data-id="${a.id}">Manage</button></div>`],
      ], d.affiliates) : empty('Abhi koi affiliate nahi', `Influencers ko yeh link bhejein taake woh signup karein: ${state.appUrl}`)}</section>`;
  },

  async discounts() {
    const d = await api('/discounts');
    state.data = d;
    return html`${head('Discount codes', isAdmin() ? 'Har affiliate ka apna code, sale code se bhi track hoti hai' : 'Yeh code apne followers ko dein', isAdmin() ? html`<button data-act="discount-new">Code banayein</button>` : '')}
      <section class="panel">${d.discounts.length ? table([
        ['Code', (c) => html`<code>${c.code}</code>`],
        ...(isAdmin() ? [['Affiliate', (c) => c.affiliate]] : []),
        ['Discount', (c) => `${c.percent}%`, true], ['Orders', (c) => count(c.orders), true],
        ['Status', (c) => chip(!isAdmin() && c.status !== 'disabled' ? 'active' : c.status)],
        ['', (c) => c.status !== 'disabled' && html`<div class="row"><button class="ghost mini" data-act="copy" data-v="${c.code}">Copy</button>${isAdmin() && html`<button class="danger mini" data-act="discount-off" data-id="${c.id}">Band karein</button>`}</div>`],
      ], d.discounts) : empty('Abhi koi code nahi', isAdmin() ? 'Kisi affiliate ke liye pehla code banayein.' : 'Store owner aap ke liye code banayega.')}</section>`;
  },

  async orders() {
    const d = await api('/orders');
    const cols = orderColumns();
    if (isAdmin()) cols.push(['', (o) => {
      if (o.status === 'review') return html`<div class="row"><button class="mini" data-act="review" data-id="${o.id}" data-v="approve">Approve</button><button class="danger mini" data-act="review" data-id="${o.id}" data-v="reject">Reject</button></div>`;
      if (o.status === 'rejected') return html`<button class="ghost mini" data-act="review" data-id="${o.id}" data-v="approve">Commission bahal karein</button>`;
      return ['pending', 'holding', 'approved'].includes(o.status) && html`<button class="danger mini" data-act="not-delivered" data-id="${o.id}">Deliver nahi hua</button>`;
    }]);
    return html`${head(isAdmin() ? 'Sales' : 'Meri sales', 'Shopify orders jo affiliate link ya code se aaye')}
      ${isAdmin() && d.orders.some((o) => o.status === 'review') && html`<div class="notice">"Review mein" ka matlab: khareedar ka email ya phone affiliate wala hi hai. Check kar ke faisla karein.</div>`}
      <section class="panel">${d.orders.length ? table(cols, d.orders) : empty('Abhi koi sale nahi', 'Pehla affiliate order aate hi yahan dikhega.')}</section>`;
  },

  async payouts() {
    const d = await api('/payouts');
    state.data = d;
    const cols = [
      ['Date', (p) => date(p.created_at)],
      ...(isAdmin() ? [['Affiliate', (p) => html`<b>${p.affiliate}</b>`]] : []),
      ['Raqam', (p) => money(p.amount), true],
      ['Bhejna hai', (p) => html`${p.method}<div class="muted small">${p.account}</div>`],
      ['Status', (p) => html`${chip(p.status)}${p.reference && html`<div class="muted small">${p.reference}</div>`}`],
    ];
    if (isAdmin()) cols.push(['', (p) => p.status === 'requested' && html`<div class="row"><button class="mini" data-act="payout" data-id="${p.id}" data-v="paid">Paid mark karein</button><button class="danger mini" data-act="payout" data-id="${p.id}" data-v="rejected">Reject</button></div>`]);
    const b = d.balance;
    const ready = b && b.available > 0 && b.available >= state.settings.min_payout * 100 && !b.requested;
    return html`${head('Payouts', isAdmin() ? 'Pehle paisay bhejein (JazzCash, Easypaisa, bank), phir paid mark karein' : `Kam az kam payout: ${money(state.settings.min_payout * 100)}`)}
      ${b && wallet(b, html`<button class="invert" data-act="request-payout" ${new Safe(ready ? '' : 'disabled')}>Payout request karein</button>`)}
      <section class="panel">${d.payouts.length ? table(cols, d.payouts) : empty('Abhi koi payout nahi', isAdmin() ? 'Affiliate ki request yahan aayegi.' : 'Balance minimum tak pohanchne par request bhejein.')}</section>`;
  },

  async rules() {
    return html`${head('Rules', 'Program mein shamil har creator ke liye')}<section class="panel">${state.settings.rules ? rulesList() : empty('Abhi koi rule nahi', 'Store owner yahan rules likhega.')}</section>`;
  },

  async settings() {
    const passwordPanel = html`<section class="panel"><header><h2>Password badlein</h2></header><form data-form="password">
      ${field('Purana password', 'current', 'type="password" required autocomplete="current-password"')}
      ${field('Naya password', 'password', 'type="password" required minlength="10" autocomplete="new-password"')}<div><button>Password badlein</button></div></form></section>`;
    if (!isAdmin()) {
      const u = state.user;
      return html`${head('Settings', 'Payment detail aur account')}<div class="two">
        <section class="panel"><header><h2>Payment detail</h2></header><form data-form="profile">
          <label>Tareeqa<select name="payout_method">${['', 'JazzCash', 'Easypaisa', 'Bank transfer', 'Other'].map((m) => html`<option value="${m}" ${new Safe(m === u.payout_method ? 'selected' : '')}>${m || 'Chunein'}</option>`)}</select></label>
          ${field('Account detail', 'payout_account', `maxlength="200" ${val(u.payout_account)}`, 'Account ka naam aur number / IBAN')}
          ${field('Phone', 'phone', val(u.phone))}${field('Social media link', 'social', val(u.social))}<div><button>Save karein</button></div></form></section>${passwordPanel}</div>`;
    }
    const { settings: s, shopify: sh } = await api('/settings');
    const num = (label, key, hint) => field(label, key, `type="number" step="any" min="0" required ${val(s[key])}`, hint);
    return html`${head('Settings', 'Program ke rules aur Shopify connection')}<div class="two">
      <section class="panel"><header><h2>Program</h2></header><form data-form="settings">
        ${field('Program ka naam', 'store_name', `required maxlength="60" ${val(s.store_name)}`)}
        ${field('Logo link', 'logo_url', `type="url" ${val(s.logo_url)}`, 'Khaali chhorein to website wala logo lagega')}
        <label>Rules<textarea name="rules" rows="7" maxlength="3000">${s.rules}</textarea><small>Har line aik rule. Commission % badlein to yahan bhi badlein.</small></label>
        ${field('Store link', 'storefront_url', `type="url" placeholder="https://yourstore.com" ${val(s.storefront_url)}`, 'Affiliate links customer ko yahan bhejte hain. Products bhi yahin se import hote hain')}
        <div class="fields">${num('Default commission %', 'default_commission')}${field('Currency', 'currency', `required maxlength="3" ${val(s.currency)}`)}
          ${num('Link yaad rakhne ke din', 'cookie_days')}${num('Return period (din)', 'hold_days', 'Payment ke baad itne din commission ruka rahega')}
          ${num('Minimum payout', 'min_payout')}${num('Timezone (UTC se minute)', 'tz_offset', 'Pakistan = 300')}</div>
        <label>Link par affiliate ka discount khud lagayein<select name="auto_apply_discount"><option value="1" ${new Safe(s.auto_apply_discount ? 'selected' : '')}>Haan</option><option value="0" ${new Safe(s.auto_apply_discount ? '' : 'selected')}>Nahi</option></select></label>
        <div><button>Save karein</button></div></form></section>
      <div style="display:grid;gap:22px;min-width:0">
      <section class="panel"><header><h2>Shopify connection</h2>${sh.connected ? html`<span class="chip ok">✓ API keys lagi hain</span>` : html`<span class="chip wait">! Connect nahi</span>`}</header>
        <div style="display:grid;gap:14px">
          <p class="muted">${sh.store || 'Products abhi store link se import hote hain. Sales track karne ke liye Railway ke Variables mein Shopify ki keys dalein.'}</p>
          <div><h3>1. Order webhooks</h3><p class="small muted">${sh.webhookSecret ? 'Signing secret set hai.' : 'Signing secret abhi set nahi (Railway ke Variables).'}</p></div>
          <div class="copybox"><code>${sh.webhookUrl}</code><button class="ghost mini" data-act="copy" data-v="${sh.webhookUrl}">Copy</button></div>
          <div><button data-act="webhooks" ${new Safe(sh.connected && sh.https ? '' : 'disabled')}>Webhooks khud lagayein</button>${!sh.https && html`<p class="small muted" style="margin-top:8px">Is ke liye app ka https address chahiye.</p>`}</div>
          <div><h3>2. Theme mein tracking code</h3><p class="small muted">Online Store, Themes, Edit code, theme.liquid mein &lt;/body&gt; se pehle paste karein.</p></div>
          <div class="copybox"><code>${sh.snippet}</code><button class="ghost mini" data-act="copy" data-v="${sh.snippet}">Copy</button></div>
        </div></section>${passwordPanel}</div></div>`;
  },
};

const NAV = {
  admin: { overview: 'Overview', products: 'Products', affiliates: 'Affiliates', discounts: 'Discount codes', orders: 'Sales', payouts: 'Payouts', settings: 'Settings' },
  affiliate: { overview: 'Overview', products: 'Mere links', discounts: 'Discount codes', orders: 'Meri sales', payouts: 'Payouts', rules: 'Rules', settings: 'Settings' },
};

// ---------- Auth screen ----------
function authScreen() {
  const signup = state.authMode === 'signup';
  document.title = state.settings.store_name || 'Mizu Affiliate Program';
  app.innerHTML = html`<div class="auth"><section class="pitch">${brand()}
      <div><h1>Share karein. Bechein. Kamayein.</h1><p>Apna link ya discount code share karein. Har sale par ${state.settings.default_commission}% se commission, aur har rupay ka hisaab aap ke dashboard par.</p></div>
      <ol class="flow"><li><span>Pehla qadam</span><b>Join</b></li><li><span>Phir</span><b>Link share</b></li><li><span>Order par</span><b>Commission</b></li><li class="now"><span>Aakhir mein</span><b>Payout</b></li></ol></section>
    <section class="formside"><div><h2>${signup ? 'Affiliate banein' : 'Login'}</h2>
      <form data-form="${signup ? 'signup' : 'login'}">
        ${signup && field('Poora naam', 'name', 'required maxlength="60" autocomplete="name"')}
        ${field('Email', 'email', 'type="email" required autocomplete="email"')}
        ${signup && html`${field('Phone', 'phone', 'type="tel" required autocomplete="tel"')}${field('Instagram / TikTok / YouTube link', 'social', 'maxlength="200"')}`}
        ${field('Password', 'password', `type="password" required ${signup ? 'minlength="10" autocomplete="new-password"' : 'autocomplete="current-password"'}`, signup ? 'Kam az kam 10 characters' : '')}
        ${signup && state.settings.rules && html`<div><h3>Rules</h3>${rulesList()}</div>
          <label class="agree"><input type="checkbox" name="accept_rules" value="1" required>Main ne rules parh liye hain aur qabool karta/karti hoon</label>`}
        <button>${signup ? 'Application bhejein' : 'Login karein'}</button></form>
      <p class="muted">${signup ? 'Account pehle se hai?' : 'Affiliate banna chahte hain?'} <button class="link" data-act="auth">${signup ? 'Login karein' : 'Apply karein'}</button></p></div></section></div>`.s;
}

let renderId = 0;
async function show() {
  if (!state.user) {
    if (location.hash === '#apply') state.authMode = 'signup'; // website ka "Creator banein" link
    return authScreen();
  }
  const nav = NAV[state.user.role];
  const page = location.hash.slice(1) in nav ? location.hash.slice(1) : 'overview';
  const mine = ++renderId;
  if (!$('.shell')) app.innerHTML = '<div class="shell"><aside class="side"></aside><main></main></div>';
  $('.side').innerHTML = html`${brand()}
    <nav>${Object.entries(nav).map(([k, l]) => html`<a href="#${k}" ${new Safe(k === page ? 'aria-current="page"' : '')}>${l}</a>`)}</nav>
    <div class="who"><span>${state.user.name}${state.user.code && html`<br>Code: ${state.user.code}`}</span><button class="mini" data-act="logout">Logout</button></div>`.s;
  document.title = `${nav[page]} · ${state.settings.store_name}`;
  $('.side nav [aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  try {
    const content = await pages[page]();
    if (mine === renderId && state.user) $('main').innerHTML = content.s;
  } catch (e) {
    if (mine === renderId && state.user) $('main').innerHTML = html`<section class="panel">${empty('Page load nahi hua', e.message, html`<button data-act="retry">Dobara koshish</button>`)}</section>`.s;
  }
}

async function boot() {
  const me = await api('/me');
  Object.assign(state, { user: me.user, settings: me.settings, appUrl: me.appUrl });
  show();
}

// ---------- Actions ----------
const actions = {
  close: () => modal.close(),
  retry: () => show(),
  auth: () => { state.authMode = state.authMode === 'login' ? 'signup' : 'login'; authScreen(); },
  copy: (el) => copy(el.dataset.v),
  logout: async () => { await api('/logout', 'POST'); state.user = null; location.hash = ''; await boot(); },
  days: (el) => { state.days = Number(el.dataset.v); show(); },
  metric: (el) => { state.metric = el.dataset.v; redrawChart(); },
  table: () => { state.table = !state.table; redrawChart(); },
  import: async () => { toast('Import ho raha hai...'); const r = await api('/products/import', 'POST'); toast(`${r.imported} products import hue`); show(); },
  product: (el) => {
    const p = state.data.products.find((x) => x.id === Number(el.dataset.id));
    openModal(p ? 'Product edit karein' : 'Product add karein', html`<form data-form="product" data-id="${p?.id || ''}">
      ${field('Naam', 'title', `required ${val(p?.title)}`)}
      ${field('Shopify product link ya handle', 'handle', `required ${val(p?.handle)}`, 'Misal: https://yourstore.com/products/wall-shelf')}
      <div class="fields">${field('Price', 'price', `type="number" step="0.01" min="0" required ${val(p ? p.price / 100 : '')}`)}
      ${field('Commission %', 'commission_rate', `type="number" step="0.1" min="0" max="90" ${val(p?.commission_rate)}`, 'Khali = affiliate ya default rate')}</div>
      <p class="small muted">Haath se add kiye product ka commission tab lagta hai jab naam Shopify wale naam jaisa ho. Import karna behtar hai.</p>
      ${field('Image link', 'image_url', `type="url" ${val(p?.image_url)}`)}
      <label>Affiliates ko dikhayein<select name="active"><option value="1">Haan</option><option value="" ${new Safe(p && !p.active ? 'selected' : '')}>Nahi</option></select></label>
      ${buttons(p ? 'Save karein' : 'Product add karein')}</form>`);
  },
  'delete-product': async (el) => { if (confirm('Yeh product delete karein?')) { await api(`/products/${el.dataset.id}`, 'DELETE'); toast('Product delete ho gaya'); show(); } },
  'affiliate-new': () => openModal('Affiliate add karein', html`<form data-form="affiliate-new">
    ${field('Naam', 'name', 'required')}${field('Email', 'email', 'type="email" required')}${field('Phone', 'phone', 'type="tel"')}
    ${field('Temporary password', 'password', 'required minlength="10"', 'Affiliate ko bhejein, woh Settings se badal sakta hai')}${buttons('Account banayein')}</form>`),
  'affiliate-edit': (el) => {
    const a = state.data.affiliates.find((x) => x.id === Number(el.dataset.id));
    openModal(a.name, html`<form data-form="affiliate-edit" data-id="${a.id}">
      <p class="muted">${a.email}${a.phone && ` · ${a.phone}`}<br>Ref code: <code>${a.code}</code></p>
      ${field('Commission %', 'commission_rate', `type="number" step="0.1" min="0" max="90" ${val(a.commission_rate)}`, `Khali = default ${state.settings.default_commission}%. Naye orders par lagega.`)}
      ${field('Naya password', 'password', 'minlength="10"', 'Sirf reset karna ho to bharein')}
      ${buttons('Save karein')}
      <div>${a.status === 'blocked' ? html`<button type="button" class="ghost" data-act="status" data-id="${a.id}" data-v="active">Account dobara chalu karein</button>`
        : html`<button type="button" class="danger" data-act="status" data-id="${a.id}" data-v="blocked">Account block karein</button>`}</div></form>`);
  },
  status: async (el) => {
    if (el.dataset.v === 'blocked' && !confirm('Is affiliate ko block karein? Us ke links track hona band ho jayenge.')) return;
    await api(`/affiliates/${el.dataset.id}`, 'PUT', { status: el.dataset.v }); modal.close(); toast(el.dataset.v === 'active' ? 'Affiliate active ho gaya' : 'Affiliate block ho gaya'); show();
  },
  'discount-new': async () => {
    const { affiliates } = await api('/affiliates');
    const list = affiliates.filter((a) => a.status === 'active');
    if (!list.length) return toast('Pehle kisi affiliate ko approve karein', true);
    openModal('Discount code banayein', html`<form data-form="discount">
      <label>Affiliate<select name="affiliate_id">${list.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
      ${field('Code', 'code', 'required minlength="3" maxlength="30" pattern="[A-Za-z0-9_\\-]+" placeholder="AYESHA10"')}
      ${field('Discount %', 'percent', 'type="number" min="1" max="90" value="10" required')}${buttons('Code banayein')}</form>`);
  },
  'discount-off': async (el) => {
    if (!confirm('Yeh code band karein?')) return;
    const r = await api(`/discounts/${el.dataset.id}/disable`, 'POST');
    toast(r.manual ? 'Code band hua. Shopify admin mein bhi khud band karein.' : 'Code band ho gaya'); show();
  },
  review: async (el) => { await api(`/orders/${el.dataset.id}`, 'PUT', { decision: el.dataset.v }); modal.close(); toast(el.dataset.v === 'approve' ? 'Order approve hua' : 'Commission hata diya gaya'); show(); },
  'not-delivered': (el) => openModal('Order deliver nahi hua?', html`<p>Is order ka commission khatam ho jayega.</p><div class="row" style="margin-top:16px"><button data-act="review" data-id="${el.dataset.id}" data-v="reject">Haan, commission hata dein</button><button class="ghost" data-act="close">Wapas</button></div>`),
  'request-payout': async () => { await api('/payouts', 'POST'); toast('Payout request bhej di gayi'); show(); },
  payout: (el) => {
    const paid = el.dataset.v === 'paid';
    const p = state.data.payouts.find((x) => x.id === Number(el.dataset.id));
    openModal(paid ? 'Payment confirm karein' : 'Request reject karein', html`<form data-form="payout" data-id="${p.id}" data-v="${el.dataset.v}">
      <p>${p.affiliate}: <b>${money(p.amount)}</b><br><span class="muted">${p.method}, ${p.account}</span></p>
      ${field(paid ? 'Transaction ID' : 'Wajah', 'reference', 'maxlength="100"')}${buttons(paid ? 'Paid mark karein' : 'Reject karein')}</form>`);
  },
  webhooks: async () => {
    const { results } = await api('/shopify/webhooks', 'POST');
    openModal('Webhooks', html`<form method="dialog">${results.map((r) => html`<p>${r.ok ? '✓' : '✕'} ${r.topic}: ${r.message}</p>`)}<button>Theek hai</button></form>`);
  },
};

const forms = {
  login: async (d) => { await api('/login', 'POST', d); location.hash = 'overview'; await boot(); },
  signup: async (d) => { await api('/signup', 'POST', d); state.authMode = 'login'; authScreen(); toast('Application mil gayi. Approval ke baad login karein.'); },
  product: async (d, f) => { await api(f.dataset.id ? `/products/${f.dataset.id}` : '/products', f.dataset.id ? 'PUT' : 'POST', { ...d, active: d.active === '1' }); return 'Product save ho gaya'; },
  'affiliate-new': async (d) => { await api('/affiliates', 'POST', d); return 'Affiliate account ban gaya'; },
  'affiliate-edit': async (d, f) => { await api(`/affiliates/${f.dataset.id}`, 'PUT', d); return 'Save ho gaya'; },
  discount: async (d) => { const r = await api('/discounts', 'POST', d); return r.synced ? 'Code Shopify par ban gaya' : 'Code save hua. Isi naam aur % se Shopify mein bhi banayein.'; },
  payout: async (d, f) => { await api(`/payouts/${f.dataset.id}`, 'PUT', { ...d, status: f.dataset.v }); return f.dataset.v === 'paid' ? 'Paid mark ho gaya' : 'Request reject hui'; },
  profile: async (d) => { await api('/profile', 'PUT', d); await boot(); return 'Detail save ho gayi'; },
  settings: async (d) => { await api('/settings', 'PUT', d); await boot(); return 'Settings save ho gayin'; },
  password: async (d) => { await api('/password', 'POST', d); return 'Password badal gaya'; },
};

function redrawChart() {
  const section = $('.chart')?.closest('section');
  if (!section) return;
  const focus = document.activeElement?.dataset?.act;
  const v = document.activeElement?.dataset?.v;
  section.outerHTML = chartPanel(state.data.series).s;
  if (focus) $(`[data-act="${focus}"]${v ? `[data-v="${v}"]` : ''}`)?.focus();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  el.disabled = true;
  try { await actions[el.dataset.act](el); } catch (err) { toast(err.message, true); } finally { el.disabled = false; }
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const button = $('button:not([type="button"])', form);
  button.disabled = true;
  try {
    const message = await forms[form.dataset.form](Object.fromEntries(new FormData(form)), form);
    if (message) { if (modal.open) modal.close(); toast(message); await show(); }
  } catch (err) { toast(err.message, true); } finally { button.disabled = false; }
});

const tip = $('#tip');
const showTip = (e) => {
  const el = e.target.closest?.('[data-tip]');
  tip.hidden = !el;
  if (!el) return;
  const r = el.getBoundingClientRect();
  tip.textContent = el.dataset.tip;
  tip.style.left = `${Math.max(80, Math.min(innerWidth - 80, r.x + r.width / 2))}px`;
  tip.style.top = `${Math.max(40, r.y + 20)}px`;
};
document.addEventListener('pointerover', showTip);
document.addEventListener('focusin', showTip);
document.addEventListener('scroll', () => { tip.hidden = true; }, true);
// Toot-i hui image ki jagah product ka pehla harf
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);
let resize;
addEventListener('resize', () => { clearTimeout(resize); resize = setTimeout(() => state.user && redrawChart(), 150); });
addEventListener('hashchange', () => { modal.close(); tip.hidden = true; show(); scrollTo(0, 0); });
boot().catch(() => { app.textContent = 'Server se connection nahi ho saka. Page refresh karein.'; });
