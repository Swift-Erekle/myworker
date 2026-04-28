// ╔══════════════════════════════════════════════════╗
// ║  ამ ფაილის სწორი მდებარეობა: routes/chat.js    ║
// ╚══════════════════════════════════════════════════╝
// FIX: chatUser/chatHandyman → user/handyman (Prisma schema field names)
const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, handleCloudinaryUpload } = require('../middleware/upload');
const { sendPushToUser } = require('../utils/webPush');
const { sendExpoPushToUser } = require('../utils/expoPush');
const { createNotification } = require('./notifications');

const router = express.Router();

// Shared select for chat participants
const PARTICIPANT_SELECT = { id: true, name: true, surname: true, emoji: true, avatar: true };

// GET /api/chat/mine — get all chats for current user (with unreadCount)
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const isUser = req.user.type === 'user';
    const where = isUser ? { userId: req.user.id } : { handymanId: req.user.id };

    const chats = await prisma.chat.findMany({
      where,
      include: {
        user:     { select: PARTICIPANT_SELECT },
        handyman: { select: PARTICIPANT_SELECT },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        offer: {
          include: {
            request: { select: { id: true, title: true } },
          },
        },
        proposal: {
          select: {
            id: true, title: true, category: true, status: true,
            senderAgreed: true, recipientAgreed: true,
            agreedAt: true, completedAt: true, durationMinutes: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // ✅ NEW: compute unreadCount per chat
    // unread = messages newer than (lastReadAt) AND not from current user AND not system (fromId !== null)
    const chatsWithUnread = await Promise.all(
      chats.map(async (chat) => {
        const lastRead = isUser ? chat.userLastReadAt : chat.handymanLastReadAt;
        const unreadCount = await prisma.message.count({
          where: {
            chatId: chat.id,
            fromId: { not: null, notIn: [req.user.id] },
            ...(lastRead ? { createdAt: { gt: lastRead } } : {}),
          },
        });
        return { ...chat, unreadCount };
      })
    );

    res.json(chatsWithUnread);
  } catch (err) {
    console.error('[CHAT] mine error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ✅ NEW: POST /api/chat/:id/read — mark chat as read (resets unreadCount)
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const chat = await prisma.chat.findUnique({ where: { id: req.params.id } });
    if (!chat) return res.status(404).json({ error: 'ჩათი ვერ მოიძებნა' });
    if (chat.userId !== req.user.id && chat.handymanId !== req.user.id) {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }
    const isUser = chat.userId === req.user.id;
    await prisma.chat.update({
      where: { id: req.params.id },
      data:  isUser ? { userLastReadAt: new Date() } : { handymanLastReadAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[CHAT] mark-read error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/chat/:id — get single chat with messages
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: req.params.id },
      include: {
        user:     { select: PARTICIPANT_SELECT },
        handyman: { select: PARTICIPANT_SELECT },
        offer: {
          include: { request: { select: { id: true, title: true } } },
        },
        proposal: {
          select: {
            id: true, title: true, category: true, status: true,
            senderAgreed: true, recipientAgreed: true,
            agreedAt: true, completedAt: true, durationMinutes: true,
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 200,
        },
      },
    });
    if (!chat) return res.status(404).json({ error: 'ჩათი ვერ მოიძებნა' });
    if (chat.userId !== req.user.id && chat.handymanId !== req.user.id) {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }
    // ✅ NEW: auto-mark as read on open
    const isUser = chat.userId === req.user.id;
    prisma.chat.update({
      where: { id: req.params.id },
      data:  isUser ? { userLastReadAt: new Date() } : { handymanLastReadAt: new Date() },
    }).catch(() => {});
    res.json(chat);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/chat/:id/messages — paginated messages
router.get('/:id/messages', requireAuth, async (req, res) => {
  try {
    const chat = await prisma.chat.findUnique({ where: { id: req.params.id } });
    if (!chat) return res.status(404).json({ error: 'ჩათი ვერ მოიძებნა' });
    if (chat.userId !== req.user.id && chat.handymanId !== req.user.id) {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }

    const cursor = req.query.before;
    const take = parseInt(req.query.take) || 50;

    const messages = await prisma.message.findMany({
      where: {
        chatId: req.params.id,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/chat/:id/messages — send text message (REST fallback if socket unavailable)
router.post('/:id/messages', requireAuth, async (req, res) => {
  try {
    const chat = await prisma.chat.findUnique({ where: { id: req.params.id } });
    if (!chat) return res.status(404).json({ error: 'ჩათი ვერ მოიძებნა' });
    if (chat.userId !== req.user.id && chat.handymanId !== req.user.id) {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }
    if (chat.blocked) return res.status(403).json({ error: 'ჩათი დაიბლოკილია' });

    const { content, type = 'text' } = req.body;
    if (!content) return res.status(400).json({ error: 'შეტყობინება ცარიელია' });

    const msg = await prisma.message.create({
      data: {
        chatId: req.params.id,
        fromId: req.user.id,
        type,
        content: String(content).substring(0, 4000),
      },
    });
    await prisma.chat.update({
      where: { id: req.params.id },
      data: { updatedAt: new Date() },
    });

    const io = req.app.get('io');
    if (io) io.to(`chat:${req.params.id}`).emit('newMessage', msg);

    // ── DS#5: also send push to recipient (REST fallback) ────────
    const recipientId = chat.userId === req.user.id ? chat.handymanId : chat.userId;
    const senderName  = `${req.user.name || ''} ${req.user.surname || ''}`.trim();
    const preview     = type === 'text' ? String(content).substring(0, 80)
                      : type === 'image' ? '📷 ფოტო'
                      : type === 'video' ? '📹 ვიდეო'
                      : type === 'voice' ? '🎤 ხმოვანი' : 'ფაილი';
    sendPushToUser(prisma, recipientId, {
      title: '💬 ' + (senderName || 'ახალი შეტყობინება'),
      body:  preview,
      tag:   'chat-' + req.params.id,
      url:   '/?chat=' + req.params.id,
    }).catch(() => {});
    sendExpoPushToUser(prisma, recipientId, {
      title: '💬 ' + (senderName || 'ახალი შეტყობინება'),
      body:  preview,
      data:  { chatId: req.params.id, type: 'new_message' },
      channelId: 'default',
    }).catch(() => {});
    createNotification({
      prisma, io, userId: recipientId,
      type:  'new_message',
      title: '💬 ახალი შეტყობინება',
      body:  `${senderName}: ${preview}`,
      link:  `?chat=${req.params.id}`,
    }).catch(() => {});

    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/chat/:id/upload — upload file to chat
router.post(
  '/:id/upload',
  requireAuth,
  upload.single('file'),
  handleCloudinaryUpload,
  async (req, res) => {
    try {
      const chat = await prisma.chat.findUnique({ where: { id: req.params.id } });
      if (!chat) return res.status(404).json({ error: 'ჩათი ვერ მოიძებნა' });
      if (chat.userId !== req.user.id && chat.handymanId !== req.user.id) {
        return res.status(403).json({ error: 'წვდომა აკრძალულია' });
      }

      const file = req.uploadedFiles?.[0];
      if (!file) return res.status(400).json({ error: 'ფაილი ვერ მოიძებნა' });

      const msg = await prisma.message.create({
        data: {
          chatId: req.params.id,
          fromId: req.user.id,
          type: file.type,
          content: file.url,
        },
      });
      await prisma.chat.update({
        where: { id: req.params.id },
        data: { updatedAt: new Date() },
      });

      const io = req.app.get('io');
      if (io) io.to(`chat:${req.params.id}`).emit('newMessage', msg);

      // ── DS#5: push for file uploads too ──────────────
      const recipientId = chat.userId === req.user.id ? chat.handymanId : chat.userId;
      const senderName  = `${req.user.name || ''} ${req.user.surname || ''}`.trim();
      const preview     = file.type === 'image' ? '📷 ფოტო'
                        : file.type === 'video' ? '📹 ვიდეო'
                        : file.type === 'voice' ? '🎤 ხმოვანი' : 'ფაილი';
      sendPushToUser(prisma, recipientId, {
        title: '💬 ' + (senderName || 'ახალი შეტყობინება'),
        body:  preview,
        tag:   'chat-' + req.params.id,
        url:   '/?chat=' + req.params.id,
      }).catch(() => {});
      sendExpoPushToUser(prisma, recipientId, {
        title: '💬 ' + (senderName || 'ახალი შეტყობინება'),
        body:  preview,
        data:  { chatId: req.params.id, type: 'new_message' },
        channelId: 'default',
      }).catch(() => {});
      createNotification({
        prisma, io, userId: recipientId,
        type:  'new_message',
        title: '💬 ახალი შეტყობინება',
        body:  `${senderName}: ${preview}`,
        link:  `?chat=${req.params.id}`,
      }).catch(() => {});

      res.status(201).json(msg);
    } catch (err) {
      res.status(500).json({ error: 'ატვირთვა ვერ მოხდა' });
    }
  }
);

module.exports = router;
