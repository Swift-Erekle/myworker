// utils/tbcPay.js
// TBC Pay e-commerce API integration
// Docs: https://developer.tbcbank.ge/docs/tpay-online-installments-get-started

const fetch = require('node-fetch');

const TBC_BASE = process.env.TBC_PAY_API_BASE || 'https://api.tbcpayments.ge';
const CLIENT_ID = process.env.TBC_PAY_CLIENT_ID;
const CLIENT_SECRET = process.env.TBC_PAY_CLIENT_SECRET;
const SITE_URL = process.env.SITE_URL || 'https://xelosani.ge';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get TBC Pay access token (cached, auto-refreshes)
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30000) {
    return cachedToken;
  }
  const resp = await fetch(`${TBC_BASE}/v1/tpay/access-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`TBC token error ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  // TBC tokens typically last 1 hour
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Create a TBC Pay payment order
 * @param {object} params
 * @param {number} params.amount - in tetri (100 = 1 GEL)
 * @param {string} params.description
 * @param {string} params.merchantOrderId - your internal order ID
 * @param {string} [params.returnUrl]
 * @param {string} [params.cancelUrl]
 * @returns {{ payId, redirectUrl }}
 */
async function createPayment({ amount, description, merchantOrderId, returnUrl, cancelUrl }) {
  const token = await getAccessToken();

  const body = {
    amount: {
      currency: 'GEL',
      total: amount,        // tetri
      subtotal: amount,
      tax: 0,
      shipping: 0,
    },
    extra: description,
    expirationTimeout: 900, // 15 min
    merchantPaymentId: merchantOrderId,
    returnUrl: returnUrl || `${SITE_URL}/payment-success`,
    cancelUrl: cancelUrl || `${SITE_URL}/payment-cancel`,
    callbackUrl: `${SITE_URL}/api/payment/callback`,
    installmentProducts: null,
  };

  const resp = await fetch(`${TBC_BASE}/v1/tpay/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`TBC createPayment error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  // Find approval URL from HATEOAS links
  const approvalLink = (data.links || []).find(
    (l) => l.rel === 'approval_url' || l.rel === 'approve'
  );

  return {
    payId: data.payId,
    redirectUrl: approvalLink?.href || data.redirectUrl,
    raw: data,
  };
}

/**
 * Get TBC Pay payment status
 * @param {string} payId
 */
async function getPaymentStatus(payId) {
  const token = await getAccessToken();
  const resp = await fetch(`${TBC_BASE}/v1/tpay/payments/${payId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`TBC status error ${resp.status}`);
  return resp.json();
}

/**
 * Cancel a TBC Pay payment
 * @param {string} payId
 */
async function cancelPayment(payId) {
  const token = await getAccessToken();
  const resp = await fetch(`${TBC_BASE}/v1/tpay/payments/${payId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.ok;
}

module.exports = { createPayment, getPaymentStatus, cancelPayment };
