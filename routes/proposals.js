// routes/proposals.js
// Proposals: regular users send direct offers to handymen/companies (reverse of Offer flow)
const express = require('express');
const prisma   = require('../utils/prisma');   // ✅ FIX: singleton — no connection leaks
const { requireAuth } = require('../middleware/auth');
const { sendPushToUser } = require('../utils/webPush');
const { sendExpoPushToUser } = require('../utils/expoPush');
const { createNotification } = require('./notifications');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/proposals — create a proposal (user → handyman/company)
// ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    // Only regular users can create proposals
    if (req.user.type !== 'user') {
      return res.status(403).json({ error: 'მხოლოდ მომხმარებელს შეუძლია შეთავაზების გაგზავნა' });
    }
    const {
      recipientId, title, category, description,
      city, budget, duration, durationMinutes,
    } = req.body;
    if (!recipientId || !title || !category) {
      return res.status(400).json({ error: 'სათაური და კატეგორია სავალდებულოა' });
    }
    // Recipient must be a handyman or company
    const recipient = await prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, type: true, emoji: true, name: true, blocked: true },
    });
    if (!recipient) return res.status(404).json({ error: 'ადრესატი ვერ მოიძებნა' });
    if (recipient.type !== 'handyman' && recipient.type !== 'company') {
      return res.status(400).json({ error: 'შეთავაზება შეიძლება გაეგზავნოს მხოლოდ ხელოსანს ან კომპანიას' });
    }
    if (recipient.blocked) return res.status(403).json({ error: 'ეს მომხმარებელი დაბლოკილია' });
    if (recipient.id === req.user.id) return res.status(400).json({ error: 'საკუთარ თავს ვერ გაუგზავნი' });

    const proposal = await prisma.proposal.create({
      data: {
        senderId:    req.user.id,
        recipientId: recipient.id,
        title:       String(title).substring(0, 200),
        category:    String(category).substring(0, 100),
        description: description ? String(description).substring(0, 2000) : null,
        city:        city ? String(city).substring(0, 100) : null,
        budget:      budget ? parseInt(budget) : null,
        duration:    duration || null,
        durationMinutes: durationMinutes ? parseInt(durationMinutes) : null,
      },
      include: {
        sender:    { select: { id: true, name: true, surname: true, emoji: true, color: true, avatar: true } },
        recipient: { select: { id: true, name: true, surname: true, emoji: true } },
      },
    });

    // ✅ Auto-create chat between sender (user) and recipient (handyman/company)
    // so they can immediately discuss the proposal.
    let chat = null;
    try {
      chat = await prisma.chat.create({
        data: {
          proposalId: proposal.id,
          userId:     proposal.senderId,    // proposal sender = user
          handymanId: proposal.recipientId, // proposal recipient = handyman/company
        },
      });
      // Initial system message
      await prisma.message.create({
        data: {
          chatId:  chat.id,
          fromId:  null,
          type:    'system',
          content: `💬 შემოთავაზება გაიგზავნა: "${proposal.title.substring(0, 80)}"`,
        },
      });
    } catch (e) {
      console.error('[PROPOSALS] chat create failed:', e.message);
    }
    proposal.chat = chat;

    // In-app notification for recipient
    try {
      await prisma.notification.create({
        data: {
          userId:  recipient.id,
          type:    'new_proposal',
          title:   `💬 ახალი შემოთავაზება`,
          body:    `${req.user.name || 'მომხმარებელი'} — ${proposal.title.substring(0, 60)}`,
          link:    `?proposal=${proposal.id}`,
        },
      });
    } catch (_) {}

    // Push notification (web + mobile)
    const pushData = { type: 'new_proposal', proposalId: proposal.id };
    sendPushToUser(prisma, recipient.id, {
      title: `💬 ახალი შემოთავაზება`,
      body:  `${req.user.name || 'მომხმარებელი'} — ${proposal.title.substring(0, 60)}`,
      data:  pushData,
    }).catch(() => {});
    sendExpoPushToUser(prisma, recipient.id, {
      title: `💬 ახალი შემოთავაზება`,
      body:  `${req.user.name || 'მომხმარებელი'} — ${proposal.title.substring(0, 60)}`,
      data:  pushData,
    }).catch(() => {});

    res.status(201).json(proposal);
  } catch (err) {
    console.error('[PROPOSALS] POST error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/proposals/sent — proposals I sent (user)
// ─────────────────────────────────────────────────────────────
router.get('/sent', requireAuth, async (req, res) => {
  try {
    const proposals = await prisma.proposal.findMany({
      where: { senderId: req.user.id },
      include: {
        recipient: { select: { id: true, name: true, surname: true, emoji: true, color: true, avatar: true, type: true, specialty: true } },
        chat:      { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/proposals/received — proposals received (handyman/company)
// ─────────────────────────────────────────────────────────────
router.get('/received', requireAuth, async (req, res) => {
  try {
    if (req.user.type !== 'handyman' && req.user.type !== 'company') {
      return res.status(403).json({ error: 'მხოლოდ ხელოსანი/კომპანია' });
    }
    const proposals = await prisma.proposal.findMany({
      where: { recipientId: req.user.id },
      include: {
        sender: { select: { id: true, name: true, surname: true, emoji: true, color: true, avatar: true } },
        chat:   { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/proposals/:id — view single proposal (sender or recipient only)
// ─────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const p = await prisma.proposal.findUnique({
      where: { id: req.params.id },
      include: {
        sender:    { select: { id: true, name: true, surname: true, emoji: true, color: true, avatar: true } },
        recipient: { select: { id: true, name: true, surname: true, emoji: true, color: true, avatar: true, type: true, specialty: true } },
        chat:      { select: { id: true } },
      },
    });
    if (!p) return res.status(404).json({ error: 'ვერ მოიძებნა' });
    if (p.senderId !== req.user.id && p.recipientId !== req.user.id) {
      return res.status(403).json({ error: 'წვდომა აკრძალული' });
    }
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/proposals/:id/accept — recipient accepts
// ─────────────────────────────────────────────────────────────
router.post('/:id/accept', requireAuth, async (req, res) => {
  try {
    const p = await prisma.proposal.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'ვერ მოიძებნა' });
    if (p.recipientId !== req.user.id) return res.status(403).json({ error: 'წვდომა აკრძალული' });
    if (p.status !== 'pending') return res.status(400).json({ error: 'სტატუსი აღარ არის pending' });

    // ✅ FIX 3: idempotent — if already accepted, return success silently
    if (p.status === 'accepted') {
      return res.json(p);
    }

    const updated = await prisma.proposal.update({
      where: { id: p.id },
      data:  { status: 'accepted' },
    });

    // Notify sender
    try {
      await prisma.notification.create({
        data: {
          userId: p.senderId,
          type:   'proposal_accepted',
          title:  '✅ შეთავაზება მიღებულია',
          body:   `${req.user.name || 'ხელოსანი'} — ${p.title.substring(0, 60)}`,
          link:   `?proposal=${p.id}`,
        },
      });
    } catch (_) {}
    sendPushToUser(prisma, p.senderId, {
      title: '✅ შეთავაზება მიღებულია',
      body:  `${req.user.name || 'ხელოსანი'} დაეთანხმა შენს შეთავაზებას`,
      data:  { type: 'proposal_accepted', proposalId: p.id },
    }).catch(() => {});
    sendExpoPushToUser(prisma, p.senderId, {
      title: '✅ შეთავაზება მიღებულია',
      body:  `${req.user.name || 'ხელოსანი'} დაეთანხმა შენს შეთავაზებას`,
      data:  { type: 'proposal_accepted', proposalId: p.id },
    }).catch(() => {});

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/proposals/:id/reject — recipient rejects
// ─────────────────────────────────────────────────────────────
router.post('/:id/reject', requireAuth, async (req, res) => {
  try {
    const p = await prisma.proposal.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'ვერ მოიძებნა' });
    if (p.recipientId !== req.user.id) return res.status(403).json({ error: 'წვდომა აკრძალული' });
    if (p.status !== 'pending') return res.status(400).json({ error: 'სტატუსი აღარ არის pending' });

    const updated = await prisma.proposal.update({
      where: { id: p.id },
      data:  { status: 'rejected' },
    });

    try {
      await prisma.notification.create({
        data: {
          userId: p.senderId,
          type:   'proposal_rejected',
          title:  '❌ შეთავაზება უარყოფილია',
          body:   `${req.user.name || 'ხელოსანი'} — ${p.title.substring(0, 60)}`,
          link:   `?proposal=${p.id}`,
        },
      });
    } catch (_) {}

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/proposals/:id/agree — two-party agreement in chat
// For proposals (user→handyman): recipient (handyman) initiates,
// sender (user) confirms. Countdown starts when BOTH have agreed.
// ─────────────────────────────────────────────────────────────
router.post('/:id/agree', requireAuth, async (req, res) => {
  try {
    const p = await prisma.proposal.findUnique({
      where:   { id: req.params.id },
      include: { chat: true },
    });
    if (!p) return res.status(404).json({ error: 'ვერ მოიძებნა' });
    if (!['accepted'].includes(p.status)) {
      return res.status(400).json({ error: 'მხოლოდ მიღებული შეთავაზებისთვის მოქმედებს' });
    }

    // In proposals: handyman = recipient who accepted = "sender of agreement" (presses first)
    //               user     = original sender of proposal = "recipient of agreement" (confirms)
    const isHandyman = p.recipientId === req.user.id;  // handyman (accepted proposal)
    const isUser     = p.senderId    === req.user.id;  // user (original proposer)
    if (!isHandyman && !isUser) return res.status(403).json({ error: 'წვდომა აკრძალული' });

    if (isHandyman && p.senderAgreed)    return res.status(400).json({ error: 'უკვე დაეთანხმდი' });
    if (isUser     && p.recipientAgreed) return res.status(400).json({ error: 'უკვე დაეთანხმდი' });

    // Handyman must go first for proposals
    if (isUser && !p.senderAgreed) {
      return res.status(400).json({ error: 'ჯერ ხელოსანმა უნდა დაადასტუროს' });
    }

    const updateData = isHandyman ? { senderAgreed: true } : { recipientAgreed: true };
    const bothAgreed = isHandyman ? p.recipientAgreed : p.senderAgreed;
    let completedAt = null;

    if (bothAgreed) {
      const now = new Date();
      const mins = p.durationMinutes || (24 * 60);
      completedAt = new Date(now.getTime() + mins * 60 * 1000);
      Object.assign(updateData, { status: 'agreed', agreedAt: now, completedAt });
    }

    await prisma.proposal.update({ where: { id: p.id }, data: updateData });

    if (p.chat) {
      const sysContent = bothAgreed
        ? '"შევთანხმდით, თანამშრომლობა დაიწყო"'
        : isHandyman
          ? 'ხელოსანი ეთანხმება — ელოდება მომხმარებლის დადასტურებას'
          : 'მომხმარებელი ეთანხმება — ელოდება ხელოსნის დადასტურებას';
      await prisma.message.create({
        data: { chatId: p.chat.id, fromId: null, type: 'system', content: sysContent },
      }).catch(() => {});
    }

    const io = req.app.get('io');
    const otherUserId = isHandyman ? p.senderId : p.recipientId;

    if (bothAgreed) {
      createNotification({ prisma, io, userId: otherUserId, type: 'offer_accepted',
        title: '🤝 შევთანხმდით', body: `"${p.title}" — თანამშრომლობა დაიწყო`,
        link: `?chat=${p.chat?.id || ''}` }).catch(() => {});
    } else {
      createNotification({ prisma, io, userId: otherUserId, type: 'offer_agree_await',
        title: '👀 შევთანხმდით?',
        body: isHandyman ? 'ხელოსანი ელოდება შენს დადასტურებას' : 'მომხმარებელი ელოდება შენს დადასტურებას',
        link: `?chat=${p.chat?.id || ''}` }).catch(() => {});
      sendPushToUser(prisma, otherUserId, {
        title: '👀 შევთანხმდით?',
        body: isHandyman ? 'ხელოსანი ელოდება დადასტურებას' : 'მომხმარებელი ელოდება დადასტურებას',
        tag: 'proposal-agree-' + p.id, url: `/?chat=${p.chat?.id || ''}`,
      }).catch(() => {});
    }

    res.json({ ok: true, completedAt, bothAgreed,
      senderAgreed: isHandyman || p.senderAgreed,
      recipientAgreed: isUser || p.recipientAgreed });
  } catch (err) {
    console.error('[PROPOSALS] agree error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/proposals/:id/disagree — cancel agreement in chat
// ─────────────────────────────────────────────────────────────
router.post('/:id/disagree', requireAuth, async (req, res) => {
  try {
    const p = await prisma.proposal.findUnique({
      where:   { id: req.params.id },
      include: { chat: true },
    });
    if (!p) return res.status(404).json({ error: 'ვერ მოიძებნა' });
    if (p.senderId !== req.user.id && p.recipientId !== req.user.id) {
      return res.status(403).json({ error: 'წვდომა აკრძალული' });
    }
    if (!['accepted', 'agreed'].includes(p.status)) {
      return res.status(400).json({ error: 'მხოლოდ მიღებული/შეთანხმებული შეთავაზება შეიძლება გაუქმდეს' });
    }

    await prisma.proposal.update({ where: { id: p.id }, data: { status: 'accepted', senderAgreed: false, recipientAgreed: false } });

    if (p.chat) {
      await prisma.message.create({
        data: { chatId: p.chat.id, fromId: null, type: 'system', content: '"ვერ შევთანხმდით". თანამშრომლობა შეჩერდა.' },
      }).catch(() => {});
      const thirteenDaysAgo = new Date(Date.now() - 13 * 86400000);
      await prisma.chat.update({ where: { id: p.chat.id }, data: { updatedAt: thirteenDaysAgo } }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[PROPOSALS] disagree error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/proposals/:id — sender cancels (only if pending)
// ─────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const p = await prisma.proposal.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'ვერ მოიძებნა' });
    if (p.senderId !== req.user.id) return res.status(403).json({ error: 'წვდომა აკრძალული' });
    if (p.status !== 'pending') return res.status(400).json({ error: 'მიღებული/უარყოფილი ვერ წაიშლება' });
    await prisma.proposal.delete({ where: { id: p.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
