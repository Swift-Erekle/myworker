// routes/payment.js
// ════════════════════════════════════════════════════════════════
// Complete payment system with:
// 1. VIP purchase (1 or 5 days)
// 2. Subscription (Pro/Top) — with or without saved card
// 3. Card binding — real TBC Pay tokenization
// 4. Card management — list, delete, set default
// 5. Auto-renewal — via chargeWithToken on planExpiresAt - 1 day
// 6. TOP plan — VIP+ auto-refreshed daily by cron job
// ════════════════════════════════════════════════════════════════
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { createPayment, createBindPayment, chargeWithToken, refundPayment, getPaymentStatus } = require('../utils/tbcPay');
const { sendEmail, vipConfirmTemplate, subConfirmTemplate } = require('../utils/email');

const router = express.Router();

// ── Pricing tables ─────────────────────────────────────────────
const VIP_PRICES = {
  handyman: { vip: { 1: 200, 5: 1000 }, vipp: { 1: 400, 5: 1800 } },
  company:  { vip: { 1: 1000, 5: 4000 }, vipp: { 1: 1500, 5: 6000 } },
};
const PLAN_PRICES = {
  handyman: { pro: 2900, top: 6900 },
  company:  { pro: 9900, top: 14900 },
};

const isTbcConfigured = () =>
  process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_');

// ══════════════════════════════════════════════════════════════
// 💳 CARD MANAGEMENT
// ══════════════════════════════════════════════════════════════

// GET /api/payment/cards — list saved cards
router.get('/cards', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') return res.status(403).json({ error: 'ბარათი მხოლოდ ხელოსნებისთვისაა' });
    const cards = await prisma.savedCard.findMany({
      where: { userId: req.user.id },
      select: { id: true, last4: true, brand: true, expiry: true, isDefault: true, createdAt: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(cards);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/payment/cards/bind — initiate card binding via TBC Pay
// User is redirected to TBC, pays 0.10₾ verification, card token is saved in callback
router.post('/cards/bind', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') return res.status(403).json({ error: 'ბარათი მხოლოდ ხელოსნებისთვისაა' });

    const merchantOrderId = uuidv4();

    // Store a "pending bind" record so callback knows it's a bind flow
    await prisma.vipPayment.create({
      data: {
        userId: req.user.id,
        vipType: 'bind',          // marker: this is a card bind, not VIP
        days: 0,
        amount: 10,               // 0.10₾ verification
        status: 'pending',
        tbcOrderId: merchantOrderId,
      },
    });

    let redirectUrl;
    if (isTbcConfigured()) {
      const r = await createBindPayment({
        merchantOrderId,
        returnUrl: `${process.env.SITE_URL}/payment-success?orderId=${merchantOrderId}&type=bind`,
        cancelUrl: `${process.env.SITE_URL}/payment-cancel?orderId=${merchantOrderId}`,
      });
      await prisma.vipPayment.update({
        where: { tbcOrderId: merchantOrderId },
        data: { tbcPayId: r.payId },
      });
      redirectUrl = r.redirectUrl;
    } else {
      // Demo mode: simulate card binding
      redirectUrl = `${process.env.SITE_URL}/api/payment/demo-confirm?orderId=${merchantOrderId}&type=bind`;
    }

    res.json({ orderId: merchantOrderId, redirectUrl });
  } catch (err) {
    console.error('[PAYMENT] cards/bind:', err.message);
    res.status(500).json({ error: 'ბარათის მიბმის შეცდომა: ' + err.message });
  }
});

// DELETE /api/payment/cards/:id — delete a saved card
router.delete('/cards/:id', requireAuth, async (req, res) => {
  try {
    const card = await prisma.savedCard.findUnique({ where: { id: req.params.id } });
    if (!card) return res.status(404).json({ error: 'ბარათი ვერ მოიძებნა' });
    if (card.userId !== req.user.id) return res.status(403).json({ error: 'წვდომა აკრძალულია' });

    await prisma.savedCard.delete({ where: { id: req.params.id } });

    // If deleted card was default, promote the next one
    const remaining = await prisma.savedCard.findFirst({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'asc' },
    });
    if (remaining && card.isDefault) {
      await prisma.savedCard.update({ where: { id: remaining.id }, data: { isDefault: true } });
    }

    res.json({ message: 'ბარათი წაიშალა' });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// PATCH /api/payment/cards/:id/default — set as default card
router.patch('/cards/:id/default', requireAuth, async (req, res) => {
  try {
    const card = await prisma.savedCard.findUnique({ where: { id: req.params.id } });
    if (!card || card.userId !== req.user.id) return res.status(404).json({ error: 'ბარათი ვერ მოიძებნა' });

    // Unset all, then set this one
    await prisma.savedCard.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
    await prisma.savedCard.update({ where: { id: req.params.id }, data: { isDefault: true } });

    res.json({ message: 'ძირითადი ბარათი დაყენდა' });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ══════════════════════════════════════════════════════════════
// ⭐ VIP PURCHASE
// ══════════════════════════════════════════════════════════════

// POST /api/payment/create-order — VIP purchase
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') return res.status(403).json({ error: 'VIP მხოლოდ ხელოსნებისთვისაა' });
    const { vipType, days } = req.body;
    if (!['vip', 'vipp'].includes(vipType) || ![1, 5].includes(parseInt(days)))
      return res.status(400).json({ error: 'VIP ტიპი ან ვადა არასწორია' });

    const daysN = parseInt(days);
    const priceTable = req.user.type === 'company' ? VIP_PRICES.company : VIP_PRICES.handyman;
    const amount = priceTable[vipType][daysN];
    const merchantOrderId = uuidv4();

    const payment = await prisma.vipPayment.create({
      data: { userId: req.user.id, vipType, days: daysN, amount, status: 'pending', tbcOrderId: merchantOrderId },
    });

    let redirectUrl;
    if (isTbcConfigured()) {
      const r = await createPayment({
        amount,
        description: `ხელოსანი.ge ${vipType === 'vipp' ? 'VIP+' : 'VIP'} — ${daysN} დღე`,
        merchantOrderId,
        returnUrl: `${process.env.SITE_URL}/payment-success?orderId=${merchantOrderId}&type=vip`,
        cancelUrl: `${process.env.SITE_URL}/payment-cancel?orderId=${merchantOrderId}`,
      });
      await prisma.vipPayment.update({ where: { id: payment.id }, data: { tbcPayId: r.payId } });
      redirectUrl = r.redirectUrl;
    } else {
      redirectUrl = `${process.env.SITE_URL}/api/payment/demo-confirm?orderId=${merchantOrderId}&type=vip`;
    }

    res.json({ orderId: merchantOrderId, redirectUrl });
  } catch (err) {
    console.error('[PAYMENT] create-order:', err.message);
    res.status(500).json({ error: 'გადახდის შეცდომა: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// 📋 SUBSCRIPTION (Pro / Top) with optional saved card
// ══════════════════════════════════════════════════════════════

// POST /api/payment/subscribe
// Body: { plan: 'pro'|'top', cardId?: string }
// If cardId provided + card exists → charge immediately (no redirect)
// Otherwise → redirect to TBC Pay
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') return res.status(403).json({ error: 'ტარიფი მხოლოდ ხელოსნებისთვისაა' });
    const { plan, cardId } = req.body;
    if (!['pro', 'top'].includes(plan)) return res.status(400).json({ error: 'ტარიფი არასწორია' });

    const prices = req.user.type === 'company' ? PLAN_PRICES.company : PLAN_PRICES.handyman;
    const amount = prices[plan];
    const merchantOrderId = uuidv4();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 86400000); // 30 days

    // Check if user has a saved card to charge directly
    let savedCard = null;
    if (cardId) {
      savedCard = await prisma.savedCard.findUnique({ where: { id: cardId } });
      if (!savedCard || savedCard.userId !== req.user.id) savedCard = null;
    }
    // If no cardId given, try default card
    if (!savedCard) {
      savedCard = await prisma.savedCard.findFirst({
        where: { userId: req.user.id, isDefault: true },
      });
    }

    const sub = await prisma.subscriptionPayment.create({
      data: {
        userId: req.user.id,
        plan,
        amount,
        status: 'pending',
        tbcOrderId: merchantOrderId,
        periodStart: now,
        periodEnd,
        cardId: savedCard?.id || null,
      },
    });

    let redirectUrl = null;

    if (savedCard && isTbcConfigured()) {
      // ✅ Charge saved card directly — no redirect needed
      try {
        const planLabel = plan === 'top' ? '🔝 TOP' : '⚡ Pro';
        const chargeResult = await chargeWithToken({
          recurrentPaymentId: savedCard.token,
          amount,
          description: `ხელოსანი.ge ${planLabel} — 30 დღე`,
          merchantOrderId,
        });

        // Check if charge succeeded
        if (chargeResult?.status === 'Succeeded' || chargeResult?.status === 'SUCCESS') {
          await activateSubByPaymentRecord(sub, chargeResult.payId);
          return res.json({
            success: true,
            charged: true,
            plan,
            planExpiresAt: periodEnd,
            message: `${planLabel} ტარიფი გააქტიურდა!`,
          });
        } else {
          // Charge failed — fall through to redirect
          console.warn('[PAYMENT] Direct charge failed, falling back to redirect:', chargeResult?.status);
        }
      } catch (chargeErr) {
        console.error('[PAYMENT] Direct charge error:', chargeErr.message);
        // Fall through to redirect
      }
    }

    // ── Fallback: redirect to TBC Pay ───────────────────────
    if (isTbcConfigured()) {
      const planLabel = plan === 'top' ? '🔝 TOP' : '⚡ Pro';
      const r = await createPayment({
        amount,
        description: `ხელოსანი.ge ${planLabel} — 30 დღე`,
        merchantOrderId,
        returnUrl: `${process.env.SITE_URL}/payment-success?orderId=${merchantOrderId}&type=sub`,
        cancelUrl: `${process.env.SITE_URL}/payment-cancel?orderId=${merchantOrderId}`,
        saveCard: true, // Always try to save card for future auto-renewal
      });
      await prisma.subscriptionPayment.update({ where: { id: sub.id }, data: { tbcPayId: r.payId } });
      redirectUrl = r.redirectUrl;
    } else {
      redirectUrl = `${process.env.SITE_URL}/api/payment/demo-confirm?orderId=${merchantOrderId}&type=sub`;
    }

    res.json({ orderId: merchantOrderId, redirectUrl });
  } catch (err) {
    console.error('[PAYMENT] subscribe:', err.message);
    res.status(500).json({ error: 'გადახდის შეცდომა: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// 🔄 AUTO-RENEWAL (called by cron job in server.js)
// Also exposed as internal endpoint for testing
// ══════════════════════════════════════════════════════════════

// POST /api/payment/internal/renew-subscriptions (for cron)
router.post('/internal/renew-subscriptions', async (req, res) => {
  // Only allow internal calls with the correct secret (all environments)
  const secret = req.headers['x-internal-secret'];
  if (secret !== process.env.INTERNAL_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const results = await runAutoRenewals();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Auto-renewal logic — exported for use in server.js cron
 */
async function runAutoRenewals() {
  const now = new Date();
  // Find subscriptions expiring in next 24 hours
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const renewed = [], failed = [], skipped = [];

  const expiringUsers = await prisma.user.findMany({
    where: {
      plan: { in: ['pro', 'top'] },
      planExpiresAt: { gte: now, lte: tomorrow },
      autoRenew: true,
    },
    include: {
      savedCards: {
        where: { isDefault: true },
        take: 1,
      },
    },
  });

  for (const user of expiringUsers) {
    const card = user.savedCards[0] || await prisma.savedCard.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    if (!card) {
      skipped.push({ userId: user.id, reason: 'no saved card' });
      continue;
    }

    if (!isTbcConfigured()) {
      // Demo mode: auto-renew without real charge
      const merchantOrderId = uuidv4();
      const periodStart = user.planExpiresAt;
      const periodEnd = new Date(periodStart.getTime() + 30 * 86400000);
      const prices = user.type === 'company' ? PLAN_PRICES.company : PLAN_PRICES.handyman;
      const amount = prices[user.plan] || 2900;

      const sub = await prisma.subscriptionPayment.create({
        data: {
          userId: user.id, plan: user.plan, amount, status: 'pending',
          tbcOrderId: merchantOrderId, periodStart, periodEnd,
          isAutoRenewal: true, cardId: card.id,
        },
      });
      await activateSubByPaymentRecord(sub, null);
      renewed.push({ userId: user.id, plan: user.plan, demo: true });
      continue;
    }

    try {
      const prices = user.type === 'company' ? PLAN_PRICES.company : PLAN_PRICES.handyman;
      const amount = prices[user.plan] || 2900;
      const merchantOrderId = uuidv4();
      const planLabel = user.plan === 'top' ? '🔝 TOP' : '⚡ Pro';
      const periodStart = user.planExpiresAt;
      const periodEnd = new Date(periodStart.getTime() + 30 * 86400000);

      const sub = await prisma.subscriptionPayment.create({
        data: {
          userId: user.id, plan: user.plan, amount, status: 'pending',
          tbcOrderId: merchantOrderId, periodStart, periodEnd,
          isAutoRenewal: true, cardId: card.id,
        },
      });

      const chargeResult = await chargeWithToken({
        recurrentPaymentId: card.token,
        amount,
        description: `ხელოსანი.ge ${planLabel} — ავტო-განახლება`,
        merchantOrderId,
      });

      if (chargeResult?.status === 'Succeeded' || chargeResult?.status === 'SUCCESS') {
        await activateSubByPaymentRecord(sub, chargeResult.payId);
        renewed.push({ userId: user.id, plan: user.plan });
      } else {
        await prisma.subscriptionPayment.update({ where: { id: sub.id }, data: { status: 'failed' } });
        failed.push({ userId: user.id, reason: chargeResult?.status });
      }
    } catch (err) {
      console.error(`[AUTO-RENEW] User ${user.id}:`, err.message);
      failed.push({ userId: user.id, reason: err.message });
    }
  }

  console.log(`[AUTO-RENEW] Renewed: ${renewed.length}, Failed: ${failed.length}, Skipped (no card): ${skipped.length}`);
  return { renewed, failed, skipped };
}

// ══════════════════════════════════════════════════════════════
// 🔔 TBC Pay Webhook Callback
// ══════════════════════════════════════════════════════════════

// POST /api/payment/callback
router.post('/callback', async (req, res) => {
  try {
    const { payId, status, recurrentPaymentId, cardDetails } = req.body;
    if (!payId) return res.status(400).send('Bad request');

    const isOk = status === 'Succeeded' || status === 'SUCCESS';
    const isFail = status === 'Failed' || status === 'FAIL' || status === 'Rejected';

    // ── Card bind callback ───────────────────────────────────
    // The bind payment has vipType='bind' and amount=10 (0.10₾)
    const bindPayment = await prisma.vipPayment.findFirst({
      where: { tbcPayId: payId, vipType: 'bind' },
    });
    if (bindPayment) {
      if (isOk) {
        // Save the card token
        if (recurrentPaymentId) {
          const last4 = cardDetails?.cardNumber?.slice(-4) || '****';
          const brand = detectBrand(cardDetails?.cardNumber || '');
          const expiry = cardDetails?.expiryDate || '';

          // Mark any existing cards as non-default
          const existing = await prisma.savedCard.count({ where: { userId: bindPayment.userId } });

          await prisma.savedCard.create({
            data: {
              userId: bindPayment.userId,
              last4,
              brand,
              expiry,
              token: recurrentPaymentId,
              isDefault: existing === 0, // First card is default
            },
          });
        }
        // Refund the 0.10₾ verification charge
        await refundPayment(payId, 10).catch(() => {});
        await prisma.vipPayment.update({ where: { id: bindPayment.id }, data: { status: 'paid' } });
      } else if (isFail) {
        await prisma.vipPayment.update({ where: { id: bindPayment.id }, data: { status: 'failed' } });
      }
      return res.status(200).send('OK');
    }

    // ── VIP payment callback ─────────────────────────────────
    const vip = await prisma.vipPayment.findFirst({ where: { tbcPayId: payId } });
    if (vip) {
      if (isOk) {
        await activateVipByPaymentRecord(vip);
        // Save card token if returned (for future auto-renewal)
        if (recurrentPaymentId) await saveCardFromCallback(vip.userId, recurrentPaymentId, cardDetails);
      } else if (isFail) {
        await prisma.vipPayment.update({ where: { id: vip.id }, data: { status: 'failed' } });
      }
      return res.status(200).send('OK');
    }

    // ── Subscription payment callback ────────────────────────
    const sub = await prisma.subscriptionPayment.findFirst({ where: { tbcPayId: payId } });
    if (sub) {
      if (isOk) {
        await activateSubByPaymentRecord(sub, payId);
        // Save card token if returned
        if (recurrentPaymentId) await saveCardFromCallback(sub.userId, recurrentPaymentId, cardDetails);
      } else if (isFail) {
        await prisma.subscriptionPayment.update({ where: { id: sub.id }, data: { status: 'failed' } });
      }
      return res.status(200).send('OK');
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[PAYMENT] callback:', err.message);
    res.status(500).send('Error');
  }
});

// ══════════════════════════════════════════════════════════════
// ✅ VERIFY + HISTORY
// ══════════════════════════════════════════════════════════════

// GET /api/payment/verify
router.get('/verify', requireAuth, async (req, res) => {
  try {
    const { orderId, type } = req.query;

    if (type === 'bind') {
      const cards = await prisma.savedCard.findMany({
        where: { userId: req.user.id },
        select: { id: true, last4: true, brand: true, isDefault: true },
      });
      return res.json({ type: 'bind', cards });
    }

    if (type === 'sub') {
      const sub = await prisma.subscriptionPayment.findFirst({ where: { tbcOrderId: orderId, userId: req.user.id } });
      if (!sub) return res.status(404).json({ error: 'გადახდა ვერ მოიძებნა' });
      if (sub.tbcPayId && isTbcConfigured()) {
        const s = await getPaymentStatus(sub.tbcPayId);
        if (s?.status === 'Succeeded') await activateSubByPaymentRecord(sub, sub.tbcPayId);
      }
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      return res.json({ type: 'sub', plan: user?.plan, planExpiresAt: user?.planExpiresAt });
    }

    const payment = await prisma.vipPayment.findFirst({ where: { tbcOrderId: orderId, userId: req.user.id } });
    if (!payment) return res.status(404).json({ error: 'გადახდა ვერ მოიძებნა' });
    if (payment.tbcPayId && isTbcConfigured()) {
      const s = await getPaymentStatus(payment.tbcPayId);
      if (s?.status === 'Succeeded') await activateVipByPaymentRecord(payment);
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ type: 'vip', vipType: user?.vipType, vipExpiresAt: user?.vipExpiresAt });
  } catch (err) {
    console.error('[PAYMENT] verify:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/payment/history
router.get('/history', requireAuth, async (req, res) => {
  try {
    const [vip, sub, cards] = await Promise.all([
      prisma.vipPayment.findMany({
        where: { userId: req.user.id, vipType: { not: 'bind' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.subscriptionPayment.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.savedCard.findMany({
        where: { userId: req.user.id },
        select: { id: true, last4: true, brand: true, expiry: true, isDefault: true, createdAt: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);
    res.json({ vipPayments: vip, subPayments: sub, savedCards: cards });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// PATCH /api/payment/auto-renew — toggle auto-renewal
router.patch('/auto-renew', requireAuth, async (req, res) => {
  try {
    const { autoRenew } = req.body;
    if (typeof autoRenew !== 'boolean') return res.status(400).json({ error: 'autoRenew boolean სავალდებულოა' });
    await prisma.user.update({ where: { id: req.user.id }, data: { autoRenew } });
    res.json({ autoRenew });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ══════════════════════════════════════════════════════════════
// 🧪 DEMO MODE
// ══════════════════════════════════════════════════════════════

// GET /api/payment/demo-confirm
router.get('/demo-confirm', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && isTbcConfigured())
    return res.status(404).send('Not found');

  const { orderId, type } = req.query;

  if (type === 'bind') {
    // Demo: simulate card binding
    const pending = await prisma.vipPayment.findFirst({
      where: { tbcOrderId: orderId, vipType: 'bind' },
    });
    if (pending) {
      const existing = await prisma.savedCard.count({ where: { userId: pending.userId } });
      await prisma.savedCard.create({
        data: {
          userId: pending.userId,
          last4: '4242',
          brand: 'Visa',
          expiry: '12/28',
          token: `demo_token_${uuidv4()}`,
          isDefault: existing === 0,
        },
      });
      await prisma.vipPayment.update({ where: { id: pending.id }, data: { status: 'paid' } });
    }
  } else if (type === 'sub') {
    await activateSubByOrderId(orderId);
  } else {
    await activateVipByOrderId(orderId);
  }

  res.redirect(
    `${process.env.SITE_URL || '/'}/payment-success?orderId=${orderId}&demo=1&type=${type || 'vip'}`
  );
});

// ══════════════════════════════════════════════════════════════
// 🛠 HELPERS
// ══════════════════════════════════════════════════════════════

function detectBrand(cardNumber) {
  const n = String(cardNumber || '');
  if (n.startsWith('4')) return 'Visa';
  if (n.startsWith('5') || n.startsWith('2')) return 'Mastercard';
  if (n.startsWith('3')) return 'Amex';
  return 'Card';
}

async function saveCardFromCallback(userId, recurrentPaymentId, cardDetails) {
  // Don't save duplicate tokens
  const exists = await prisma.savedCard.findFirst({ where: { token: recurrentPaymentId } });
  if (exists) return;

  const last4 = cardDetails?.cardNumber?.slice(-4) || '****';
  const brand = detectBrand(cardDetails?.cardNumber || '');
  const expiry = cardDetails?.expiryDate || '';
  const existing = await prisma.savedCard.count({ where: { userId } });

  await prisma.savedCard.create({
    data: { userId, last4, brand, expiry, token: recurrentPaymentId, isDefault: existing === 0 },
  });
}

async function activateVipByOrderId(orderId) {
  const p = await prisma.vipPayment.findFirst({ where: { tbcOrderId: orderId } });
  if (!p || p.status === 'paid') return;
  await activateVipByPaymentRecord(p);
}

async function activateVipByPaymentRecord(p) {
  if (p.status === 'paid') return;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + p.days * 86400000);

  await prisma.$transaction([
    prisma.vipPayment.update({ where: { id: p.id }, data: { status: 'paid', paidAt: now } }),
    prisma.user.update({
      where: { id: p.userId },
      data: { vipType: p.vipType, vipActivatedAt: now, vipExpiresAt: expiresAt },
    }),
  ]);

  const user = await prisma.user.findUnique({ where: { id: p.userId } });
  if (user?.email) {
    await sendEmail(
      user.email,
      `ხელოსანი.ge — ${p.vipType === 'vipp' ? 'VIP+' : 'VIP'} ჩართულია!`,
      vipConfirmTemplate(user.name, p.vipType, p.days, p.amount)
    );
  }
}

async function activateSubByOrderId(orderId) {
  const s = await prisma.subscriptionPayment.findFirst({ where: { tbcOrderId: orderId } });
  if (!s || s.status === 'paid') return;
  await activateSubByPaymentRecord(s, null);
}

async function activateSubByPaymentRecord(s, tbcPayId) {
  if (s.status === 'paid') return;
  const now = new Date();
  const planExpiresAt = s.periodEnd || new Date(now.getTime() + 30 * 86400000);

  const updates = [
    prisma.subscriptionPayment.update({
      where: { id: s.id },
      data: { status: 'paid', paidAt: now, ...(tbcPayId ? { tbcPayId } : {}) },
    }),
    prisma.user.update({
      where: { id: s.userId },
      data: {
        plan: s.plan,
        planExpiresAt,
        subscriptionStatus: 'active',
      },
    }),
  ];

  // TOP plan: auto VIP+ for the entire period (refreshed daily by cron)
  if (s.plan === 'top') {
    updates.push(
      prisma.user.update({
        where: { id: s.userId },
        data: { vipType: 'vipp', vipActivatedAt: now, vipExpiresAt: planExpiresAt },
      })
    );
  }

  await prisma.$transaction(updates);
  console.log(`[PAYMENT] Plan activated: ${s.userId} → ${s.plan} until ${planExpiresAt}`);

  // Send confirmation email
  const user = await prisma.user.findUnique({ where: { id: s.userId } });
  if (user?.email && typeof subConfirmTemplate === 'function') {
    await sendEmail(
      user.email,
      `ხელოსანი.ge — ${s.plan === 'top' ? '🔝 TOP' : '⚡ Pro'} ტარიფი ჩართულია!`,
      subConfirmTemplate(user.name, s.plan, planExpiresAt, s.amount)
    ).catch(() => {});
  }
}

module.exports = router;
module.exports.runAutoRenewals = runAutoRenewals;
