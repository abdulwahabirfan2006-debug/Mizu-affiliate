# Mizu Affiliate Program

Shopify store ke liye affiliate dashboard. Admin aur affiliate dono ke alag dashboards.
Koi `npm install` nahi chahiye. Sirf **Node.js 22.13 ya naya** (nodejs.org se LTS).

## 1. Pehle demo dekhein

1. Zip kholein.
2. Windows par `start-demo.bat` par double click karein. Ya folder mein terminal khol kar: `npm run demo`
3. Browser mein `http://localhost:3000` kholein.

| Kaun | Email | Password |
|---|---|---|
| Admin | admin@demo.test | demo-pass-123 |
| Affiliate | ayesha@demo.test | demo-pass-123 |

Demo ka data farzi hai, har dafa naya banta hai, aur sirf aap ke computer par khulta hai.
Demo mein affiliate link `example.com` par jata hai. Console warning `SQLite is an experimental feature` aaye to normal hai.

## 2. Asli setup

`.env.example` ki copy banayein, naam `.env` rakhein, aur yeh bharein:

```
ADMIN_EMAIL=aap@email.com
ADMIN_PASSWORD=koi-lamba-mazboot-password
SHOPIFY_STORE=aap-ka-store.myshopify.com
```

Chalayein: `npm start`. Phir login kar ke **Settings** mein **Store link** `https://www.mizupk.com` aur logo ka link dalein.

## 3. App ko internet par lagana (zaroori)

`localhost` par affiliates aur Shopify aap tak nahi pohanch sakte. App ko aisi hosting chahiye:

- Node.js 22.13+ chalaye
- **https** address de
- **permanent disk** de (VPS, ya Railway/Render persistent volume ke sath)

> Khabardar: jis hosting par disk permanent nahi (aksar free plans), wahan restart par **saara data mit jayega**.

Hosting par `.env` wali values environment variables mein dalein:
`APP_URL=https://aap-ka-address`, `TRUST_PROXY=1` (agar hosting proxy ke peeche chalati hai), aur `DB_PATH` permanent disk par.
Apna domain use karein (misal `partners.mizupk.com`). Baad mein address badla to purane affiliate links toot jayenge.

## 4. Shopify connect karna

### Tareeqa A (recommended): sab features

1. Shopify **Dev Dashboard** mein naya app banayein.
2. App ke version mein yeh scopes chunein: `read_products`, `read_orders`, `write_discounts`. Version release karein.
3. Access requests mein **Protected customer data** enable karein (email aur phone, apni hi link se khareedari pakarne ke liye).
4. App apne store par install karein. App aur store **aik hi organization** mein hone chahiye.
5. App Settings se **Client ID** aur **Client secret** `.env` mein `SHOPIFY_CLIENT_ID` aur `SHOPIFY_CLIENT_SECRET` par dalein. App restart karein.
6. Dashboard: **Settings, Webhooks khud lagayein**.
7. Dashboard: **Products, Shopify se import karein**.

Guide: https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant

### Tareeqa B: sirf tracking (app banaye baghair)

1. Shopify admin: **Settings, Notifications, Webhooks**.
2. Chaar webhooks banayein (format JSON), sab ka URL `https://aap-ka-address/webhooks/shopify`:
   Order creation, Order payment, Order cancellation, Refund create.
3. Usi page par jo signing key likhi hai, usay `.env` mein `SHOPIFY_WEBHOOK_SECRET` par dalein.

Is tareeqe mein products haath se add honge aur discount codes Shopify mein khud banane honge
(wohi naam, wohi %). Dashboard mein un par "Shopify mein khud banayein" likha rahega aur woh link par khud nahi lagenge.

## 5. Theme mein tracking code (dono tareeqon mein)

Online Store, Themes, **Edit code**, `layout/theme.liquid`, `</body>` se pehle:

```html
<script src="https://aap-ka-address/tracker.js" defer></script>
```

Exact line dashboard ki Settings mein copy ke liye mojood hai.

## 6. Test karein (launch se pehle lazmi)

1. Aik test affiliate banayein.
2. Us ka product link **doosre phone/browser** mein kholein. Dashboard mein click barhna chahiye.
3. Asli **COD order** place karein (affiliate wale email/phone se nahi). "Sales" mein "Payment baqi" dikhna chahiye.
4. Shopify mein order **Mark as paid** karein. Status "Return period" ho jayega.
5. Order cancel karein. Status "Cancelled" ho jayega.

Shopify ke "test mode" wale orders jaan boojh kar ignore hote hain.

**COD form apps** (jo checkout ki jagah apna form dikhati hain) aur **Buy it now** button
cart ki tracking aage na bhej saken, yeh mumkin hai. Apne store par dono se test order karein.
Discount code se tracking in cases mein bhi chal sakti hai, agar form code ko order par lagata ho.

## Commission ke rules

- Commission discount ke baad ki product qeemat par. Shipping, tax aur gift card shamil nahi.
- Rate: product ka rate, warna affiliate ka, warna default.
- Customer ne kisi affiliate ka code lagaya to sale usi ki. Warna aakhri clicked link ki (default 30 din tak).
- COD: paid mark hone tak "Payment baqi". Us ke baad return period (default 7 din), phir "Available".
- Cancel par commission khatam. Refund par utni kam.
- Parcel deliver na ho ya wapas aaye: **Sales** mein "Deliver nahi hua" dabayein. COD order sirf paisay milne ke baad paid mark karein.
- Khareedar ka email/phone affiliate wala ho to "Review mein", faisla admin ka.
- Payout app khud paisay **nahi bhejti**. Aap JazzCash/Easypaisa/bank se bhej kar "Paid mark karein".
- Paid payout ke baad refund aaye to woh raqam agle balance se kat jati hai.

## Is version mein nahi

- Aik hi Shopify store (doosre sellers apna store connect nahi kar sakte)
- Order edit hone par commission update nahi hota
- Email notifications, "password bhool gaye" (admin reset kar sakta hai)
- Sales list mein aakhri 500 orders dikhte hain

## Kaam ki cheezein

- Backup: app band kar ke `data/` folder copy karein.
- Admin password bhool gaye: `node scripts/reset-password.js aap@email.com NayaPassword123`
- Tests: `npm test`
- `.env` file kisi ko na bhejein aur GitHub par upload na karein.

## Files

```
server.js            app start
src/api.js           dashboard ki API
src/orders.js        commission ka hisaab
src/shopify.js       Shopify connection
src/auth.js, db.js   login aur database
public/              dashboard design aur tracker.js
test/                automatic tests
```
