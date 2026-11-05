// Public settings the page needs: whether the paywall is on, the Google sign-in client id, the payment page, the price.
import { paywallOn, paywallFrom } from './_lib/access.mjs';
import { PRICE, REGULAR_PRICE, PLAN, launchActive, launchUntil } from './_lib/sumit.mjs';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    paywall: paywallOn(req),
    // set while the paywall is scheduled but not on yet: the app counts down to it
    openUntil: process.env.PAYWALL === 'on' && !paywallOn(req) && paywallFrom() ? new Date(paywallFrom()).toISOString() : null,
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    // during the launch the launch-price page, if one is set
    payUrl: (launchActive() && process.env.SUMIT_PAYMENT_URL_LAUNCH) || process.env.SUMIT_PAYMENT_URL || 'https://pay.sumit.co.il/16hshfy/16ht7p1/16ht7l1/payment/',
    plan: PLAN(),
    price: PRICE(),
    regularPrice: REGULAR_PRICE(),
    launchUntil: launchActive() ? new Date(launchUntil()).toISOString() : null
  });
}
