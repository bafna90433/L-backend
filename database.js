const mongoose = require('mongoose');

async function connectDatabase() {
  const provider = (process.env.DATABASE_PROVIDER || 'mongodb').toLowerCase();

  if (provider === 'postgresql') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when DATABASE_PROVIDER=postgresql');
    const { prisma } = require('./postgres-models');
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
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
