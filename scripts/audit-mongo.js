require('dotenv').config();
const mongoose = require('mongoose');
const MongoModels = require('../mongo-models');
const { mapMongoData, validateReferences, validateRequiredValues } = require('./migration-data');

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

async function audit() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const source = {};
  for (const [name, model] of Object.entries(sourceModels)) source[name] = await model.find({}).lean();
  const data = mapMongoData(source);
  validateRequiredValues(data);
  validateReferences(data);
  console.table(Object.entries(data).map(([dataset, rows]) => ({ dataset, records: rows.length })));
  console.log('MongoDB read-only audit passed. No records were modified.');
}

audit()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
