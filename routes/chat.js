// ╔══════════════════════════════════════════════════╗
// ║  ამ ფაილის სწორი მდებარეობა: routes/chat.js    ║
// ╚══════════════════════════════════════════════════╝
// FIX: chatUser/chatHandyman → user/handyman (Prisma schema field names)
const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, handleCloudinaryUpload } = require('../middleware/upload');

const router = express.Router();

// Shared select for chat participants
const PARTICIPANT_SELECT = { id: true, name: true, surname: true, emoji: true, avatar: true };

// GET /api/chat/mine — get all chats for current user
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
      },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(chats);
  } catch (err) {
    console.error('[CHAT] mine error:', err.message);
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

      res.status(201).json(msg);
    } catch (err) {
      res.status(500).json({ error: 'ატვირთვა ვერ მოხდა' });
    }
  }
);

module.exports = router;
