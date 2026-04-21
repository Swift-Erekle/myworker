// routes/requests.js
const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { upload, handleCloudinaryUpload } = require('../middleware/upload');

const router = express.Router();

// GET /api/requests — list all open requests (public)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, city, urgency, status } = req.query;
    const where = {};
    if (category) where.category = category;
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (urgency) where.urgency = urgency;
    where.status = status || 'open';

    const requests = await prisma.request.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, surname: true } },
        _count: { select: { offers: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(requests);
  } catch (err) {
    console.error('[REQUESTS] list error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/requests/mine — get current user's requests
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const requests = await prisma.request.findMany({
      where: { userId: req.user.id },
      include: {
        offers: {
          include: {
            handyman: { select: { id: true, name: true, surname: true, specialty: true, emoji: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { offers: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/requests/:id — single request
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const req_ = await prisma.request.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, name: true, surname: true } },
        offers: {
          include: {
            handyman: {
              select: {
                id: true, name: true, surname: true, specialty: true,
                emoji: true, color: true, verified: true,
                reviewsReceived: { select: { stars: true } },
              },
            },
          },
        },
      },
    });
    if (!req_) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });
    res.json(req_);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/requests — create request (users only)
router.post(
  '/',
  requireAuth,
  upload.array('media', 5),
  handleCloudinaryUpload,
  async (req, res) => {
    try {
      if (req.user.type !== 'user') {
        return res.status(403).json({ error: 'მხოლოდ მომხმარებელს შეუძლია მოთხოვნის შექმნა' });
      }
      const { title, category, desc, city, budget, urgency } = req.body;
      if (!title || !category) {
        return res.status(400).json({ error: 'სათაური და კატეგორია სავალდებულოა' });
      }

      const media = req.uploadedFiles || [];
      const request = await prisma.request.create({
        data: {
          userId: req.user.id,
          title: String(title).trim(),
          category,
          desc: desc || null,
          city: city || 'თბილისი',
          budget: budget ? parseInt(budget) : null,
          urgency: urgency === 'urgent' ? 'urgent' : 'normal',
          media,
        },
        include: { _count: { select: { offers: true } } },
      });
      res.status(201).json(request);
    } catch (err) {
      console.error('[REQUESTS] create error:', err.message);
      res.status(500).json({ error: 'სერვერის შეცდომა' });
    }
  }
);

// PATCH /api/requests/:id/status — mark completed
router.patch('/:id/status', requireAuth, async (req, res) => {
  try {
    const request = await prisma.request.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });
    if (request.userId !== req.user.id && req.user.type !== 'admin') {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }
    const { status } = req.body;
    if (!['open', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ error: 'სტატუსი არასწორია' });
    }
    const updated = await prisma.request.update({ where: { id: req.params.id }, data: { status } });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// DELETE /api/requests/:id — delete (owner or admin)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const request = await prisma.request.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });
    if (request.userId !== req.user.id && req.user.type !== 'admin') {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }
    await prisma.request.delete({ where: { id: req.params.id } });
    res.json({ message: 'მოთხოვნა წაიშალა' });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
