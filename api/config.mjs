// Public settings the page needs: whether the paywall is on, the Google sign-in client id, the payment page, the price.
import { paywallOn } from './_lib/access.mjs';
import { PRICE } from './_lib/sumit.mjs';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    paywall: paywallOn(req),
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    payUrl: process.env.SUMIT_PAYMENT_URL || 'https://pay.sumit.co.il/16hshfy/16ht7p1/16ht7l1/payment/',
    price: PRICE()
  });
}
