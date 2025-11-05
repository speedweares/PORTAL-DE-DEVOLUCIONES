import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch"; // compat universal

const app = express();
app.use(express.json());

// ───────────── ENV (Railway) ─────────────
const PORT = process.env.PORT || 3000;
const APP_PROXY_SUBPATH = process.env.APP_PROXY_SUBPATH || "/apps/returns";
const APP_PROXY_SECRET = process.env.APP_PROXY_SECRET || "";         // shpss_***
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;                       // tu-tienda.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;       // shpat_***
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-04";

// Ruta raíz (evita "Cannot GET /")
app.get("/", (_, res) => {
  res.type("text").send("✅ Returns backend live. Use /apps/returns/health");
});

// Verificación firma APP PROXY (Shopify)
function isValidProxy(req) {
  const signature = req.query?.signature;
  if (!APP_PROXY_SECRET || !signature) return true; // modo DEV
  const { signature: _sig, ...rest } = req.query;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("");
  const digest = crypto.createHmac("sha256", APP_PROXY_SECRET).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(digest, "hex"));
  } catch {
    return false;
  }
}

// Helper Shopify GraphQL con logs de error buenos
async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) throw new Error("SHOPIFY_ENV_MISSING");

  let res;
  try {
    res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (netErr) {
    console.error("❌ NETWORK_ERROR to Shopify:", netErr?.message || netErr);
    throw new Error("NETWORK_ERROR");
  }

  const text = await res.text();
  if (!res.ok) {
    console.error("❌ SHOPIFY_HTTP_ERROR", res.status, text.slice(0, 500));
    throw new Error(`SHOPIFY_${res.status}`);
  }

  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    console.error("❌ JSON_PARSE_ERROR", text.slice(0, 300));
    throw new Error("JSON_PARSE_ERROR");
  }

  if (json.errors) {
    console.error("❌ SHOPIFY_GQL_ERRORS", json.errors);
    throw new Error("SHOPIFY_GQL_ERRORS");
  }
  return json.data;
}

// Health
app.get(`${APP_PROXY_SUBPATH}/health`, (_, res) => {
  res.json({ ok: true, path: APP_PROXY_SUBPATH });
});

// Debug (no expone secretos)
app.get(`${APP_PROXY_SUBPATH}/debug`, (_, res) => {
  res.json({
    nodeVersion: process.version,
    hasShop: !!SHOPIFY_SHOP,
    hasToken: !!SHOPIFY_ACCESS_TOKEN,
    apiVersion: SHOPIFY_API_VERSION,
    subpath: APP_PROXY_SUBPATH
  });
});

// GET /lookup → 405 (para evitar "Cannot GET")
app.get(`${APP_PROXY_SUBPATH}/lookup`, (req, res) => {
  res.status(405).type("application/json").send(
    JSON.stringify({ error: "METHOD_NOT_ALLOWED", hint: "Use POST with JSON body" })
  );
});

// 🔎 LOOKUP REAL (pedido + email) robusto
app.post(`${APP_PROXY_SUBPATH}/lookup`, async (req, res) => {
  const start = Date.now();

  try {
    if (!isValidProxy(req)) return res.status(401).send("Bad signature");

    const { email = "", orderNumber = "" } = req.body || {};
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanNumber = String(orderNumber).replace("#", "").trim();

    if (!cleanEmail || !cleanNumber) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const queries = [
      `(name:#${cleanNumber} OR name:${cleanNumber}) AND (email:${cleanEmail} OR customer_email:${cleanEmail})`,
      `(name:"#${cleanNumber}" OR name:"${cleanNumber}") AND (email:${cleanEmail} OR customer_email:${cleanEmail})`,
      `(name:#${cleanNumber} OR name:${cleanNumber})`,
      `(name:"#${cleanNumber}" OR name:"${cleanNumber}")`
    ];

    let order = null;
    for (const q of queries) {
      const data = await shopifyGraphQL(
        `query($q:String!){
          orders(first:5, query:$q){
            edges{
              node{
                id name email currencyCode
                customer { email }
                lineItems(first:100){
                  edges{
                    node{
                      id
                      quantity
                      refundableQuantity
                      title
                      sku
                      originalUnitPriceSet{ presentmentMoney{ amount currencyCode } }
                      variant{ id title image{ url } product{ id title } }
                    }
                  }
                }
              }
            }
          }
        }`,
        { q }
      );

      const candidates = (data?.orders?.edges || []).map(e => e.node);
      order = candidates.find(n =>
        (n.email && n.email.toLowerCase().trim() === cleanEmail) ||
        (n.customer?.email && n.customer.email.toLowerCase().trim() === cleanEmail)
      ) || candidates[0];

      if (order) break;
    }

    if (!order) {
      console.error("❌ LOOKUP_NOT_FOUND", { email: cleanEmail, number: cleanNumber });
      return res.status(404).json({ error: "ORDER_NOT_FOUND_OR_EMAIL_MISMATCH" });
    }

    const lineItems = order.lineItems.edges.map(({ node }) => {
      const price = Number(node.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
      return {
        lineItemId: node.id,
        productId: node.variant?.product?.id,
        variantId: node.variant?.id,
        title: node.title,
        variantTitle: node.variant?.title,
        price: Math.round(price * 100),
        returnableQuantity: node.refundableQuantity ?? Math.max(0, node.quantity),
        image: node.variant?.image?.url || null,
        sku: node.sku || null
      };
    });

    console.log("✅ LOOKUP_OK", {
      order: order.name,
      email: order.email || order.customer?.email,
      time_ms: Date.now() - start
    });

    res.json({ orderId: order.id, currency: order.currencyCode, lineItems });
  } catch (e) {
    console.error("LOOKUP_ERROR", e?.message || e, { time_ms: Date.now() - start });
    res.status(500).send("LOOKUP_ERROR");
  }
});

// 🧪 TEST LOOKUP (GET) → para probar desde navegador
// Ejemplo: /apps/returns/test-lookup?email=cliente@x.com&n=7518
app.get(`${APP_PROXY_SUBPATH}/test-lookup`, async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    const n = String(req.query.n || "").trim();
    if (!email || !n) return res.status(400).json({ error: "Use ?email=...&n=7518" });

    const r = await fetch(`${req.protocol}://${req.get("host")}${APP_PROXY_SUBPATH}/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, orderNumber: `#${n}` })
    });

    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    res.status(500).json({ error: "TEST_LOOKUP_ERROR", message: e.message });
  }
});

// 🔁 EXCHANGE OPTIONS real (variantes del producto, menos la actual)
app.post(`${APP_PROXY_SUBPATH}/exchange-options`, async (req, res) => {
  try {
    if (!isValidProxy(req)) return res.status(401).send("Bad signature");

    const { productId, currentVariantId } = req.body || {};
    if (!productId) return res.status(400).json({ error: "MISSING_PRODUCT_ID" });

    const data = await shopifyGraphQL(
      `query($id:ID!){
        product(id:$id){
          variants(first:100){
            edges{ node{ id title } }
          }
        }
      }`,
      { id: productId }
    );

    const variants = data.product?.variants?.edges
      ?.map(e => e.node)
      .filter(v => v.id !== currentVariantId)
      .map(v => ({ id: v.id, title: v.title }));

    res.json({ variants });
  } catch (e) {
    console.error("EXCHANGE_OPTIONS_ERROR", e?.message || e);
    res.status(500).send("EXCHANGE_OPTIONS_ERROR");
  }
});

// ✳️ CREATE (mock temporal – etiqueta PDF de prueba)
app.post(`${APP_PROXY_SUBPATH}/create`, (req, res) => {
  if (!isValidProxy(req)) return res.status(401).send("Bad signature");
  res.json({
    requestId: "mock_request_001",
    refundId: null,
    exchangeOrderId: null,
    labelUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    trackingNumber: "MOCK123456ES"
  });
});

// Start
app.listen(PORT, () => {
  console.log(`✅ Returns backend running on port ${PORT}`);
});
