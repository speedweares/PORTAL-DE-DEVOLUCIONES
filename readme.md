# Returns Backend (Shopify + App Proxy)

Backend mínimo para portal de devoluciones/cambios:
- App Proxy: `/apps/returns`
- Shopify Admin API (GraphQL)
- Endpoints: lookup (real), exchange-options (real), create (mock)

## Deploy en Railway
1) Conecta el repo en Railway → Deploy
2) En **Variables**, añade:
   - `APP_PROXY_SUBPATH=/apps/returns`
   - `APP_PROXY_SECRET=shpss_...`
   - `SHOPIFY_SHOP=tu-tienda.myshopify.com`
   - `SHOPIFY_ACCESS_TOKEN=shpat_...` (scope: `read_orders`)
   - (opcional) `SHOPIFY_API_VERSION=2024-04`
3) Comprueba:
   - `/apps/returns/health` → `{"ok":true,...}`
   - `/apps/returns/debug` → `hasShop:true`, `hasToken:true`

## App Proxy en Shopify
- Subpath: `/apps/returns`
- Proxy URL: `https://tu-app.up.railway.app`
- Secret: `shpss_...`

## Endpoints
- `POST /apps/returns/lookup` — body: `{ "email": "...", "orderNumber": "#1234" }`
- `GET  /apps/returns/test-lookup?email=...&n=1234` — test desde navegador
- `POST /apps/returns/exchange-options` — body: `{ "productId": "...", "currentVariantId": "..." }`
- `POST /apps/returns/create` — mock (devuelve etiqueta PDF de prueba)

> No subas tokens al repo. Configúralos solo como Variables en Railway.
