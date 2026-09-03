const mongoose = require('mongoose');

async function connectDatabase() {
  const provider = (process.env.DATABASE_PROVIDER || 'mongodb').toLowerCase();

  if (provider === 'postgresql') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when DATABASE_PROVIDER=postgresql');
    const { prisma } = require('./postgres-models');
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;

    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "DeletedLog" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "originalId" TEXT NOT NULL DEFAULT '',
          "itemType" TEXT NOT NULL DEFAULT 'Cash Transaction',
          "category" TEXT NOT NULL DEFAULT '',
          "txType" TEXT NOT NULL DEFAULT 'expense',
          "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
          "paymentMode" TEXT NOT NULL DEFAULT 'handcash',
          "date" TIMESTAMP(3),
          "description" TEXT NOT NULL DEFAULT '',
          "taggedPerson" TEXT NOT NULL DEFAULT '',
          "loggedByStaff" TEXT NOT NULL DEFAULT '',
          "deletedBy" TEXT NOT NULL,
          "deletedByName" TEXT NOT NULL DEFAULT '',
          "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } catch (tblErr) {
      console.warn('Auto table check warning (non-fatal):', tblErr.message);
    }

    const { ensureDefaultRoles } = require('./access-control');
    await ensureDefaultRoles();
    return { provider: 'postgresql' };
  }

  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required when DATABASE_PROVIDER=mongodb');
  await mongoose.connect(process.env.MONGO_URI);
  return { provider: 'mongodb' };
}

async function disconnectDatabase() {
  const provider = (process.env.DATABASE_PROVIDER || 'mongodb').toLowerCase();
  if (provider === 'postgresql') {
    const { prisma } = require('./postgres-models');
    await prisma.$disconnect();
  } else {
    await mongoose.disconnect();
  }
}

module.exports = { connectDatabase, disconnectDatabase };
