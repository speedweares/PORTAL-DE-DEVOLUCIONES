import "dotenv/config";
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// ✅ ENV (Railway las provee)
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const APP_PROXY_SUBPATH = process.env.APP_PROXY_SUBPATH || "/apps/returns";
const APP_PROXY_SECRET = process.env.APP_PROXY_SECRET || ""; // shpss_***
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;               // tu-tienda.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // shpat_***
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-04";

// ─────────────────────────────────────────────
// ✅ Ruta raíz (evita "Cannot GET /")
// ─────────────────────────────────────────────
app.get("/", (_, res) => {
  res.send("✅ Returns backend live. Use /apps/returns/health");
});

// ─────────────────────────────────────────────
// ✅ Verificación firma APP PROXY (Shopify)
// ─────────────────────────────────────────────
function isValidProxy(req) {
  const signature = req.query?.signature;
  if (!APP_PROXY_SECRET || !signature) return true; // modo DEV

  const { signature: _sig, ...rest } = req.query;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("");

  const digest = crypto
    .createHmac("sha256", APP_PROXY_SECRET)
    .update(message)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(digest, "hex"));
  } catch {
    return false;
  }
}

// Helper Shopify GraphQL
async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    throw new Error("SHOPIFY_ENV_MISSING");
  }

  const res = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ─────────────────────────────────────────────
// ✅ Health check
// ─────────────────────────────────────────────
app.get(`${APP_PROXY_SUBPATH}/health`, (_, res) => {
  res.json({ ok: true, path: APP_PROXY_SUBPATH });
});

// ─────────────────────────────────────────────
// 🔎 LOOKUP REAL (pedido + email)
// ─────────────────────────────────────────────
app.post(`${APP_PROXY_SUBPATH}/lookup`, async (req, res) => {
  try {
    if (!isValidProxy(req)) return res.status(401).send("Bad signature");

    const { email = "", orderNumber = "" } = req.body || {};
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanNumber = String(orderNumber).replace("#", "").trim();

    if (!cleanEmail || !cleanNumber) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // Query: busca igual con # o sin #
    const q =
      `(name:#${cleanNumber} OR name:${cleanNumber}) AND ` +
      `(email:${cleanEmail} OR customer_email:${cleanEmail})`;

    let data = await shopifyGraphQL(
      `
      query($q:String!){
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
      }
    `,
      { q }
    );

    // si no devuelve nada, prueba a buscar solo por número y validar email manualmente
    let order = data.orders.edges[0]?.node;

    if (!order) {
      const fallback = await shopifyGraphQL(
        `
        query($q:String!){
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
        }
      `,
        { q: `(name:#${cleanNumber} OR name:${cleanNumber})` }
      );

      order = fallback.orders.edges
        .map((e) => e.node)
        .find(
          (n) =>
            n.email?.toLowerCase().trim() === cleanEmail ||
            n.customer?.email?.toLowerCase().trim() === cleanEmail
        );
    }

    if (!order) {
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
        sku: node.sku || null,
      };
    });

    res.json({
      orderId: order.id,
      currency: order.currencyCode,
      lineItems,
    });
  } catch (e) {
    console.error("LOOKUP_ERROR", e);
    return res.status(500).send("LOOKUP_ERROR");
  }
});

// ─────────────────────────────────────────────
// 🔁 EXCHANGE OPTIONS REAL (listar variantes)
// ─────────────────────────────────────────────
app.post(`${APP_PROXY_SUBPATH}/exchange-options`, async (req, res) => {
  try {
    if (!isValidProxy(req)) return res.status(401).send("Bad signature");

    const { productId, currentVariantId } = req.body || {};
    if (!productId) return res.status(400).json({ error: "MISSING_PRODUCT_ID" });

    const data = await shopifyGraphQL(
      `
      query($id:ID!){
        product(id:$id){
          variants(first:100){
            edges{ node{ id title availableForSale } }
          }
        }
      }
    `,
      { id: productId }
    );

    const variants = data.product?.variants?.edges
      ?.map((e) => e.node)
      .filter((v) => v.id !== currentVariantId)
      .map((v) => ({ id: v.id, title: v.title }));

    res.json({ variants });
  } catch (e) {
    console.error("EXCHANGE_OPTIONS_ERROR", e);
    res.status(500).send("EXCHANGE_OPTIONS_ERROR");
  }
});

// ─────────────────────────────────────────────
//✳️ CREATE MOCK (temporal hasta refund + Correos)
// ─────────────────────────────────────────────
app.post(`${APP_PROXY_SUBPATH}/create`, (req, res) => {
  if (!isValidProxy(req)) return res.status(401).send("Bad signature");

  res.json({
    requestId: "mock_request_001",
    refundId: null,
    exchangeOrderId: null,
    labelUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
  });
});

// ─────────────────────────────────────────────
// 🚀 Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Returns backend running on port ${PORT}`);
});
