// Checkout Session creation, routed through Stripe Connect direct charges.
// The platform owns the API key (PLATFORM_STRIPE_SK); the merchant owns the
// connected Stripe account (MERCHANT_STRIPE_ACCOUNT_ID). All requests pass
// `{ stripeAccount }` so the session is created on — and money lands in —
// the merchant's account directly. The platform takes no per-transaction fee.
//
// Both env vars are injected by the platform at provision time (or by the
// Stripe Connect callback once the merchant authorizes). If either is missing,
// we return 503 instead of falling back to a misrouted charge.

const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');

function loadSettings() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'content', 'settings.json'), 'utf8')
    );
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  const platformSecret = process.env.PLATFORM_STRIPE_SK;
  const merchantAccount = process.env.MERCHANT_STRIPE_ACCOUNT_ID;

  if (!platformSecret || !merchantAccount) {
    res.status(503).json({
      error: 'Checkout is not configured for this store yet.',
    });
    return;
  }

  const stripe = new Stripe(platformSecret);
  const opts = { stripeAccount: merchantAccount };

  const origin =
    req.headers.origin ||
    req.headers.referer?.replace(/\/[^/]*$/, '') ||
    `https://${req.headers.host}`;

  let line_items;
  let sizeInfo = '';

  if (req.method === 'POST') {
    const { items } = req.body || {};
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Missing or empty items array' });
      return;
    }
    line_items = items.map((item) => ({
      price: item.price_id,
      quantity: item.quantity || 1,
    }));
    sizeInfo = items
      .filter((item) => item.size)
      .map((item) => item.size + ' x' + (item.quantity || 1))
      .join(', ');
  } else {
    const priceId = req.query.price_id;
    if (!priceId) {
      res.status(400).json({ error: 'Missing price_id' });
      return;
    }
    line_items = [{ price: priceId, quantity: 1 }];
  }

  try {
    // Resolve prices on the connected account so we can compute the order
    // total for client-side analytics on the success URL.
    const prices = await Promise.all(
      line_items.map((li) => stripe.prices.retrieve(li.price, opts))
    );
    const totalCents = prices.reduce(
      (sum, price, i) => sum + (price.unit_amount * (line_items[i].quantity || 1)),
      0
    );
    const total = (totalCents / 100).toFixed(2);

    const settings = loadSettings();
    const shipping = settings.shipping || {};

    const sessionParams = {
      mode: 'payment',
      line_items,
      shipping_address_collection: { allowed_countries: ['US'] },
      allow_promotion_codes: true,
      success_url: `${origin}/?checkout=success&total=${total}`,
      cancel_url: `${origin}/?checkout=cancel`,
    };

    if (shipping.method === 'flat' && shipping.stripe_rate_id) {
      sessionParams.shipping_options = [
        { shipping_rate: shipping.stripe_rate_id },
      ];
      if (
        shipping.free_threshold &&
        totalCents >= shipping.free_threshold * 100
      ) {
        delete sessionParams.shipping_options;
      }
    } else if (shipping.method === 'pickup') {
      delete sessionParams.shipping_address_collection;
    }

    if (sizeInfo) {
      sessionParams.metadata = { sizes: sizeInfo };
    }

    const session = await stripe.checkout.sessions.create(sessionParams, opts);

    if (req.method === 'POST') {
      res.status(200).json({ url: session.url });
    } else {
      res.redirect(303, session.url);
    }
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({
      error: 'Failed to create checkout session',
      detail: err.message,
      type: err.type || null,
    });
  }
};
