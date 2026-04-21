// utils/prisma.js
// Singleton PrismaClient — prevents "Too many connections" in dev with nodemon
// DeepSeek bug: every file created `new PrismaClient()` which causes connection leaks

const { PrismaClient } = require('@prisma/client');

const globalForPrisma = globalThis;

const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

module.exports = prisma;
