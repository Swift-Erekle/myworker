// utils/prisma.js
// Singleton PrismaClient — prevents "Too many connections" in dev with nodemon
// DeepSeek bug: every file created `new PrismaClient()` which causes connection leaks

const { PrismaClient } = require('@prisma/client'); // (არა /extension)

const globalForPrisma = globalThis;
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
module.exports = prisma;