// routes/payment.js
// BUG FIX (DeepSeek): returnUrl/cancelUrl routes (/payment-success, /payment-cancel)
// were not implemented. TBC Pay callback was missing.
// Now includes:
//  - createOrder endpoint
//  - TBC callback webhook (verifies payment server-side)
//  - Payment status check
//  - VIP activation after confirmed payment

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { createPayment, getPaymentStatus } = require('../utils/tbcPay');
const { sendEmail, vipConfirmTemplate } = require('../utils/email');

const router = express.Router();

// VIP pricing table
const VIP_PRICES = {
  vip:  { 1: 200, 5: 1000 }, // tetri (2₾, 10₾)
  vipp: { 1: 400, 5: 1800 }, // tetri (4₾, 18₾)
};

// POST /api/payment/create-order — initiate VIP payment
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') {
      return res.status(403).json({ error: 'VIP მხოლოდ ხელოსნებისთვისაა' });
    }

    const { vipType, days } = req.body;
    const validTypes = ['vip', 'vipp'];
    const validDays = [1, 5];
    if (!validTypes.includes(vipType) || !validDays.includes(parseInt(days))) {
      return res.status(400).json({ error: 'VIP ტიპი ან ვადა არასწორია' });
    }
    const daysN = parseInt(days);
    const amount = VIP_PRICES[vipType][daysN];
    const merchantOrderId = uuidv4();
    const description = `ხელოსანი.ge ${vipType === 'vipp' ? 'VIP+' : 'VIP'} — ${daysN} დღე`;

    // Save pending payment record
    const payment = await prisma.vipPayment.create({
      data: {
        userId: req.user.id,
        vipType,
        days: daysN,
        amount,
        status: 'pending',
        tbcOrderId: merchantOrderId,
      },
    });

    // Create TBC Pay order
    let redirectUrl;
    if (process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_')) {
      const tbcResult = await createPayment({
        amount,
        description,
        merchantOrderId,
        returnUrl: `${process.env.SITE_URL}/payment-success?orderId=${merchantOrderId}`,
        cancelUrl: `${process.env.SITE_URL}/payment-cancel?orderId=${merchantOrderId}`,
      });
      // Save TBC's payId
      await prisma.vipPayment.update({
        where: { id: payment.id },
        data: { tbcPayId: tbcResult.payId },
      });
      redirectUrl = tbcResult.redirectUrl;
    } else {
      // DEMO mode — simulate payment
      redirectUrl = `${process.env.SITE_URL}/api/payment/demo-confirm?orderId=${merchantOrderId}`;
    }

    res.json({ orderId: merchantOrderId, redirectUrl });
  } catch (err) {
    console.error('[PAYMENT] create-order error:', err.message);
    res.status(500).json({ error: 'გადახდის სისტემის შეცდომა: ' + err.message });
  }
});

// GET /api/payment/demo-confirm — DEMO only: simulate successful payment
router.get('/demo-confirm', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_')) {
    return res.status(404).send('Not found');
  }
  const { orderId } = req.query;
  await activateVipByOrderId(orderId);
  res.redirect(`${process.env.SITE_URL || '/'}/payment-success?orderId=${orderId}&demo=1`);
});

// POST /api/payment/callback — TBC Pay webhook (called by TBC servers)
router.post('/callback', async (req, res) => {
  try {
    // TBC sends payId and status in body
    const { payId, status } = req.body;
    if (!payId) return res.status(400).send('Bad request');

    const payment = await prisma.vipPayment.findFirst({ where: { tbcPayId: payId } });
    if (!payment) return res.status(404).send('Order not found');

    if (status === 'Succeeded' || status === 'SUCCESS') {
      await activateVipByPaymentRecord(payment);
      return res.status(200).send('OK');
    }

    if (status === 'Failed' || status === 'FAIL' || status === 'Rejected') {
      await prisma.vipPayment.update({ where: { id: payment.id }, data: { status: 'failed' } });
      return res.status(200).send('OK');
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[PAYMENT] callback error:', err.message);
    res.status(500).send('Error');
  }
});

// GET /api/payment/verify?orderId=xxx — called by frontend on return from TBC
router.get('/verify', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.query;
    const payment = await prisma.vipPayment.findFirst({
      where: { tbcOrderId: orderId, userId: req.user.id },
    });
    if (!payment) return res.status(404).json({ error: 'გადახდა ვერ მოიძებნა' });

    // If TBC Pay is configured, verify with TBC
    if (payment.tbcPayId && process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_')) {
      const tbcStatus = await getPaymentStatus(payment.tbcPayId);
      if (tbcStatus?.status === 'Succeeded') {
        await activateVipByPaymentRecord(payment);
      } else {
        await prisma.vipPayment.update({
          where: { id: payment.id },
          data: { status: tbcStatus?.status === 'Failed' ? 'failed' : 'pending' },
        });
      }
    }

    const refreshed = await prisma.vipPayment.findUnique({ where: { id: payment.id } });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ payment: refreshed, vipType: user?.vipType, vipExpiresAt: user?.vipExpiresAt });
  } catch (err) {
    console.error('[PAYMENT] verify error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/payment/history — current user's payment history
router.get('/history', requireAuth, async (req, res) => {
  const payments = await prisma.vipPayment.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(payments);
});

// ── Helpers ───────────────────────────────────────────────────────

async function activateVipByOrderId(orderId) {
  const payment = await prisma.vipPayment.findFirst({ where: { tbcOrderId: orderId } });
  if (!payment || payment.status === 'paid') return;
  await activateVipByPaymentRecord(payment);
}

async function activateVipByPaymentRecord(payment) {
  if (payment.status === 'paid') return; // idempotent
  const now = new Date();
  const expiresAt = new Date(now.getTime() + payment.days * 86400000);

  await prisma.$transaction([
    prisma.vipPayment.update({
      where: { id: payment.id },
      data: { status: 'paid', paidAt: now },
    }),
    prisma.user.update({
      where: { id: payment.userId },
      data: {
        vipType: payment.vipType,
        vipActivatedAt: now,
        vipExpiresAt: expiresAt,
      },
    }),
  ]);

  // Send confirmation email
  const user = await prisma.user.findUnique({ where: { id: payment.userId } });
  if (user?.email) {
    await sendEmail(
      user.email,
      `ხელოსანი.ge — ${payment.vipType === 'vipp' ? 'VIP+' : 'VIP'} ჩართულია!`,
      vipConfirmTemplate(user.name, payment.vipType, payment.days, payment.amount)
    );
  }
}

module.exports = router;
