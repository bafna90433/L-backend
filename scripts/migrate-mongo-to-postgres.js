require('dotenv').config();
const mongoose = require('mongoose');
const { PrismaClient } = require('@prisma/client');
const MongoModels = require('../mongo-models');
const { mapMongoData, validateReferences, validateRequiredValues } = require('./migration-data');

const prisma = new PrismaClient();

const sourceModels = {
  users: MongoModels.User,
  labours: MongoModels.Labour,
  attendances: MongoModels.Attendance,
  cashTransactions: MongoModels.CashTx,
  advanceRequests: MongoModels.AdvanceRequest,
  reminders: MongoModels.Reminder,
  tasks: MongoModels.Task,
  messages: MongoModels.Message,
  departments: MongoModels.Department,
  systemSettings: MongoModels.SystemSettings
};

async function readMongo() {
  const result = {};
  for (const [name, model] of Object.entries(sourceModels)) result[name] = await model.find({}).lean();
  return result;
}

async function migrate() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  console.log('Reading MongoDB in read-only mode...');
  await mongoose.connect(process.env.MONGO_URI);
  await prisma.$connect();
  const source = await readMongo();
  const data = mapMongoData(source);
  validateRequiredValues(data);
  validateReferences(data);

  console.table(Object.fromEntries(Object.entries(data).map(([key, rows]) => [key, rows.length])));
  console.log('Reference validation passed. Starting one atomic insert-only PostgreSQL transaction...');

  await prisma.$transaction([
    prisma.user.createMany({ data: data.users, skipDuplicates: true }),
    prisma.labour.createMany({ data: data.labours, skipDuplicates: true }),
    prisma.department.createMany({ data: data.departments, skipDuplicates: true }),
    prisma.systemSetting.createMany({ data: data.systemSettings, skipDuplicates: true }),
    prisma.attendance.createMany({ data: data.attendances, skipDuplicates: true }),
    prisma.cashTx.createMany({ data: data.cashTransactions, skipDuplicates: true }),
    prisma.advanceRequest.createMany({ data: data.advanceRequests, skipDuplicates: true }),
    prisma.reminder.createMany({ data: data.reminders, skipDuplicates: true }),
    prisma.task.createMany({ data: data.tasks, skipDuplicates: true }),
    prisma.message.createMany({ data: data.messages, skipDuplicates: true })
  ], { timeout: 120000 });

  console.log('Insert-only migration completed. MongoDB was not modified.');
}

migrate()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await Promise.allSettled([mongoose.disconnect(), prisma.$disconnect()]); });
