// middleware/auth.js
// BUG FIX (DeepSeek): used `new PrismaClient()` per-request → connection leak.
// Now uses singleton from utils/prisma.js

const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

/**
 * Require a valid JWT token.
 * Attaches req.user on success.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: no token' });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.blocked) return res.status(403).json({ error: 'Account blocked' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Require admin role.
 */
function requireAdmin(req, res, next) {
  if (req.user?.type !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Require admin or staff role.
 */
function requireStaff(req, res, next) {
  if (req.user?.type !== 'admin' && req.user?.type !== 'staff') {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
}

/**
 * Optional auth — attaches req.user if token present, doesn't fail.
 */
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (user && !user.blocked) req.user = user;
  } catch (_) {}
  next();
}

module.exports = { requireAuth, requireAdmin, requireStaff, optionalAuth };
