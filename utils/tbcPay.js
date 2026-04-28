// utils/tbcPay.js
// TBC Pay e-commerce API integration
// Docs: https://developer.tbcbank.ge/docs/tpay-online-installments-get-started

const fetch = require('node-fetch');

const TBC_BASE = process.env.TBC_PAY_API_BASE || 'https://api.tbcpayments.ge';
const CLIENT_ID = process.env.TBC_PAY_CLIENT_ID;
const CLIENT_SECRET = process.env.TBC_PAY_CLIENT_SECRET;
const SITE_URL = process.env.SITE_URL || 'https://fixi.ge';

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
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Create a TBC Pay payment order
 * @param {object} params
 * @param {number} params.amount - in tetri (100 = 1 GEL)
 * @param {string} params.description
 * @param {string} params.merchantOrderId
 * @param {string} [params.returnUrl]
 * @param {string} [params.cancelUrl]
 * @param {boolean} [params.saveCard] - request card tokenization for recurring payments
 * @returns {{ payId, redirectUrl }}
 */
async function createPayment({ amount, description, merchantOrderId, returnUrl, cancelUrl, saveCard = false }) {
  const token = await getAccessToken();

  const body = {
    amount: {
      currency: 'GEL',
      total: amount,
      subtotal: amount,
      tax: 0,
      shipping: 0,
    },
    extra: description,
    expirationTimeout: 900,
    merchantPaymentId: merchantOrderId,
    returnUrl: returnUrl || `${SITE_URL}/payment-success`,
    cancelUrl: cancelUrl || `${SITE_URL}/payment-cancel`,
    callbackUrl: `${SITE_URL}/api/payment/callback`,
    installmentProducts: null,
    // ✅ Request card saving for recurring payments
    ...(saveCard ? { saveCard: true } : {}),
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
 * ✅ NEW: Create a card-binding payment (minimal amount just to save card token)
 * After payment, TBC returns recurrentPaymentId in callback.
 * @param {object} params
 * @param {string} params.merchantOrderId
 * @param {string} params.returnUrl
 * @param {string} params.cancelUrl
 */
async function createBindPayment({ merchantOrderId, returnUrl, cancelUrl }) {
  const token = await getAccessToken();

  const body = {
    amount: {
      currency: 'GEL',
      total: 10,      // 10 tetri = 0.10₾ verification (will be refunded)
      subtotal: 10,
      tax: 0,
      shipping: 0,
    },
    extra: 'ბარათის მიბმა — Fixi.ge',
    expirationTimeout: 900,
    merchantPaymentId: merchantOrderId,
    returnUrl: returnUrl || `${SITE_URL}/payment-success?type=bind`,
    cancelUrl: cancelUrl || `${SITE_URL}/payment-cancel`,
    callbackUrl: `${SITE_URL}/api/payment/callback`,
    saveCard: true,  // ✅ This triggers card tokenization
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
    throw new Error(`TBC createBindPayment error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
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
 * ✅ NEW: Charge a saved card using the recurrentPaymentId token
 * Used for auto-renewal subscriptions.
 * @param {object} params
 * @param {string} params.recurrentPaymentId - the token from TBC Pay
 * @param {number} params.amount - in tetri
 * @param {string} params.description
 * @param {string} params.merchantOrderId
 * @returns {{ payId, status }}
 */
async function chargeWithToken({ recurrentPaymentId, amount, description, merchantOrderId }) {
  const token = await getAccessToken();

  const resp = await fetch(`${TBC_BASE}/v1/tpay/payments/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      recurrentPaymentId,
      merchantPaymentId: merchantOrderId,
      extra: description,
      amount: {
        currency: 'GEL',
        total: amount,
        subtotal: amount,
        tax: 0,
        shipping: 0,
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`TBC chargeWithToken error ${resp.status}: ${err}`);
  }

  return resp.json();
}

/**
 * ✅ NEW: Refund/void a payment (used after card binding verification charge)
 * @param {string} payId
 * @param {number} [amount] - partial refund amount in tetri, omit for full refund
 */
async function refundPayment(payId, amount) {
  const token = await getAccessToken();
  const body = amount ? { amount: { currency: 'GEL', total: amount } } : {};
  const resp = await fetch(`${TBC_BASE}/v1/tpay/payments/${payId}/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return resp.ok;
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

module.exports = { createPayment, createBindPayment, chargeWithToken, refundPayment, getPaymentStatus, cancelPayment };
