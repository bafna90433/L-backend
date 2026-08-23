const test = require('node:test');
const assert = require('node:assert/strict');
const { mapMongoData, validateReferences, validateRequiredValues, compareDatasets } = require('../scripts/migration-data');

const oid = value => ({ toString: () => value, _bsontype: 'ObjectId' });
const emptySource = () => ({
  users: [], labours: [], attendances: [], cashTransactions: [], advanceRequests: [],
  reminders: [], tasks: [], messages: [], departments: [], systemSettings: []
});

test('maps MongoDB identifiers and preserves required values', () => {
  const data = mapMongoData({
    users: [{ _id: oid('u1'), username: 'owner', password: 'hash', name: 'Owner', role: 'owner' }],
    labours: [{ _id: oid('l1'), name: 'Employee', whatsapp: '1', monthlySalary: 12000 }],
    attendances: [{ _id: oid('a1'), labourId: oid('l1'), date: new Date('2026-01-01'), status: 'present' }],
    cashTransactions: [], advanceRequests: [], reminders: [], tasks: [], messages: [], departments: [], systemSettings: []
  });
  assert.equal(data.users[0].id, 'u1');
  assert.equal(data.labours[0].id, 'l1');
  assert.equal(data.attendances[0].labourId, 'l1');
  assert.doesNotThrow(() => validateReferences(data));
});

test('blocks writes when a MongoDB relation points to a missing record', () => {
  const data = {
    users: [], labours: [], cashTransactions: [], advanceRequests: [], reminders: [], tasks: [], messages: [], departments: [], systemSettings: [],
    attendances: [{ id: 'a1', labourId: 'missing' }]
  };
  assert.throws(() => validateReferences(data), /Reference validation failed before PostgreSQL writes/);
});

test('checks approvedBy references before migration', () => {
  const data = {
    users: [], labours: [{ id: 'l1' }], attendances: [], cashTransactions: [], reminders: [], tasks: [], messages: [], departments: [], systemSettings: [],
    advanceRequests: [{ id: 'r1', labourId: 'l1', requestedBy: null, approvedBy: 'missing', expenseTxId: null }]
  };
  assert.throws(() => validateReferences(data), /approvedBy references missing id missing/);
});

test('blocks missing required values before any PostgreSQL write', () => {
  const data = emptySource();
  data.users.push({ _id: 'u1', username: '', password: 'hash', name: 'Owner', role: 'owner' });
  const mapped = mapMongoData(data);
  assert.throws(() => validateRequiredValues(mapped), /users\[0\]\.username is required/);
});

test('compares full record contents, not only ids', () => {
  const expected = [{ id: '1', name: 'Original', createdAt: new Date('2026-01-01T00:00:00.000Z') }];
  const same = [{ createdAt: new Date('2026-01-01T00:00:00.000Z'), name: 'Original', id: '1' }];
  const changed = [{ id: '1', name: 'Changed', createdAt: new Date('2026-01-01T00:00:00.000Z') }];
  assert.equal(compareDatasets(expected, same).matches, true);
  assert.deepEqual(compareDatasets(expected, changed).changedIds, ['1']);
});

test('allows additive PostgreSQL columns without weakening migrated-field checks', () => {
  const expected = [{ id: '1', name: 'Original' }];
  const actual = [{ id: '1', name: 'Original', isActive: true, roleId: 'role-1' }];
  assert.equal(compareDatasets(expected, actual).matches, true);
});
