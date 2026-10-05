const test = require('node:test');
const assert = require('node:assert/strict');

test('Mongo production wrapper carries one session into reads, creates and updates', async () => {
  process.env.DATABASE_PROVIDER = 'mongodb';
  const mongoose = require('mongoose');
  const original = mongoose.startSession;
  let ended = false; const calls = [];
  const session = { withTransaction: async callback => callback(), endSession: async () => { ended = true; } };
  mongoose.startSession = async () => session;
  const query = name => ({ session(actual) { assert.equal(actual, session); calls.push(name); return Promise.resolve({ name }); } });
  const source = { ProductionEntry: { find: () => query('read'), findOneAndUpdate: () => query('update'), create: async (rows, options) => { assert.equal(options.session, session); assert.ok(Array.isArray(rows)); calls.push('create'); return rows; } } };
  const { productionModels, transaction } = require('../production-storage');
  try {
    const models = productionModels(source);
    await transaction(async () => { await models.ProductionEntry.find({}); await models.ProductionEntry.findOneAndUpdate({}, {}); assert.equal((await models.ProductionEntry.create({ pieces: 10 })).pieces, 10); });
    assert.deepEqual(calls, ['read', 'update', 'create']); assert.equal(ended, true);
  } finally { mongoose.startSession = original; }
});
test('Mongo standalone transaction rejection fails explicitly and ends session', async () => {
  const mongoose = require('mongoose'), original = mongoose.startSession;
  let ended = false;
  mongoose.startSession = async () => ({ withTransaction: async () => { throw Object.assign(new Error('Transaction numbers are only allowed on a replica set member'), { code: 20 }); }, endSession: async () => { ended = true; } });
  try { await assert.rejects(require('../production-storage').transaction(async () => {}), error => error.statusCode === 503 && /No change was saved/.test(error.message)); assert.equal(ended, true); }
  finally { mongoose.startSession = original; }
});

test('Postgres production operations use the serializable transaction client and retry conflicts', async () => {
  const path = require.resolve('../postgres-models'), previousCache = require.cache[path], previousGlobal = global.__labourPrisma;
  let attempts = 0, outsideCalls = 0; const called = [];
  const fake = {
    productionDay: { findMany: () => { outsideCalls++; return []; } },
    $transaction: async (callback, options) => {
      assert.equal(options.isolationLevel, 'Serializable'); assert.equal(options.timeout, 15000); attempts++;
      if (attempts === 1) throw Object.assign(new Error('Write conflict'), { code: 'P2034' });
      const client = {
        productionDay: { findMany: async () => { called.push('day-read'); return []; }, upsert: async options => { called.push('day-upsert'); assert.ok(options.where.date_labourId); return { id: 'day', ...options.create }; } },
        productionEntry: { create: async options => { called.push('entry-create'); return { id: 'entry', ...options.data }; } },
        productionLog: { create: async options => { called.push('audit-create'); return { id: 'log', ...options.data }; } }
      };
      return callback(client);
    }
  };
  delete require.cache[path]; global.__labourPrisma = fake;
  try {
    const models = require('../postgres-models'), date = new Date('2026-10-05T00:00:00Z');
    await models.withProductionTransaction(async () => {
      await models.ProductionDay.find({});
      const day = await models.ProductionDay.findOneAndUpdate({ date, labourId: 'w' }, { breakMinutes: 30 }, { upsert: true }); assert.equal(day.breakMinutes, 30);
      await models.ProductionEntry.create({ date, labourId: 'w', toyId: 't', processId: 'p', pieces: 10, minutes: 60 });
      await models.ProductionLog.create({ action: 'entry-created', after: { pieces: 10 } });
    });
    assert.equal(attempts, 2); assert.equal(outsideCalls, 0); assert.deepEqual(called, ['day-read', 'day-upsert', 'entry-create', 'audit-create']);
  } finally { if (previousCache) require.cache[path] = previousCache; else delete require.cache[path]; global.__labourPrisma = previousGlobal; }
});

test('Mongo default roles resolve production supervisor/admin and disabled accounts', async () => {
  process.env.DATABASE_PROVIDER = 'mongodb';
  const { resolveUserAccess, DEFAULT_ROLES } = require('../access-control');
  assert.deepEqual((await resolveUserAccess({ role: 'production-supervisor' })).permissions, ['production.entry']);
  assert.deepEqual((await resolveUserAccess({ role: 'production-admin' })).permissions, ['production.masters', 'production.entry', 'production.reports']);
  assert.equal((await resolveUserAccess({ role: 'production-admin', isActive: false })).isActive, false);
  assert.deepEqual((await resolveUserAccess({ role: 'unknown' })).permissions, []);
  assert.ok(DEFAULT_ROLES.some(role => role.slug === 'production-admin'));
});

test('actual Mongo schemas validate minimal production workers, roles and persisted break minutes', () => {
  process.env.DATABASE_PROVIDER = 'mongodb';
  const { Labour, User, ProductionDay } = require('../models');
  const worker = new Labour({ name: 'Production Only', gender: 'Female', whatsapp: '', monthlySalary: 0, department: 'Production', empCode: 'P1', shiftStart: '09:30', shiftEnd: '18:30', workingHours: 8 });
  assert.equal(worker.validateSync(), undefined);
  const supervisor = new User({ name: 'Supervisor', username: 'sup', password: 'not-used', role: 'production-supervisor' });
  assert.equal(supervisor.validateSync(), undefined);
  const row = new ProductionDay({ date: new Date('2026-10-05T00:00:00Z'), labourId: worker._id, breakMinutes: 30 });
  assert.equal(row.validateSync(), undefined); assert.equal(row.toObject().breakMinutes, 30);
});
