const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createProductionRouter } = require('../production-routes');
const { dayStart } = require('../production-rules');
const SECRET = 'isolated-production-test-secret';

const clone = value => structuredClone(value);
function fixture() {
  const data = {
    User: [
      { _id: 'owner', name: 'MD', role: 'owner', permissions: ['*'] },
      { _id: 'supervisor', name: 'Floor Supervisor', role: 'production-supervisor', permissions: ['production.entry'] },
      { _id: 'admin', name: 'Production Admin', role: 'production-admin', permissions: ['production.masters', 'production.entry', 'production.reports'] },
      { _id: 'reporter', name: 'Reporter', role: 'reporter', permissions: ['production.reports'] },
      { _id: 'staff', name: 'Office', role: 'staff', permissions: [] },
      { _id: 'disabled', name: 'Disabled', role: 'production-admin', permissions: ['*'], isActive: false }
    ],
    Labour: [{ _id: 'w1', name: 'Male Worker', gender: 'Male', status: 'active', whatsapp: 'existing-phone', monthlySalary: 25000, shiftStart: '07:00', workingHours: 9 }, { _id: 'w2', name: 'Female Worker', gender: 'Female', status: 'active' }, { _id: 'old', name: 'Former Worker', gender: 'Male', status: 'inactive' }],
    ToyType: [{ _id: 'type', name: 'Friction', isActive: true }],
    Toy: [{ _id: 'toy', name: 'Bird', typeId: 'type', isActive: true }, { _id: 'toy2', name: 'Fish', typeId: 'type', isActive: true }],
    ToyProcess: [{ _id: 'process', name: 'Body assembly', toyId: 'toy', isActive: true }, { _id: 'process2', name: 'Wheel joint', toyId: 'toy2', isActive: true }],
    ProductionDay: [], ProductionEntry: [], ProductionLog: []
  };
  let seq = 0, failAudit = false, tail = Promise.resolve();
  const matches = (row, where) => Object.entries(where).every(([key, value]) => {
    if (value instanceof Date) return new Date(row[key]).getTime() === value.getTime();
    if (value && typeof value === 'object') return Object.entries(value).every(([op, bound]) => op === '$gte' ? row[key] >= bound : op === '$lte' ? row[key] <= bound : op === '$lt' ? row[key] < bound : false);
    return row[key] === value;
  });
  const query = getter => ({ select() { return this; }, then(resolve, reject) { return Promise.resolve().then(() => clone(getter())).then(resolve, reject); } });
  const models = Object.fromEntries(Object.keys(data).map(name => [name, {
    find: (where = {}) => query(() => data[name].filter(row => matches(row, where))),
    findOne: where => query(() => data[name].find(row => matches(row, where)) || null),
    findById: key => query(() => data[name].find(row => row._id === key) || null),
    create: async payload => { if (name === 'ProductionLog' && failAudit) throw new Error('Audit unavailable'); const row = { _id: `${name}-${++seq}`, ...clone(payload) }; data[name].push(row); return clone(row); },
    findByIdAndUpdate: async (key, update) => { const row = data[name].find(row => row._id === key); if (!row) return null; Object.assign(row, clone(update)); return clone(row); },
    findOneAndUpdate: async (where, update, options) => { let row = data[name].find(row => matches(row, where)); if (!row && options.upsert) { row = { _id: `${name}-${++seq}`, ...clone(where) }; data[name].push(row); } if (!row) return null; Object.assign(row, clone(update)); return clone(row); },
    deleteOne: async where => { const index = data[name].findIndex(row => matches(row, where)); if (index >= 0) data[name].splice(index, 1); }
  }]));
  // This isolated transaction fixture tests route rollback and cumulative writes.
  // Provider-specific transactions are inspected separately, without live data.
  const transaction = work => {
    const result = tail.then(async () => { const before = clone(data); try { return await work(); } catch (error) { for (const name of Object.keys(data)) data[name] = before[name]; throw error; } });
    tail = result.catch(() => {}); return result;
  };
  return { data, models, transaction, setFailAudit: value => { failAudit = value; } };
}
async function setup(t) {
  const f = fixture(), app = express(); app.use(express.json());
  app.use('/api/production', createProductionRouter({ models: f.models, transaction: f.transaction, resolveAccess: async user => ({ permissions: user.permissions, isActive: user.isActive !== false }), jwtSecret: SECRET }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (role, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/production${path}`, { method, headers: { ...(role ? { Authorization: `Bearer ${jwt.sign({ id: role }, SECRET)}` } : {}), 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const entry = (overrides = {}) => ({ date: '2026-10-05', labourId: 'w1', toyId: 'toy', processId: 'process', minutes: 60, pieces: 100, ...overrides });
  return { ...f, request, entry };
}

test('HTTP permission matrix makes owner/report-only read-only and admin masters-only writes', async t => {
  const { request, entry } = await setup(t);
  assert.equal((await request(null, 'GET', '/masters')).status, 401);
  assert.equal((await request('disabled', 'GET', '/masters')).status, 403);
  assert.equal((await request('staff', 'GET', '/masters')).status, 403);
  for (const role of ['owner', 'reporter']) {
    assert.equal((await request(role, 'GET', '/masters')).status, 200);
    assert.equal((await request(role, 'POST', '/entries', entry())).status, 403);
    assert.equal((await request(role, 'POST', '/day', { date: '2026-10-05', labourId: 'w1' })).status, 403);
    assert.equal((await request(role, 'POST', '/workers', { name: 'New' })).status, 403);
    assert.equal((await request(role, 'DELETE', '/toys/toy')).status, 403);
  }
  assert.equal((await request('supervisor', 'GET', '/history')).status, 200);
  assert.equal((await request('supervisor', 'GET', '/report')).status, 403);
  assert.equal((await request('supervisor', 'POST', '/workers', { name: 'No' })).status, 403);
  assert.equal((await request('admin', 'GET', '/report')).status, 200);
  assert.equal((await request('supervisor', 'POST', '/entries', entry())).status, 200);
});
test('HTTP validates selection, strict dates/integers and cumulative attendance budgets', async t => {
  const { request, entry, data } = await setup(t);
  for (const overrides of [{ pieces: -1 }, { pieces: 1.2 }, { pieces: '10' }, { minutes: 0 }, { minutes: 1.5 }, { date: '2026-02-30' }, { processId: 'process2' }, { labourId: 'old' }]) assert.equal((await request('supervisor', 'POST', '/entries', entry(overrides))).status, 400);
  data.ToyType[0].isActive = false;
  assert.equal((await request('supervisor', 'POST', '/entries', entry())).status, 400); data.ToyType[0].isActive = true;
  assert.equal((await request('supervisor', 'POST', '/day', { date: '2026-10-05', labourId: 'w2', inTime: '10:30', outTime: '17:30', breakMinutes: 30 })).body.availableMinutes, 390);
  assert.equal((await request('supervisor', 'POST', '/entries', entry({ labourId: 'w2', minutes: 390 }))).status, 200);
  assert.equal((await request('supervisor', 'POST', '/entries', entry({ labourId: 'w2', minutes: 1 }))).status, 400);
  assert.equal((await request('supervisor', 'POST', '/day', { date: '2026-10-05', labourId: 'w2', status: 'leave' })).status, 400);
  assert.equal((await request('supervisor', 'POST', '/day', { date: '2026-10-05', labourId: 'w2', inTime: '10:30', outTime: '17:30', breakMinutes: 60 })).status, 400);
  const day = await request('supervisor', 'GET', '/day?date=2026-10-05');
  assert.equal(day.body.date, '2026-10-05'); assert.equal(day.body.workers.find(row => row.id === 'w2').breakMinutes, 30);
  const concurrent = await Promise.all([request('supervisor', 'POST', '/entries', entry({ minutes: 500 })), request('supervisor', 'POST', '/entries', entry({ minutes: 500 }))]);
  assert.deepEqual(concurrent.map(row => row.status).sort(), [200, 400]);
});
test('HTTP entry edits preserve attribution, move dates, exclude self from budget and audit full before/after', async t => {
  const { request, entry, data } = await setup(t);
  const created = await request('supervisor', 'POST', '/entries', entry({ minutes: 720 }));
  assert.equal((await request('admin', 'PUT', `/entries/${created.body.id}`, { pieces: 90, enteredByName: 'Spoofed', enteredBy: 'spoofed', createdAt: '2000-01-01' })).status, 200);
  assert.equal(data.ProductionEntry[0].enteredByName, 'Floor Supervisor'); assert.equal(data.ProductionEntry[0].enteredBy, 'supervisor');
  const log = data.ProductionLog.at(-1); assert.equal(log.byName, 'Production Admin'); assert.equal(log.before.pieces, 100); assert.equal(log.after.pieces, 90); assert.equal(log.before.toyId, 'toy');
  assert.equal((await request('admin', 'PUT', `/entries/${created.body.id}`, { date: '2026-10-06', labourId: 'w2', minutes: 481 })).status, 400);
  assert.equal((await request('admin', 'PUT', `/entries/${created.body.id}`, { date: '2026-10-06', labourId: 'w2', minutes: 480 })).status, 200);
  assert.equal(data.ProductionEntry[0].date.toISOString(), '2026-10-06T00:00:00.000Z');
});
test('HTTP audit failure rolls back entries, attendance, deletes and masters', async t => {
  const { request, entry, data, setFailAudit } = await setup(t);
  const created = await request('supervisor', 'POST', '/entries', entry());
  const baseline = clone(data); setFailAudit(true);
  assert.equal((await request('supervisor', 'POST', '/entries', entry())).status, 500);
  assert.equal((await request('supervisor', 'PUT', `/entries/${created.body.id}`, { pieces: 7 })).status, 500);
  assert.equal((await request('supervisor', 'DELETE', `/entries/${created.body.id}`)).status, 500);
  assert.equal((await request('supervisor', 'POST', '/day', { date: '2026-10-05', labourId: 'w1', inTime: '09:30' })).status, 500);
  assert.equal((await request('admin', 'POST', '/workers', { name: 'Rollback' })).status, 500);
  assert.deepEqual(data, baseline);
});
test('HTTP worker management preserves payroll and history when archived', async t => {
  const { request, entry, data } = await setup(t);
  await request('supervisor', 'POST', '/entries', entry());
  const worker = await request('admin', 'POST', '/workers', { name: 'New Woman', gender: 'Female', empCode: 'N1', department: 'Toys', monthlySalary: 999999 });
  assert.equal(worker.status, 200); assert.equal(worker.body.shiftMinutes, 480); assert.equal(data.Labour.at(-1).monthlySalary, 0);
  assert.equal((await request('admin', 'PUT', '/workers/w1', { name: 'Renamed Worker', monthlySalary: 0, whatsapp: 'overwrite', shiftStart: '08:30' })).status, 200);
  assert.equal(data.Labour[0].monthlySalary, 25000); assert.equal(data.Labour[0].whatsapp, 'existing-phone'); assert.equal(data.Labour[0].shiftStart, '07:00');
  assert.equal((await request('admin', 'DELETE', '/workers/w1')).status, 200);
  const masters = await request('owner', 'GET', '/masters');
  assert.equal(masters.body.workers.some(row => row.id === 'w1'), false); assert.equal(masters.body.archivedWorkers.find(row => row.id === 'w1').name, 'Renamed Worker');
  assert.equal((await request('owner', 'GET', '/day?date=2026-10-05')).body.entries[0].workerName, 'Renamed Worker');
  assert.equal((await request('owner', 'GET', '/report?from=2026-10-05&to=2026-10-05')).body.workers[0].name, 'Renamed Worker');
});
test('HTTP report has zero-filled range, full entry history, process totals and prior baseline outside range', async t => {
  const { request, data, entry } = await setup(t);
  const row = (date, pieces, overrides = {}) => ({ _id: `e-${date}-${pieces}`, ...entry({ date: dayStart(date), pieces, ...overrides }), enteredByName: 'Floor Supervisor', createdAt: new Date(), updatedAt: new Date() });
  data.ProductionEntry.push(row('2026-10-01', 100), row('2026-10-03', 30), row('2026-10-04', 100000), row('2026-10-01', 100000, { toyId: 'toy2', processId: 'process2' }));
  const result = await request('owner', 'GET', '/report?from=2026-10-02&to=2026-10-03');
  assert.equal(result.status, 200); assert.equal(result.body.entries.length, 1); assert.equal(result.body.trend.length, 2); assert.equal(result.body.trend[0].pieces, 0);
  assert.equal(result.body.totals.pieces, 30); assert.equal(result.body.processes[0].name, 'Body assembly'); assert.equal(result.body.quantityKind, 'process-pieces');
  assert.equal(result.body.flags.length, 1); assert.equal(result.body.flags[0].usualRate, 100); assert.equal(result.body.entries[0].typeName, 'Friction');
  assert.equal((await request('owner', 'GET', '/report?from=2026-10-06&to=2026-10-05')).status, 400);
});
test('HTTP catalogue initialization is admin-only, idempotent and preserves archived/edited rows', async t => {
  const { request, data } = await setup(t);
  assert.equal((await request('owner', 'POST', '/catalogue/initialize', {})).status, 403);
  const first = await request('admin', 'POST', '/catalogue/initialize', {});
  assert.equal(first.status, 200); assert.equal(first.body.addedTypes, 7); assert.ok(first.body.addedProcesses > 20);
  const bird = data.Toy.find(row => row.name === 'Bird' && row._id !== 'toy'); bird.isActive = false;
  const second = await request('admin', 'POST', '/catalogue/initialize', {});
  assert.deepEqual(second.body, { addedTypes: 0, addedToys: 0, addedProcesses: 0 }); assert.equal(bird.isActive, false);
  assert.equal((await request('admin', 'POST', '/processes', { name: 'Invalid', toyId: 'missing' })).status, 404);
  assert.equal((await request('admin', 'POST', '/toys', { name: 'Missing category' })).status, 400);
  assert.equal((await request('admin', 'POST', '/processes', { name: 'Missing toy' })).status, 400);
});
