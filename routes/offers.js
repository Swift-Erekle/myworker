// routes/offers.js
const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/offers — create offer (handyman/company only)
router.post('/', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') {
      return res.status(403).json({ error: 'მხოლოდ ხელოსანს შეუძლია შეთავაზება' });
    }
    const { requestId, price, duration, comment } = req.body;
    if (!requestId || !price) {
      return res.status(400).json({ error: 'მოთხოვნის ID და ფასი სავალდებულოა' });
    }

    // ── Plan limit check: Start = 5 offers/month ────────────────
    const userPlan = req.user.plan || 'start';
    if (userPlan === 'start') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthlyCount = await prisma.offer.count({
        where: { handymanId: req.user.id, createdAt: { gte: startOfMonth } },
      });
      if (monthlyCount >= 5) {
        return res.status(403).json({
          error: 'Start ტარიფის 5 შეთ./თვე ამოგეწურა. Pro ან TOP ტარიფზე გადასვლა საჭიროა.',
          upgradeRequired: true,
        });
      }
    }

    const request = await prisma.request.findUnique({ where: { id: requestId } });
    if (!request) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });
    if (request.status !== 'open') {
      return res.status(400).json({ error: 'მოთხოვნა დახურულია' });
    }

    // Check for duplicate offer
    const existing = await prisma.offer.findUnique({
      where: { requestId_handymanId: { requestId, handymanId: req.user.id } },
    });
    if (existing) return res.status(409).json({ error: 'შეთავაზება უკვე გაგზავნილია' });

    const offer = await prisma.offer.create({
      data: {
        requestId,
        handymanId: req.user.id,
        price: parseInt(price),
        duration: duration || null,
        comment: comment || null,
      },
      include: {
        handyman: {
          select: {
            id: true, name: true, surname: true, specialty: true,
            emoji: true, color: true, verified: true,
            reviewsReceived: { select: { stars: true } },
          },
        },
      },
    });
    res.status(201).json(offer);
  } catch (err) {
    console.error('[OFFERS] create error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/offers/mine — handyman's own offers
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const offers = await prisma.offer.findMany({
      where: { handymanId: req.user.id },
      include: {
        request: { select: { id: true, title: true, category: true, city: true, status: true } },
        chat: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(offers);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/offers/:id/accept — accept an offer (request owner only)
router.post('/:id/accept', requireAuth, async (req, res) => {
  try {
    if (req.user.type !== 'user') {
      return res.status(403).json({ error: 'მხოლოდ მომხმარებელს შეუძლია შეთავაზების მიღება' });
    }

    const offer = await prisma.offer.findUnique({
      where: { id: req.params.id },
      include: { request: true },
    });
    if (!offer) return res.status(404).json({ error: 'შეთავაზება ვერ მოიძებნა' });
    if (offer.request.userId !== req.user.id) {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }
    if (offer.status !== 'pending') {
      return res.status(400).json({ error: 'შეთავაზება უკვე დამუშავებულია' });
    }

    // Accept offer, update request status, create chat
    const [updatedOffer, , chat] = await prisma.$transaction([
      prisma.offer.update({ where: { id: offer.id }, data: { status: 'accepted' } }),
      prisma.request.update({ where: { id: offer.requestId }, data: { status: 'in_progress' } }),
      prisma.chat.create({
        data: {
          offerId: offer.id,
          requestId: offer.requestId,
          userId: req.user.id,
          handymanId: offer.handymanId,
          messages: {
            create: {
              fromId: 'system',
              type: 'text',
              content: `ჩათი გაიხსნა: "${offer.request.title}"`,
            },
          },
        },
        include: { messages: true },
      }),
    ]);

    res.json({ offer: updatedOffer, chatId: chat.id });
  } catch (err) {
    console.error('[OFFERS] accept error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/reviews — submit a review
router.post('/reviews', requireAuth, async (req, res) => {
  try {
    if (req.user.type !== 'user') {
      return res.status(403).json({ error: 'მხოლოდ მომხმარებელს შეუძლია შეფასება' });
    }
    const { handymanId, stars, comment } = req.body;
    if (!handymanId || !stars) return res.status(400).json({ error: 'ხელოსანი და შეფასება სავალდებულოა' });
    const starsN = parseInt(stars);
    if (starsN < 1 || starsN > 5) return res.status(400).json({ error: 'შეფასება 1-5' });

    // Check: has user worked with this handyman?
    const hasWorked = await prisma.offer.findFirst({
      where: {
        handymanId,
        status: 'accepted',
        request: { userId: req.user.id },
      },
    });
    if (!hasWorked) {
      return res.status(403).json({ error: 'მხოლოდ გარიგების შემდეგ შეიძლება შეფასება' });
    }

    // Check for duplicate review
    const already = await prisma.review.findUnique({
      where: { reviewerId_handymanId: { reviewerId: req.user.id, handymanId } },
    });
    if (already) return res.status(409).json({ error: 'შეფასება უკვე დატოვებული გაქვს' });

    const review = await prisma.review.create({
      data: {
        reviewerId: req.user.id,
        handymanId,
        stars: starsN,
        comment: comment || null,
      },
      include: {
        reviewer: { select: { id: true, name: true, surname: true } },
      },
    });

    // Update handyman job count
    const acceptedCount = await prisma.offer.count({ where: { handymanId, status: 'accepted' } });
    await prisma.user.update({ where: { id: handymanId }, data: { jobs: acceptedCount } });

    res.status(201).json(review);
  } catch (err) {
    console.error('[REVIEWS] create error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
