/* Affiliate Board tracker: Shopify theme mein lagta hai */
(function () {
  var DAYS = Number('__COOKIE_DAYS__') || 30;
  var KEY = 'ab_affiliate';
  var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  var params = new URLSearchParams(window.location.search);
  var saved = null;

  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}

  // Aakhri click jeet-ta hai
  if (params.get('aff') && params.get('clk')) {
    saved = { ref: params.get('aff'), click: params.get('clk'), at: Date.now() };
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
    document.cookie = KEY + '=' + encodeURIComponent(saved.ref + '|' + saved.click + '|' + saved.at) +
      '; path=/; max-age=' + DAYS * 86400 + '; SameSite=Lax';
  }
  if (!saved) {
    var m = document.cookie.match(/(?:^|; )ab_affiliate=([^;]+)/);
    if (m) {
      var parts = decodeURIComponent(m[1]).split('|');
      saved = { ref: parts[0], click: parts[1], at: Number(parts[2]) };
    }
  }
  if (!saved || Date.now() - saved.at > DAYS * 86400000) return;

  // Cart par likh do taake order ke sath Shopify se wapas aaye
  function sync() {
    fetch(root + 'cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (cart) {
        var a = cart.attributes || {};
        if (a.aff_ref === saved.ref && a.aff_click === saved.click) return;
        return fetch(root + 'cart/update.js', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attributes: { aff_ref: saved.ref, aff_click: saved.click } })
        });
      })
      .catch(function () {});
  }
  sync();
  // Order ke baad naya cart banta hai: wapas aane par dobara likho
  window.addEventListener('pageshow', function (e) { if (e.persisted) sync(); });
})();
