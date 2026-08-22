const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/labour';
const { __testing } = require('../postgres-models');

test('translates Mongo query operators to Prisma filters', () => {
  const result = __testing.translateWhere({
    _id: 'abc',
    role: { $in: ['staff', 'staff2'] },
    date: { $gte: new Date('2026-01-01'), $lte: new Date('2026-01-31') },
    $or: [{ sender: 'u1' }, { receiver: 'u1' }]
  });
  assert.equal(result.id, 'abc');
  assert.deepEqual(result.role, { in: ['staff', 'staff2'] });
  assert.equal(result.OR[0].sender, 'u1');
  assert.equal(result.OR[1].receiver, 'u1');
});

test('keeps only model fields and extracts populated relation ids', () => {
  const data = __testing.cleanData(__testing.specs.Attendance, {
    labourId: { _id: 'labour-1', name: 'Employee' }, status: 'present', date: new Date('2026-01-01'), unknown: 'ignored'
  });
  assert.equal(data.labourId, 'labour-1');
  assert.equal(data.status, 'present');
  assert.equal(data.unknown, undefined);
});

test('uses atomic unique keys for attendance and settings upserts', () => {
  const date = new Date('2026-01-01T00:00:00.000Z');
  assert.deepEqual(__testing.uniqueWhereForUpsert('Attendance', { labourId: 'l1', date }), {
    labourId_date: { labourId: 'l1', date }
  });
  assert.deepEqual(__testing.uniqueWhereForUpsert('SystemSettings', { key: 'kiosk_hours' }), { key: 'kiosk_hours' });
});
