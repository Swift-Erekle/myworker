// routes/offers.js
// ════════════════════════════════════════════════════════════════
// FIXES vs previous version:
// 1. Trial expiry check added (trialExpiresAt < now → block)
// 2. upgradeRequired: true returned in all limit cases
// 3. Web Push notifications on new offer + offer accepted
// ════════════════════════════════════════════════════════════════
const express = require('express');
const prisma  = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { sendPushToUser } = require('../utils/webPush');
const { sendExpoPushToUser } = require('../utils/expoPush');
const { createNotification } = require('./notifications');

const router = express.Router();

// ── POST /api/offers ──────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    if (req.user.type === 'user') {
      return res.status(403).json({ error: 'მხოლოდ ხელოსანს შეუძლია შეთავაზება' });
    }

    const { requestId, price, duration, durationMinutes, comment } = req.body;
    if (!requestId || !price) {
      return res.status(400).json({ error: 'მოთხოვნის ID და ფასი სავალდებულოა' });
    }
    if (!durationMinutes || parseInt(durationMinutes) <= 0) {
      return res.status(400).json({ error: 'სამუშაოს ხანგრძლივობა (წუთებში) სავალდებულოა' });
    }

    // ── Plan limit check ──────────────────────────────────────
    const plan = req.user.plan || 'start';

    // ✅ DS#7: extra safety — reject if subscriptionStatus explicitly 'expired'
    if (req.user.subscriptionStatus === 'expired' && plan !== 'start') {
      return res.status(403).json({
        error: 'გამოწერა ვადაგასულია. გაახლე ტარიფი.',
        upgradeRequired: true,
        planExpired: true,
      });
    }

    if (plan === 'start') {
      // FIX 1: Check if free trial has expired (null = never set = expired)
      if (!req.user.trialExpiresAt || new Date(req.user.trialExpiresAt) < new Date()) {
        return res.status(403).json({
          error: 'Start ტარიფის 3-თვიანი ვადა გასულია. Pro ან TOP-ზე გადასვლა საჭიროა.',
          upgradeRequired: true,
          trialExpired: true,
        });
      }

      // FIX 2: Monthly offer limit (5 per month for Start)
      const now          = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthlyCount = await prisma.offer.count({
        where: { handymanId: req.user.id, createdAt: { gte: startOfMonth } },
      });
      if (monthlyCount >= 5) {
        return res.status(403).json({
          error: `Start ტარიფის 5 შეთ./თვე ამოგეწურა (${monthlyCount}/5). Pro-ზე გადადი შეუზღუდავი შეთავაზებისთვის.`,
          upgradeRequired: true,
          monthlyLimitReached: true,
        });
      }
    }

    // ── Check Pro/Top plan expiry ─────────────────────────────
    if (plan === 'pro' || plan === 'top') {
      if (!req.user.planExpiresAt || new Date(req.user.planExpiresAt) < new Date()) {
        return res.status(403).json({
          error: `${plan === 'top' ? 'TOP' : 'Pro'} ტარიფის ვადა გასულია ან არ არის გააქტიურებული.`,
          upgradeRequired: true,
          planExpired: true,
        });
      }
    }

    // ── Find request ──────────────────────────────────────────
    const request = await prisma.request.findUnique({ where: { id: requestId } });
    if (!request) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });
    if (!['open', 'pending'].includes(request.status)) return res.status(400).json({ error: 'მოთხოვნა აღარ იღებს შეთავაზებებს' });

    // ── Check duplicate ───────────────────────────────────────
    // ✅ Task 6: Allow re-sending if previous offer was rejected or disagreed
    const existing = await prisma.offer.findUnique({
      where: { requestId_handymanId: { requestId, handymanId: req.user.id } },
    });
    if (existing) {
      if (['rejected', 'disagreed'].includes(existing.status)) {
        await prisma.offer.delete({ where: { id: existing.id } }).catch(() => {});
      } else {
        return res.status(409).json({ error: 'შეთავაზება უკვე გაგზავნილია' });
      }
    }

    // ── Bump request status: open → pending (first offer) ─────
    // Stays 'pending' until owner accepts one
    if (request.status === 'open') {
      await prisma.request.update({
        where: { id: requestId },
        data:  { status: 'pending' },
      }).catch(() => {});
    }

    const offer = await prisma.offer.create({
      data: {
        requestId,
        handymanId: req.user.id,
        price:    parseInt(price),
        duration: duration || null,
        durationMinutes: parseInt(durationMinutes),
        comment:  comment  || null,
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

    // ── Push: notify request owner of new offer ───────────────
    sendPushToUser(prisma, request.userId, {
      title: `${req.user.emoji || '🔧'} ახალი შეთავაზება!`,
      body:  `${req.user.name} — ₾${parseInt(price)}${comment ? ': ' + comment.substring(0, 60) : ''}`,
      tag:   'new-offer-' + requestId,
      url:   `/?req=${requestId}`,
    }).catch(() => {});
    sendExpoPushToUser(prisma, request.userId, {
      title: `${req.user.emoji || '🔧'} ახალი შეთავაზება!`,
      body:  `${req.user.name} — ₾${parseInt(price)}${comment ? ': ' + comment.substring(0, 60) : ''}`,
      data:  { requestId, type: 'new_offer' },
    }).catch(() => {});

    // ── In-app bell notification ──────────────────────────────
    createNotification({
      prisma,
      io: req.app.get('io'),
      userId: request.userId,
      type:   'new_offer',
      title:  `${req.user.emoji || '🔧'} ახალი შეთავაზება`,
      body:   `${req.user.name} ${req.user.surname || ''} — ₾${parseInt(price)}`,
      link:   `?req=${requestId}`,
    }).catch(() => {});

    res.status(201).json(offer);
  } catch (err) {
    console.error('[OFFERS] create error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── GET /api/offers/mine ──────────────────────────────────────
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const offers = await prisma.offer.findMany({
      where: { handymanId: req.user.id },
      include: {
        request: { select: { id: true, title: true, category: true, city: true, status: true } },
        chat:    { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(offers);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── PATCH /api/offers/:id ─────────────────────────────────────
// Handyman edits their own offer while it's still pending.
// Allowed fields: price, duration, comment.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { price, duration, durationMinutes, comment } = req.body;

    const offer = await prisma.offer.findUnique({
      where: { id: req.params.id },
      include: { request: true },
    });
    if (!offer) return res.status(404).json({ error: 'შეთავაზება ვერ მოიძებნა' });

    // Only the offer's author can edit it
    if (offer.handymanId !== req.user.id) {
      return res.status(403).json({ error: 'მხოლოდ შეთავაზების ავტორს შეუძლია რედაქტირება' });
    }

    // Only pending offers can be edited (once accepted, it's locked)
    if (offer.status !== 'pending') {
      return res.status(400).json({ error: 'მხოლოდ მოლოდინში მყოფი შეთავაზების რედაქტირება შეიძლება' });
    }

    // Request must still be open/pending (not in_progress/completed/closed)
    if (!['open', 'pending'].includes(offer.request.status)) {
      return res.status(400).json({ error: 'მოთხოვნა აღარ იღებს ცვლილებებს' });
    }

    // Build the update data — only apply fields that were actually sent
    const data = {};
    if (price !== undefined) {
      const parsed = parseInt(price);
      if (isNaN(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'ფასი არასწორია' });
      }
      data.price = parsed;
    }
    if (duration        !== undefined) data.duration        = duration || null;
    if (durationMinutes !== undefined) data.durationMinutes = parseInt(durationMinutes) || null;
    if (comment         !== undefined) data.comment         = comment  || null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'არცერთი ველი არ შეცვლილა' });
    }

    const updated = await prisma.offer.update({
      where: { id: req.params.id },
      data,
      include: { handyman: { select: { id: true, name: true, surname: true, avatar: true, emoji: true, color: true, specialty: true } } },
    });

    // Notify the request owner via socket if available
    try {
      const io = req.app.get('io');
      if (io) io.to(`user:${offer.request.userId}`).emit('offerUpdated', updated);
    } catch (_) {}

    res.json(updated);
  } catch (err) {
    console.error('[OFFERS] edit error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── POST /api/offers/:id/reject ───────────────────────────────
// Request owner rejects a pending offer. Also notifies the handyman.
router.post('/:id/reject', requireAuth, async (req, res) => {
  try {
    if (req.user.type !== 'user') {
      return res.status(403).json({ error: 'მხოლოდ მომხმარებელს შეუძლია შეთავაზების უარყოფა' });
    }

    const offer = await prisma.offer.findUnique({
      where: { id: req.params.id },
      include: { request: true },
    });
    if (!offer) return res.status(404).json({ error: 'შეთავაზება ვერ მოიძებნა' });
    if (offer.request.userId !== req.user.id) return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    if (offer.status !== 'pending') return res.status(400).json({ error: 'შეთავაზება უკვე დამუშავებულია' });

    const updated = await prisma.offer.update({
      where: { id: offer.id },
      data:  { status: 'rejected' },
    });
    res.json({ offer: updated });

    // Notify the handyman their offer was rejected — with link to request so they can retry
    sendPushToUser(prisma, offer.handymanId, {
      title: 'შეთავაზება არ იქნა მიღებული',
      body:  `"${offer.request.title}"`,
      tag:   'offer-rejected-' + offer.id,
      url:   `/?req=${offer.requestId}`,
    }).catch(() => {});
    sendExpoPushToUser(prisma, offer.handymanId, {
      title: 'შეთავაზება არ იქნა მიღებული',
      body:  `"${offer.request.title}"`,
      data:  { type: 'offer_rejected', offerId: offer.id, requestId: offer.requestId },
      channelId: 'default',
    }).catch(() => {});

    // ── In-app bell notification — clickable → opens request detail ──
    createNotification({
      prisma,
      io: req.app.get('io'),
      userId: offer.handymanId,
      type:   'offer_rejected',
      title:  'შეთავაზება არ იქნა მიღებული',
      body:   `"${offer.request.title}"`,
      link:   `?req=${offer.requestId}`,
    }).catch(() => {});
  } catch (err) {
    console.error('[OFFERS] reject error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── POST /api/offers/:id/disagree ─────────────────────────────
// User is inside a chat but says "ვერ შევთანხმდით" — undo acceptance.
// Mark the offer as 'disagreed' (= rejected in UI), restore request to
// pending so the user can review other offers. Chat auto-deletes in 24h.
router.post('/:id/disagree', requireAuth, async (req, res) => {
  try {
    if (req.user.type !== 'user') {
      return res.status(403).json({ error: 'მხოლოდ მომხმარებელს შეუძლია' });
    }
    const offer = await prisma.offer.findUnique({
      where: { id: req.params.id },
      include: { request: true, chat: true },
    });
    if (!offer) return res.status(404).json({ error: 'შეთავაზება ვერ მოიძებნა' });
    if (offer.request.userId !== req.user.id) return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    if (!['accepted', 'agreed'].includes(offer.status)) {
      return res.status(400).json({ error: 'მხოლოდ მიღებული/შეთანხმებული შეთავაზების გაუქმება შეიძლება' });
    }

    // 1. Mark this offer as disagreed (distinct from 'rejected' on pending)
    await prisma.offer.update({
      where: { id: offer.id },
      data:  { status: 'disagreed' },
    });

    // 2. Check whether ANY other active offers remain on the same request
    const otherActive = await prisma.offer.count({
      where: {
        requestId: offer.requestId,
        id:        { not: offer.id },
        status:    { in: ['accepted', 'agreed'] },
      },
    });

    // 3. If no other active offers, move request back to 'pending' (still receiving offers)
    if (otherActive === 0) {
      await prisma.request.update({
        where: { id: offer.requestId },
        data:  { status: 'pending' },
      });
    }

    // 4. Add a system message (user's requested text) and mark chat for deletion in ~24h
    if (offer.chat) {
      await prisma.message.create({
        data: {
          chatId:  offer.chat.id,
          fromId:  null,
          type:    'system',
          content: `"ვერ შევთანხმდით". თანამშრომლობა დასრულდა.`,
        },
      }).catch(() => {});
      // Set updatedAt to 13 days ago. Chat cleanup cron (04:00 daily) deletes 14+ day chats.
      // So this chat will be deleted within the next 24 hours.
      const thirteenDaysAgo = new Date(Date.now() - 13 * 86400000);
      await prisma.chat.update({
        where: { id: offer.chat.id },
        data:  { updatedAt: thirteenDaysAgo },
      }).catch(() => {});
    }

    res.json({ ok: true });

    // Push + bell to handyman — link back to request so they can re-bid
    sendPushToUser(prisma, offer.handymanId, {
      title: 'ვერ შევთანხმდით',
      body:  `"${offer.request.title}" — მომხმარებელმა უარი თქვა`,
      tag:   'offer-disagree-' + offer.id,
      url:   `/?req=${offer.requestId}`,
    }).catch(() => {});
    sendExpoPushToUser(prisma, offer.handymanId, {
      title: 'ვერ შევთანხმდით',
      body:  `"${offer.request.title}"`,
      data:  { type: 'offer_disagree', offerId: offer.id, requestId: offer.requestId },
    }).catch(() => {});
    createNotification({
      prisma,
      io: req.app.get('io'),
      userId: offer.handymanId,
      type:   'offer_rejected',
      title:  'ვერ შევთანხმდით',
      body:   `"${offer.request.title}"`,
      link:   `?req=${offer.requestId}`,
    }).catch(() => {});
  } catch (err) {
    console.error('[OFFERS] disagree error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── POST /api/offers/:id/agree ─────────────────────────────────
// Two-party agreement: handyman (sender) presses first, then user (recipient).
// Countdown only starts when BOTH have pressed.
router.post('/:id/agree', requireAuth, async (req, res) => {
  try {
    const offer = await prisma.offer.findUnique({
      where:   { id: req.params.id },
      include: { request: true, chat: true },
    });
    if (!offer) return res.status(404).json({ error: 'შეთავაზება ვერ მოიძებნა' });
    if (offer.status !== 'accepted') {
      return res.status(400).json({ error: 'მხოლოდ მიღებული შეთავაზებისთვის მოქმედებს' });
    }
    // Determine role: handyman is sender (made the offer), user is recipient (request owner)
    const isHandyman = offer.handymanId === req.user.id;
    const isUser     = offer.request.userId === req.user.id;
    if (!isHandyman && !isUser) return res.status(403).json({ error: 'წვდომა აკრძალულია' });

    // Already agreed by this side?
    if (isHandyman && offer.senderAgreed)    return res.status(400).json({ error: 'უკვე დაეთანხმდი' });
    if (isUser     && offer.recipientAgreed) return res.status(400).json({ error: 'უკვე დაეთანხმდი' });

    // Sender (handyman) MUST press first
    if (isUser && !offer.senderAgreed) {
      return res.status(400).json({ error: 'ჯერ ხელოსანმა უნდა დაადასტუროს' });
    }

    const updateData = isHandyman
      ? { senderAgreed: true }
      : { recipientAgreed: true };

    // If this is the second agreement, transition to "agreed" status & start countdown
    const bothAgreed = isHandyman ? offer.recipientAgreed : offer.senderAgreed;
    let completedAt = null;
    if (bothAgreed) {
      const now = new Date();
      const mins = offer.durationMinutes || (24 * 60);
      completedAt = new Date(now.getTime() + mins * 60 * 1000);
      Object.assign(updateData, {
        status:     'agreed',
        agreedAt:   now,
        completedAt,
      });
    }

    await prisma.offer.update({
      where: { id: offer.id },
      data:  updateData,
    });

    // System message in chat
    if (offer.chat) {
      const sysContent = bothAgreed
        ? `"შევთანხმდით, თანამშრომლობა დაიწყო"`
        : (isHandyman
            ? `ხელოსანმა დაადასტურა შეთანხმება — ელოდება მომხმარებელს`
            : `მომხმარებელმა დაადასტურა შეთანხმება — ელოდება ხელოსანს`);
      await prisma.message.create({
        data: { chatId: offer.chat.id, fromId: null, type: 'system', content: sysContent },
      }).catch(() => {});
    }

    res.json({ ok: true, completedAt, bothAgreed, senderAgreed: isHandyman || offer.senderAgreed, recipientAgreed: isUser || offer.recipientAgreed });

    // Notify the other party
    const otherUserId = isHandyman ? offer.request.userId : offer.handymanId;
    if (bothAgreed) {
      sendPushToUser(prisma, otherUserId, {
        title: '🤝 შევთანხმდით',
        body:  `"${offer.request.title}" — თანამშრომლობა დაიწყო`,
        tag:   'offer-agreed-' + offer.id,
        url:   `/?chat=${offer.chat?.id || ''}`,
      }).catch(() => {});
      sendExpoPushToUser(prisma, otherUserId, {
        title: '🤝 შევთანხმდით',
        body:  `"${offer.request.title}"`,
        data:  { type: 'offer_agreed', offerId: offer.id, chatId: offer.chat?.id },
      }).catch(() => {});
      createNotification({
        prisma,
        io: req.app.get('io'),
        userId: otherUserId,
        type:   'offer_accepted',
        title:  '🤝 შევთანხმდით',
        body:   `"${offer.request.title}" — თანამშრომლობა დაიწყო`,
        link:   `?chat=${offer.chat?.id || ''}`,
      }).catch(() => {});
    } else {
      // First side agreed — notify the other side that it's their turn
      sendPushToUser(prisma, otherUserId, {
        title: '👀 შევთანხმდით?',
        body:  isHandyman ? 'ხელოსანი ელოდება შენს დადასტურებას' : 'მომხმარებელი ელოდება შენს დადასტურებას',
        tag:   'offer-agree-await-' + offer.id,
        url:   `/?chat=${offer.chat?.id || ''}`,
      }).catch(() => {});
      sendExpoPushToUser(prisma, otherUserId, {
        title: '👀 შევთანხმდით?',
        body:  isHandyman ? 'ხელოსანი ელოდება დადასტურებას' : 'მომხმარებელი ელოდება დადასტურებას',
        data:  { type: 'offer_agree_await', offerId: offer.id, chatId: offer.chat?.id },
      }).catch(() => {});
      createNotification({
        prisma,
        io: req.app.get('io'),
        userId: otherUserId,
        type:   'offer_agree_await',
        title:  '👀 შევთანხმდით?',
        body:   `"${offer.request.title}" — ${isHandyman ? 'ხელოსანი' : 'მომხმარებელი'} ელოდება დადასტურებას`,
        link:   `?chat=${offer.chat?.id || ''}`,
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[OFFERS] agree error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

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
    if (offer.request.userId !== req.user.id) return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    if (offer.status !== 'pending') return res.status(400).json({ error: 'შეთავაზება უკვე დამუშავებულია' });

    // Accept offer, update request status, create chat
    // FEATURE 2.5.2: Multiple offers can be accepted on the same request
    // Each accepted offer gets its own chat. Other pending offers stay pending.
    const [updatedOffer, , chat] = await prisma.$transaction([
      prisma.offer.update({ where: { id: offer.id }, data: { status: 'accepted' } }),
      // Keep request in 'in_progress' (even if multiple offers accepted)
      prisma.request.update({ where: { id: offer.requestId }, data: { status: 'in_progress' } }),
      prisma.chat.create({
        data: {
          offerId:   offer.id,
          requestId: offer.requestId,
          userId:    req.user.id,
          handymanId: offer.handymanId,
          messages: {
            create: {
              fromId:  null,          // null for system msg
              type:    'system',
              content: `ჩათი გაიხსნა: "${offer.request.title}"`,
            },
          },
        },
        include: { messages: true },
      }),
    ]);
    res.json({ offer: updatedOffer, chatId: chat.id });

    // ── Push: notify handyman their offer was accepted ────────
    sendPushToUser(prisma, offer.handymanId, {
      title: '🎉 შეთავაზება მიღებულია!',
      body:  `"${offer.request.title}" — შეხვედი ჩათში`,
      tag:   'offer-accepted-' + offer.id,
      url:   `/?chat=${chat.id}`,
    }).catch(() => {});
    sendExpoPushToUser(prisma, offer.handymanId, {
      title: '🎉 შეთავაზება მიღებულია!',
      body:  `"${offer.request.title}"`,
      data:  { chatId: chat.id, type: 'offer_accepted' },
      channelId: 'default',
    }).catch(() => {});

    // ── In-app bell notification ──────────────────────────────
    createNotification({
      prisma,
      io: req.app.get('io'),
      userId: offer.handymanId,
      type:   'offer_accepted',
      title:  '🎉 შეთავაზება მიღებულია!',
      body:   `"${offer.request.title}"`,
      link:   `?chat=${chat.id}`,
    }).catch(() => {});
  } catch (err) {
    console.error('[OFFERS] accept error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── POST /api/offers/reviews ──────────────────────────────────
router.post('/reviews', requireAuth, async (req, res) => {
  try {
    if (req.user.type !== 'user') {
      return res.status(403).json({ error: 'მხოლოდ მომხმარებელს შეუძლია შეფასება' });
    }
    const { handymanId, stars, comment } = req.body;
    if (!handymanId || !stars) return res.status(400).json({ error: 'ხელოსანი და შეფასება სავალდებულოა' });
    const starsN = parseInt(stars);
    if (starsN < 1 || starsN > 5) return res.status(400).json({ error: 'შეფასება 1-5' });

    const hasWorked = await prisma.offer.findFirst({
      where: { handymanId, status: 'accepted', request: { userId: req.user.id } },
    });
    if (!hasWorked) return res.status(403).json({ error: 'მხოლოდ გარიგების შემდეგ შეიძლება შეფასება' });

    const already = await prisma.review.findUnique({
      where: { reviewerId_handymanId: { reviewerId: req.user.id, handymanId } },
    });
    if (already) return res.status(409).json({ error: 'შეფასება უკვე დატოვებული გაქვს' });

    const review = await prisma.review.create({
      data: { reviewerId: req.user.id, handymanId, stars: starsN, comment: comment || null },
      include: { reviewer: { select: { id: true, name: true, surname: true } } },
    });

    // Update job count
    const acceptedCount = await prisma.offer.count({ where: { handymanId, status: 'accepted' } });
    await prisma.user.update({ where: { id: handymanId }, data: { jobs: acceptedCount } });

    res.status(201).json(review);
  } catch (err) {
    console.error('[REVIEWS] create error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
