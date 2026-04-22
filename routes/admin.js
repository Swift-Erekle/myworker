// routes/admin.js
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { requireAuth, requireAdmin, requireStaff } = require('../middleware/auth');

const router = express.Router();

// All admin routes require auth + staff (or admin)
router.use(requireAuth, requireStaff);

// ── Analytics ─────────────────────────────────────────────────

// GET /api/admin/analytics
router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const [
      users, handymen, companies, staff,
      openReqs, totalOffers, acceptedOffers,
      totalReviews, blockedUsers, supportPending,
    ] = await Promise.all([
      prisma.user.count({ where: { type: 'user' } }),
      prisma.user.count({ where: { type: 'handyman' } }),
      prisma.user.count({ where: { type: 'company' } }),
      prisma.user.count({ where: { type: 'staff' } }),
      prisma.request.count({ where: { status: 'open' } }),
      prisma.offer.count(),
      prisma.offer.count({ where: { status: 'accepted' } }),
      prisma.review.count(),
      prisma.user.count({ where: { blocked: true } }),
      prisma.supportRequest.count({ where: { status: 'pending' } }),
    ]);

    const earnings = await prisma.offer.aggregate({
      where: { status: 'accepted' },
      _sum: { price: true },
    });
    const avgRating = await prisma.review.aggregate({ _avg: { stars: true } });
    const vipActive = await prisma.user.count({
      where: { vipType: { not: 'none' }, vipExpiresAt: { gt: new Date() } },
    });
    const paidRevenue = await prisma.vipPayment.aggregate({
      where: { status: 'paid' },
      _sum: { amount: true },
    });

    res.json({
      users, handymen, companies, staff,
      openReqs, totalOffers, acceptedOffers,
      totalReviews, blockedUsers, supportPending, vipActive,
      earnings: (earnings._sum.price || 0),
      avgRating: avgRating._avg.stars?.toFixed(1) || '0',
      vipRevenueTetri: paidRevenue._sum.amount || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── Users ─────────────────────────────────────────────────────

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const { type, search } = req.query;
    const where = { type: { not: 'admin' } };
    if (type && type !== 'all') where.type = type;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    const users = await prisma.user.findMany({
      where,
      select: {
        id: true, name: true, surname: true, email: true, phone: true,
        type: true, specialty: true, city: true, blocked: true,
        verified: true, emailVerified: true, jobs: true,
        vipType: true, vipExpiresAt: true, vipActivatedAt: true,
        plan: true, planExpiresAt: true, trialExpiresAt: true,
        autoRenew: true, createdAt: true,
        _count: { select: { requests: true, offers: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/admin/users/:id
router.get('/users/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        requests: { orderBy: { createdAt: 'desc' }, take: 10 },
        offers: { orderBy: { createdAt: 'desc' }, take: 10, include: { request: { select: { title: true } } } },
        reviewsReceived: { orderBy: { createdAt: 'desc' }, take: 5 },
        vipPayments: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });
    if (!user) return res.status(404).json({ error: 'მომხმარებელი ვერ მოიძებნა' });
    const { password, ...safe } = user;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// PATCH /api/admin/users/:id/block — toggle block
router.patch('/users/:id/block', async (req, res) => {
  try {
    if (req.params.id === 'admin1') {
      return res.status(403).json({ error: 'სისტემის ადმინის ბლოკვა შეუძლებელია' });
    }
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'მომხმარებელი ვერ მოიძებნა' });
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { blocked: !user.blocked },
      select: { id: true, blocked: true },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    if (req.params.id === 'admin1') {
      return res.status(403).json({ error: 'სისტემის ადმინის წაშლა შეუძლებელია' });
    }
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ message: 'ანგარიში წაიშალა' });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'მომხმარებელი ვერ მოიძებნა' });
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── Staff management (admin only) ─────────────────────────────

// POST /api/admin/staff
router.post('/staff', requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'სახელი, ელ-ფოსტა და პაროლი სავალდებულოა' });
    }
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: 'ელ-ფოსტა უკვე გამოყენებულია' });

    const hashed = await bcrypt.hash(password, 12);
    const staff = await prisma.user.create({
      data: { name, surname: '', email, phone: phone || null, password: hashed, type: 'staff', verified: true },
      select: { id: true, name: true, email: true, phone: true, type: true, createdAt: true },
    });
    res.status(201).json(staff);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── Requests management ───────────────────────────────────────

// GET /api/admin/requests
router.get('/requests', async (req, res) => {
  try {
    const requests = await prisma.request.findMany({
      include: {
        user: { select: { id: true, name: true, surname: true } },
        _count: { select: { offers: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// DELETE /api/admin/requests/:id
router.delete('/requests/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.request.delete({ where: { id: req.params.id } });
    res.json({ message: 'მოთხოვნა წაიშალა' });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── Support ───────────────────────────────────────────────────

// GET /api/admin/support
router.get('/support', async (req, res) => {
  try {
    const reqs = await prisma.supportRequest.findMany({
      include: {
        user: { select: { id: true, name: true, surname: true, type: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 100 },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(reqs);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/admin/support — create support request (called from frontend/ARIA)
router.post('/support', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    // Check for existing open request
    const existing = await prisma.supportRequest.findFirst({
      where: { userId: req.user.id, status: { not: 'closed' } },
    });
    if (existing) return res.status(409).json({ supportId: existing.id, message: 'უკვე გახსნილი მოთხოვნა არსებობს' });

    const sr = await prisma.supportRequest.create({
      data: {
        userId: req.user.id,
        lastMsg: (message || '').substring(0, 100),
        messages: {
          create: message ? { fromRole: 'user', content: String(message) } : undefined,
        },
      },
    });
    const io = req.app.get('io');
    if (io) io.emit('newSupportRequest', { supportId: sr.id });
    res.status(201).json(sr);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// PATCH /api/admin/support/:id/status
router.patch('/support/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'active', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'სტატუსი არასწორია' });
    }
    const updated = await prisma.supportRequest.update({
      where: { id: req.params.id },
      data: { status },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
