# Returns Backend (Shopify + App Proxy)

Backend mínimo para portal de devoluciones/cambios:
- App Proxy: `/apps/returns`
- Shopify Admin API (GraphQL) con logs detallados
- Endpoints: lookup (real), exchange-options (real), create (mock)
- Utilidades de diagnóstico: /debug, /self-test, /test-lookup

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

## Endpoints principales
- `POST /apps/returns/lookup`
  - Body: `{ "email": "...", "orderNumber": "#1234" }`
- `GET  /apps/returns/test-lookup?email=...&n=1234`
  - Prueba desde navegador (llama internamente al POST)
- `GET  /apps/returns/self-test?email=...&n=1234`
  - Diagnóstico completo: token, tienda, búsqueda por número y validación de email
- `POST /apps/returns/exchange-options`
  - Body: `{ "productId": "...", "currentVariantId": "..." }`
- `POST /apps/returns/create`
  - Mock: devuelve etiqueta PDF de prueba

> ⚠️ No subas tokens al repo. Configúralos solo como Variables en Railway.
