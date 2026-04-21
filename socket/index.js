// socket/index.js
// BUG FIX (DeepSeek): messages stored as JSON blob in Chat model.
// Now uses separate Message model for proper pagination & real-time.

const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

function setupSocket(io) {
  // Authenticate socket connection via JWT
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    // Join personal room for notifications
    socket.join(`user:${userId}`);
    console.log(`[SOCKET] Connected: ${userId}`);

    // ── Join a chat room ───────────────────────────────────────
    socket.on('joinChat', async (chatId) => {
      // Verify user belongs to this chat
      const chat = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chat) return socket.emit('error', { message: 'Chat not found' });
      if (chat.userId !== userId && chat.handymanId !== userId) {
        return socket.emit('error', { message: 'Access denied' });
      }
      socket.join(`chat:${chatId}`);
      socket.emit('joinedChat', { chatId });
    });

    // ── Leave chat room ────────────────────────────────────────
    socket.on('leaveChat', (chatId) => {
      socket.leave(`chat:${chatId}`);
    });

    // ── Send a text message ────────────────────────────────────
    socket.on('sendMessage', async (data) => {
      const { chatId, content, type = 'text' } = data;
      if (!chatId || !content) return;

      try {
        // Verify chat membership
        const chat = await prisma.chat.findUnique({ where: { id: chatId } });
        if (!chat) return socket.emit('error', { message: 'Chat not found' });
        if (chat.userId !== userId && chat.handymanId !== userId) {
          return socket.emit('error', { message: 'Access denied' });
        }

        // Persist message
        const msg = await prisma.message.create({
          data: {
            chatId,
            fromId: userId,
            type,
            content: String(content).substring(0, 4000), // limit length
          },
          select: {
            id: true, chatId: true, fromId: true,
            type: true, content: true, createdAt: true,
          },
        });

        // Broadcast to everyone in chat room (including sender)
        io.to(`chat:${chatId}`).emit('newMessage', msg);

        // Update chat updatedAt
        await prisma.chat.update({
          where: { id: chatId },
          data: { updatedAt: new Date() },
        });
      } catch (err) {
        console.error('[SOCKET] sendMessage error:', err.message);
        socket.emit('error', { message: 'Could not send message' });
      }
    });

    // ── Typing indicator ───────────────────────────────────────
    socket.on('typing', ({ chatId, isTyping }) => {
      socket.to(`chat:${chatId}`).emit('userTyping', { userId, isTyping });
    });

    // ── Join support room (staff/admin) ────────────────────────
    socket.on('joinSupport', async (supportId) => {
      const sr = await prisma.supportRequest.findUnique({ where: { id: supportId } });
      if (!sr) return;
      // Only allow: the support requester, or staff/admin
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (sr.userId !== userId && user?.type !== 'staff' && user?.type !== 'admin') {
        return socket.emit('error', { message: 'Access denied' });
      }
      socket.join(`support:${supportId}`);
    });

    // ── Support message (from user) ────────────────────────────
    socket.on('sendSupportMsg', async ({ supportId, content }) => {
      if (!supportId || !content) return;
      try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const fromRole = (user?.type === 'staff' || user?.type === 'admin') ? 'operator' : 'user';
        const msg = await prisma.supportMessage.create({
          data: { supportRequestId: supportId, fromRole, content: String(content).substring(0, 2000) },
        });
        await prisma.supportRequest.update({
          where: { id: supportId },
          data: { lastMsg: String(content).substring(0, 100), updatedAt: new Date() },
        });
        io.to(`support:${supportId}`).emit('newSupportMsg', msg);
        // Notify all staff/admin
        if (fromRole === 'user') {
          io.emit('supportAlert', { supportId, preview: content.substring(0, 60) });
        }
      } catch (err) {
        console.error('[SOCKET] sendSupportMsg error:', err.message);
      }
    });

    socket.on('disconnect', () => {
      console.log(`[SOCKET] Disconnected: ${userId}`);
    });
  });
}

module.exports = { setupSocket };
