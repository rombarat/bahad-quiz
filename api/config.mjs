// Public settings the page needs: whether the paywall is on, the sign-in and payment-form public ids, the price.
import { paywallOn } from './_lib/access.mjs';
import { PRICE } from './_lib/sumit.mjs';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    paywall: paywallOn(),
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    sumitCompanyId: process.env.SUMIT_COMPANY_ID ? Number(process.env.SUMIT_COMPANY_ID) : null,
    sumitPublicKey: process.env.SUMIT_PUBLIC_KEY || null,
    price: PRICE()
  });
}
