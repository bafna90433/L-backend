require('dotenv').config();
const mongoose = require('mongoose');
const { PrismaClient } = require('@prisma/client');
const MongoModels = require('../mongo-models');
const { mapMongoData, validateRequiredValues, validateReferences, compareDatasets } = require('./migration-data');

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

const targetModels = {
  users: prisma.user,
  labours: prisma.labour,
  attendances: prisma.attendance,
  cashTransactions: prisma.cashTx,
  advanceRequests: prisma.advanceRequest,
  reminders: prisma.reminder,
  tasks: prisma.task,
  messages: prisma.message,
  departments: prisma.department,
  systemSettings: prisma.systemSetting
};

async function verify() {
  if (!process.env.MONGO_URI || !process.env.DATABASE_URL) throw new Error('MONGO_URI and DATABASE_URL are required');
  await mongoose.connect(process.env.MONGO_URI);
  await prisma.$connect();

  const source = {};
  for (const [name, model] of Object.entries(sourceModels)) source[name] = await model.find({}).lean();
  const expected = mapMongoData(source);
  validateRequiredValues(expected);
  validateReferences(expected);

  const rows = [];
  let valid = true;
  for (const [name, postgresModel] of Object.entries(targetModels)) {
    const actual = await postgresModel.findMany();
    const comparison = compareDatasets(expected[name], actual);
    if (!comparison.matches) valid = false;
    rows.push({
      dataset: name,
      mongoCount: expected[name].length,
      postgresCount: actual.length,
      exactMatch: comparison.matches,
      missing: comparison.missingIds.length,
      extra: comparison.extraIds.length,
      changed: comparison.changedIds.length
    });
    if (!comparison.matches) {
      console.error(`${name} mismatch`, {
        missingIds: comparison.missingIds.slice(0, 10),
        extraIds: comparison.extraIds.slice(0, 10),
        changedIds: comparison.changedIds.slice(0, 10)
      });
    }
  }
  console.table(rows);
  if (!valid) throw new Error('PostgreSQL content does not exactly match MongoDB. Cutover is blocked.');
  console.log('All record counts, IDs and field values match exactly. MongoDB remains untouched.');
}

verify()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await Promise.allSettled([mongoose.disconnect(), prisma.$disconnect()]); });
