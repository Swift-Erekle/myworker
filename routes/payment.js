// routes/payment.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { createPayment, getPaymentStatus } = require('../utils/tbcPay');
const { sendEmail, vipConfirmTemplate } = require('../utils/email');

const router = express.Router();

const VIP_PRICES = {
  handyman: { vip: { 1: 200, 5: 1000 }, vipp: { 1: 400, 5: 1800 } },
  company:  { vip: { 1: 1000, 5: 4000 }, vipp: { 1: 1500, 5: 6000 } },
};
const PLAN_PRICES = {
  handyman: { pro: 2900, top: 6900 },
  company:  { pro: 9900, top: 14900 },
};

// POST /api/payment/create-order — VIP
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') return res.status(403).json({ error: 'VIP მხოლოდ ხელოსნებისთვისაა' });
    const { vipType, days } = req.body;
    if (!['vip','vipp'].includes(vipType) || ![1,5].includes(parseInt(days)))
      return res.status(400).json({ error: 'VIP ტიპი ან ვადა არასწორია' });
    const daysN = parseInt(days);
    const priceTable = req.user.type === 'company' ? VIP_PRICES.company : VIP_PRICES.handyman;
    const amount = priceTable[vipType][daysN];
    const merchantOrderId = uuidv4();
    const payment = await prisma.vipPayment.create({
      data: { userId: req.user.id, vipType, days: daysN, amount, status: 'pending', tbcOrderId: merchantOrderId },
    });
    let redirectUrl;
    if (process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_')) {
      const r = await createPayment({
        amount, description: `ხელოსანი.ge ${vipType==='vipp'?'VIP+':'VIP'} — ${daysN} დღე`, merchantOrderId,
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

// POST /api/payment/subscribe — Pro/Top plan
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') return res.status(403).json({ error: 'ტარიფი მხოლოდ ხელოსნებისთვისაა' });
    const { plan } = req.body;
    if (!['pro','top'].includes(plan)) return res.status(400).json({ error: 'ტარიფი არასწორია' });
    const prices = req.user.type === 'company' ? PLAN_PRICES.company : PLAN_PRICES.handyman;
    const amount = prices[plan];
    const merchantOrderId = uuidv4();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 86400000);
    const sub = await prisma.subscriptionPayment.create({
      data: { userId: req.user.id, plan, amount, status: 'pending', tbcOrderId: merchantOrderId, periodStart: now, periodEnd },
    });
    let redirectUrl;
    if (process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_')) {
      const r = await createPayment({
        amount, description: `ხელოსანი.ge ${plan==='top'?'🔝 TOP':'⚡ Pro'} — 30 დღე`, merchantOrderId,
        returnUrl: `${process.env.SITE_URL}/payment-success?orderId=${merchantOrderId}&type=sub`,
        cancelUrl: `${process.env.SITE_URL}/payment-cancel?orderId=${merchantOrderId}`,
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

// GET /api/payment/demo-confirm
router.get('/demo-confirm', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_'))
    return res.status(404).send('Not found');
  const { orderId, type } = req.query;
  if (type === 'sub') await activateSubByOrderId(orderId);
  else await activateVipByOrderId(orderId);
  res.redirect(`${process.env.SITE_URL || '/'}/payment-success?orderId=${orderId}&demo=1&type=${type||'vip'}`);
});

// POST /api/payment/callback — TBC webhook
router.post('/callback', async (req, res) => {
  try {
    const { payId, status } = req.body;
    if (!payId) return res.status(400).send('Bad request');
    const isOk = status === 'Succeeded' || status === 'SUCCESS';
    const isFail = status === 'Failed' || status === 'FAIL' || status === 'Rejected';
    const vip = await prisma.vipPayment.findFirst({ where: { tbcPayId: payId } });
    if (vip) {
      if (isOk) await activateVipByPaymentRecord(vip);
      else if (isFail) await prisma.vipPayment.update({ where: { id: vip.id }, data: { status: 'failed' } });
      return res.status(200).send('OK');
    }
    const sub = await prisma.subscriptionPayment.findFirst({ where: { tbcPayId: payId } });
    if (sub) {
      if (isOk) await activateSubByPaymentRecord(sub);
      else if (isFail) await prisma.subscriptionPayment.update({ where: { id: sub.id }, data: { status: 'failed' } });
      return res.status(200).send('OK');
    }
    res.status(200).send('OK');
  } catch (err) { console.error('[PAYMENT] callback:', err.message); res.status(500).send('Error'); }
});

// GET /api/payment/verify
router.get('/verify', requireAuth, async (req, res) => {
  try {
    const { orderId, type } = req.query;
    if (type === 'sub') {
      const sub = await prisma.subscriptionPayment.findFirst({ where: { tbcOrderId: orderId, userId: req.user.id } });
      if (!sub) return res.status(404).json({ error: 'გადახდა ვერ მოიძებნა' });
      if (sub.tbcPayId && process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_')) {
        const s = await getPaymentStatus(sub.tbcPayId);
        if (s?.status === 'Succeeded') await activateSubByPaymentRecord(sub);
      }
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      return res.json({ type: 'sub', plan: user?.plan, planExpiresAt: user?.planExpiresAt });
    }
    const payment = await prisma.vipPayment.findFirst({ where: { tbcOrderId: orderId, userId: req.user.id } });
    if (!payment) return res.status(404).json({ error: 'გადახდა ვერ მოიძებნა' });
    if (payment.tbcPayId && process.env.TBC_PAY_CLIENT_ID && !process.env.TBC_PAY_CLIENT_ID.startsWith('YOUR_')) {
      const s = await getPaymentStatus(payment.tbcPayId);
      if (s?.status === 'Succeeded') await activateVipByPaymentRecord(payment);
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ type: 'vip', vipType: user?.vipType, vipExpiresAt: user?.vipExpiresAt });
  } catch (err) { console.error('[PAYMENT] verify:', err.message); res.status(500).json({ error: 'სერვერის შეცდომა' }); }
});

// GET /api/payment/history
router.get('/history', requireAuth, async (req, res) => {
  const [vip, sub] = await Promise.all([
    prisma.vipPayment.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } }),
    prisma.subscriptionPayment.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({ vipPayments: vip, subPayments: sub });
});

// ── Helpers ────────────────────────────────────────────────────────────────
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
    prisma.user.update({ where: { id: p.userId }, data: { vipType: p.vipType, vipActivatedAt: now, vipExpiresAt: expiresAt } }),
  ]);
  const user = await prisma.user.findUnique({ where: { id: p.userId } });
  if (user?.email) await sendEmail(user.email, `ხელოსანი.ge — ${p.vipType==='vipp'?'VIP+':'VIP'} ჩართულია!`, vipConfirmTemplate(user.name, p.vipType, p.days, p.amount));
}
async function activateSubByOrderId(orderId) {
  const s = await prisma.subscriptionPayment.findFirst({ where: { tbcOrderId: orderId } });
  if (!s || s.status === 'paid') return;
  await activateSubByPaymentRecord(s);
}
async function activateSubByPaymentRecord(s) {
  if (s.status === 'paid') return;
  const now = new Date();
  const planExpiresAt = s.periodEnd || new Date(now.getTime() + 30 * 86400000);
  const updates = [
    prisma.subscriptionPayment.update({ where: { id: s.id }, data: { status: 'paid', paidAt: now } }),
    prisma.user.update({ where: { id: s.userId }, data: { plan: s.plan, planExpiresAt } }),
  ];
  // TOP plan = auto VIP+ for entire period
  if (s.plan === 'top') {
    updates.push(prisma.user.update({ where: { id: s.userId }, data: { vipType: 'vipp', vipActivatedAt: now, vipExpiresAt: planExpiresAt } }));
  }
  await prisma.$transaction(updates);
  console.log(`[PAYMENT] Plan activated: ${s.userId} → ${s.plan} until ${planExpiresAt}`);
}

module.exports = router;
