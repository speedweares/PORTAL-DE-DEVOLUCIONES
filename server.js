// 🔎 LOOKUP REAL (robusto + logs)
app.post(`${APP_PROXY_SUBPATH}/lookup`, async (req, res) => {
  const start = Date.now();
  try {
    if (!isValidProxy(req)) return res.status(401).send('Bad signature');

    const { email = '', orderNumber = '' } = req.body || {};
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanNumber = String(orderNumber).replace('#', '').trim();

    if (!cleanEmail || !cleanNumber) {
      return res.status(400).json({ error: 'MISSING_FIELDS' });
    }

    // Variantes de búsqueda (algunas tiendas matchean mejor con comillas)
    const queries = [
      `(name:#${cleanNumber} OR name:${cleanNumber}) AND (email:${cleanEmail} OR customer_email:${cleanEmail})`,
      `(name:"#${cleanNumber}" OR name:"${cleanNumber}") AND (email:${cleanEmail} OR customer_email:${cleanEmail})`,
      `(name:#${cleanNumber} OR name:${cleanNumber})`,
      `(name:"#${cleanNumber}" OR name:"${cleanNumber}")`,
    ];

    let order = null;
    let lastError = null;

    for (const q of queries) {
      try {
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
        // Si la query ya filtra por email, intentamos coger el primero
        order = candidates.find(n =>
          (n.email && n.email.toLowerCase().trim() === cleanEmail) ||
          (n.customer?.email && n.customer.email.toLowerCase().trim() === cleanEmail)
        ) || candidates[0];

        // Si aún no validamos email, validamos aquí
        if (order) {
          const okEmail =
            (order.email && order.email.toLowerCase().trim() === cleanEmail) ||
            (order.customer?.email && order.customer.email.toLowerCase().trim() === cleanEmail);
          if (!okEmail) {
            // si no cuadra email, seguimos buscando en siguientes queries
            order = null;
          }
        }
        if (order) break; // encontrado
      } catch (e) {
        lastError = e;
      }
    }

    if (!order) {
      console.error('LOOKUP_NOT_FOUND', {
        email: cleanEmail,
        orderNumber: cleanNumber,
        lastError: lastError?.message
      });
      return res.status(404).json({ error: 'ORDER_NOT_FOUND_OR_EMAIL_MISMATCH' });
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

    console.log('LOOKUP_OK', {
      name: order.name,
      email: order.email || order.customer?.email,
      ms: Date.now() - start
    });

    return res.json({ orderId: order.id, currency: order.currencyCode, lineItems });
  } catch (e) {
    console.error('LOOKUP_ERROR', e?.message || e, { ms: Date.now() - start });
    return res.status(500).send('LOOKUP_ERROR');
  }
});
