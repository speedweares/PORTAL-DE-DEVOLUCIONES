import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APP_PROXY_SUBPATH = process.env.APP_PROXY_SUBPATH || '/apps/returns';
const APP_PROXY_SECRET = process.env.APP_PROXY_SECRET || ''; // viene de Shopify (shpss_***)

// ───────────────────────────────────────────────
// ✅ Ruta raíz (soluciona "Cannot GET /")
// ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('✅ Returns backend live. Use /apps/returns/health');
});

// ───────────────────────────────────────────────
// ✅ Verificación opcional de App Proxy (firma)
// ───────────────────────────────────────────────
function isValidProxy(req) {
  const signature = req.query?.signature;
  if (!APP_PROXY_SECRET || !signature) return true; // modo dev para pruebas

  const { signature: _sig, ...rest } = req.query;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('');
  const digest = crypto.createHmac('sha256', APP_PROXY_SECRET).update(message).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(digest, 'hex'));
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────
// ✅ Health check
// ───────────────────────────────────────────────
app.get(`${APP_PROXY_SUBPATH}/health`, (req, res) => {
  res.json({ ok: true, path: APP_PROXY_SUBPATH });
});

// ───────────────────────────────────────────────
// ✅ LOOKUP MOCK (para que el frontend funcione ya)
// ───────────────────────────────────────────────
app.post(`${APP_PROXY_SUBPATH}/lookup`, (req, res) => {
  if (!isValidProxy(req)) return res.status(401).send('Bad signature');

  const { email, orderNumber } = req.body || {};
  if (!email || !orderNumber) return res.status(400).json({ error: 'MISSING_FIELDS' });

  return res.json({
    orderId: "gid://shopify/Order/123",
    currency: "EUR",
    lineItems: [
      {
        lineItemId: "111",
        productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/11",
        title: "Camiseta X",
        variantTitle: "Azul / M",
        price: 1999,
        returnableQuantity: 1,
        image: "https://cdn.shopify.com/s/files/1/0000/0001/t/1/assets/placeholder.png",
        sku: "TEE-001-M"
      },
      {
        lineItemId: "222",
        productId: "gid://shopify/Product/2",
        variantId: "gid://shopify/ProductVariant/22",
        title: "Pantalón Y",
        variantTitle: "Negro / 40",
        price: 3999,
        returnableQuantity: 2,
        image: "https://cdn.shopify.com/s/files/1/0000/0001/t/1/assets/placeholder.png",
        sku: "PAN-040"
      }
    ]
  });
});

// ───────────────────────────────────────────────
// ✅ EXCHANGE OPTIONS MOCK
// ───────────────────────────────────────────────
app.post(`${APP_PROXY_SUBPATH}/exchange-options`, (req, res) => {
  if (!isValidProxy(req)) return res.status(401).send('Bad signature');

  res.json({
    variants: [
      { id: "gid://shopify/ProductVariant/33", title: "Azul / S" },
      { id: "gid://shopify/ProductVariant/44", title: "Azul / L" }
    ]
  });
});

// ───────────────────────────────────────────────
// ✅ CREATE MOCK (devuelve PDF de prueba)
// ───────────────────────────────────────────────
app.post(`${APP_PROXY_SUBPATH}/create`, (req, res) => {
  if (!isValidProxy(req)) return res.status(401).send('Bad signature');

  res.json({
    requestId: "mock_request_001",
    refundId: "mock_refund_001",
    exchangeOrderId: "gid://shopify/Order/mock_999",
    labelUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    trackingNumber: "MOCK123456ES"
  });
});

// ───────────────────────────────────────────────
// 🚀 Start server
// ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Returns backend running on port :${PORT}`);
});
