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
    ProductionDay: [], ProductionEntry: [], ProductionLog: [], DamageEntry: [], SystemSettings: []
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

test('HTTP multi-work day keeps all three tasks and shares one cumulative time budget', async t => {
  const {request,entry,data}=await setup(t);
  data.Toy.push({_id:'lizard',name:'Lizard',typeId:'type',isActive:true});
  data.ToyProcess.push({_id:'lizard-body',name:'Body assembly',toyId:'lizard',isActive:true},{_id:'bird-gear',name:'Gearbox joint',toyId:'toy',isActive:true});
  for(const work of [{toyId:'toy2',processId:'process2',minutes:240},{toyId:'lizard',processId:'lizard-body',minutes:120},{toyId:'toy',processId:'bird-gear',minutes:90}]) assert.equal((await request('supervisor','POST','/entries',entry({...work,labourId:'w2'}))).status,200);
  const day=(await request('supervisor','GET','/day?date=2026-10-05')).body;
  assert.equal(day.entries.length,3);assert.equal(day.workers.find(row=>row.id==='w2').workedMinutes,450);
  assert.equal((await request('supervisor','POST','/entries',entry({labourId:'w2',minutes:1}))).status,400);
  assert.equal(data.ProductionLog.filter(row=>row.action==='entry-created').length,3);
});
test('HTTP training dates are production-only, validated, preserved and audited atomically', async t => {
  const {request,data,setFailAudit}=await setup(t);
  const schedule={trainingStart:'2026-10-05',trainingEnd:'2026-10-08'};
  assert.equal((await request('supervisor','PUT','/workers/w1',schedule)).status,403);
  for(const invalid of [{trainingStart:'2026-02-30',trainingEnd:'2026-10-08'},{trainingStart:'2026-10-09',trainingEnd:'2026-10-08'},{trainingStart:'2026-10-05'}]) assert.equal((await request('admin','PUT','/workers/w1',invalid)).status,400);
  assert.equal((await request('admin','PUT','/workers/w1',schedule)).status,200);
  assert.equal(data.Labour[0].trainingStart,undefined); // Shared payroll/worker response stays unchanged.
  assert.equal(data.ProductionLog.at(-1).after.trainingEnd,schedule.trainingEnd);
  await request('admin','PUT','/workers/w1',{name:'Renamed'});
  assert.equal((await request('admin','GET','/masters')).body.workers.find(row=>row.id==='w1').trainingEnd,schedule.trainingEnd);
  setFailAudit(true);
  assert.equal((await request('admin','PUT','/workers/w1',{trainingEnd:'2026-10-09'})).status,500);
  assert.equal(data.SystemSettings.find(row=>row.key==='production.training.w1').value.trainingEnd,schedule.trainingEnd);
  setFailAudit(false);
  const created=await request('admin','POST','/workers',{name:'New trainee',gender:'Male',...schedule});
  assert.equal(created.status,200);assert.equal(created.body.trainingStart,schedule.trainingStart);
});
test('HTTP training output remains in totals but never flags or pollutes the regular baseline', async t => {
  const {request,entry,data}=await setup(t);
  await request('admin','PUT','/workers/w1',{trainingStart:'2026-10-01',trainingEnd:'2026-10-04'});
  for(const [date,pieces] of [['2026-10-01',10000],['2026-10-04',1],['2026-10-05',100],['2026-10-06',40]]) data.ProductionEntry.push({_id:date,...entry({date:dayStart(date),pieces}),createdAt:new Date()});
  const report=(await request('owner','GET','/report?from=2026-10-01&to=2026-10-06')).body;
  assert.equal(report.totals.pieces,10141);assert.equal(report.trainingTotals.pieces,10001);assert.equal(report.regularTotals.pieces,140);
  assert.equal(report.trainingTotals.hours,2);assert.equal(report.trainingWorkers[0].name,'Male Worker');
  assert.equal(report.flags.length,1);assert.equal(report.flags[0].date,'2026-10-06');assert.equal(report.flags[0].usualRate,100);assert.equal(report.flags[0].baselineDays,1);
  assert.equal(report.entries.find(row=>row.date==='2026-10-04').isTraining,true);
  assert.equal(report.entries.find(row=>row.date==='2026-10-05').isTraining,false);
  assert.equal((await request('supervisor','GET','/day?date=2026-10-04')).body.workers.find(row=>row.id==='w1').isTraining,true);
  assert.equal((await request('supervisor','GET','/day?date=2026-10-05')).body.workers.find(row=>row.id==='w1').isTraining,false);
  assert.equal((await request('owner','GET','/report?from=2026-10-01&to=2026-10-04')).body.flags.length,0);
  await request('admin','DELETE','/workers/w1');
  assert.equal((await request('owner','GET','/report?from=2026-10-01&to=2026-10-04')).body.trainingTotals.pieces,10001);
});

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
  const created = await request('supervisor', 'POST', '/entries', entry({ minutes: 660 }));
  assert.equal((await request('admin', 'PUT', `/entries/${created.body.id}`, { pieces: 90, enteredByName: 'Spoofed', enteredBy: 'spoofed', createdAt: '2000-01-01' })).status, 200);
  assert.equal(data.ProductionEntry[0].enteredByName, 'Floor Supervisor'); assert.equal(data.ProductionEntry[0].enteredBy, 'supervisor');
  const log = data.ProductionLog.at(-1); assert.equal(log.byName, 'Production Admin'); assert.equal(log.before.pieces, 100); assert.equal(log.after.pieces, 90); assert.equal(log.before.toyId, 'toy');
  assert.equal((await request('admin', 'PUT', `/entries/${created.body.id}`, { date: '2026-10-06', labourId: 'w2', minutes: 451 })).status, 400);
  assert.equal((await request('admin', 'PUT', `/entries/${created.body.id}`, { date: '2026-10-06', labourId: 'w2', minutes: 450 })).status, 200);
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
  assert.equal(worker.status, 200); assert.equal(worker.body.shiftMinutes, 450); assert.equal(data.Labour.at(-1).monthlySalary, 0);
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

test('HTTP shift settings are stored, applied to available hours and refused when unworkable', async t => {
  const { request, data } = await setup(t);
  t.after(() => require('../production-rules').configureShifts(null));

  const defaults = await request('owner', 'GET', '/shifts');
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.hours.Male, 11);
  assert.equal(defaults.body.hours.Female, 7.5);
  assert.equal(defaults.body.breaks.length, 3);

  assert.equal((await request('supervisor', 'PUT', '/shifts', defaults.body)).status, 403);

  const saved = await request('admin', 'PUT', '/shifts', {
    shifts: { Male: { start: '09:00', end: '19:00' }, Female: { start: '10:00', end: '17:00' } },
    breaks: [{ label: 'Lunch', from: '13:00', to: '14:00' }]
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.hours.Male, 9);
  assert.equal(saved.body.hours.Female, 6);
  assert.equal(data.SystemSettings[0].value.breaks.length, 1);
  assert.equal(data.ProductionLog.at(-1).action, 'shifts-updated');

  // The stored times drive what the day view offers the supervisor.
  const day = await request('owner', 'GET', '/day?date=2026-10-05');
  assert.equal(day.body.workers.find(row => row.id === 'w2').availableMinutes, 360);

  assert.equal((await request('admin', 'PUT', '/shifts', { shifts: { Male: { start: '09:00', end: '19:00' }, Female: { start: '10:00', end: '17:00' } }, breaks: [{ label: 'All day', from: '10:00', to: '17:00' }] })).status, 400);
  assert.equal((await request('admin', 'GET', '/shifts')).body.hours.Female, 6);
});

test('HTTP report names who broke a record, and refuses one set in a short burst or on a first attempt', async t => {
  const { request } = await setup(t);
  const work = (date, labourId, minutes, pieces) => request('supervisor', 'POST', '/entries', { date, labourId, toyId: 'toy', processId: 'process', minutes, pieces });

  await work('2026-10-01', 'w1', 240, 800);   // first ever on this step — sets the bar, not a record
  await work('2026-10-02', 'w2', 240, 900);   // beats it
  await work('2026-10-03', 'w1', 240, 860);   // under the standing best
  await work('2026-10-05', 'w1', 30, 400);    // 800/hr but half an hour — too short to count
  await work('2026-10-06', 'w1', 240, 1000);  // beats it again

  const report = await request('owner', 'GET', '/report?from=2026-10-01&to=2026-10-06');
  assert.equal(report.status, 200);
  const records = report.body.records;
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(row => [row.date, row.workerName, row.rate, row.previousRate, row.previousWorkerName]), [
    ['2026-10-06', 'Male Worker', 250, 225, 'Female Worker'],
    ['2026-10-02', 'Female Worker', 225, 200, 'Male Worker']
  ]);
  assert.equal(records[0].improvement, 11);
  assert.equal(records[0].processName, 'Body assembly');
});

test('HTTP entries carry a work type, and one marked training stays out of the ranking while still counting as output', async t => {
  const { request, data } = await setup(t);

  assert.equal((await request('supervisor', 'POST', '/entries', { date: '2026-10-05', labourId: 'w1', toyId: 'toy', processId: 'process', minutes: 120, pieces: 100, workType: 'sleeping' })).status, 400);

  const plain = await request('supervisor', 'POST', '/entries', { date: '2026-10-05', labourId: 'w1', toyId: 'toy', processId: 'process', minutes: 120, pieces: 100 });
  assert.equal(plain.status, 200);
  assert.equal(data.ProductionEntry.at(-1).workType, 'regular');

  assert.equal((await request('supervisor', 'POST', '/entries', { date: '2026-10-05', labourId: 'w2', toyId: 'toy2', processId: 'process2', minutes: 120, pieces: 40, workType: 'training' })).status, 200);
  assert.equal((await request('supervisor', 'POST', '/entries', { date: '2026-10-05', labourId: 'w2', toyId: 'toy', processId: 'process', minutes: 120, pieces: 60, workType: 'cover' })).status, 200);

  const report = await request('owner', 'GET', '/report?from=2026-10-05&to=2026-10-05');
  assert.equal(report.status, 200);
  // Training counts in the factory total, and a worker's row keeps the two
  // apart: pieces is everything they did, regular is what they are judged on.
  assert.equal(report.body.totals.pieces, 200);
  assert.equal(report.body.trainingTotals.pieces, 40);
  const learner = report.body.workers.find(row => row.id === 'w2');
  assert.equal(learner.pieces, 100);
  assert.equal(learner.regular.pieces, 60);
  assert.equal(learner.training.pieces, 40);
  assert.deepEqual([...new Set(report.body.entries.map(row => row.workType))].sort(), ['cover', 'regular', 'training']);
});

test('HTTP damage is recorded on its own, remembers the names typed before and is refused when empty', async t => {
  const { request, data } = await setup(t);

  for (const bad of [{ toyName: '', partName: 'Top part', qty: 5 }, { toyName: 'C-1 Pullback car', partName: '', qty: 5 }, { toyName: 'C-1 Pullback car', partName: 'Top part', qty: 0 }]) {
    assert.equal((await request('supervisor', 'POST', '/damage', { date: '2026-10-06', ...bad })).status, 400);
  }

  const made = await request('supervisor', 'POST', '/damage', { date: '2026-10-06', toyName: '  C-1 Pullback car ', partName: 'Top part', qty: 5 });
  assert.equal(made.status, 200);
  assert.equal(data.DamageEntry[0].toyName, 'C-1 Pullback car');
  assert.equal(data.DamageEntry[0].enteredByName, 'Floor Supervisor');
  assert.equal(data.ProductionLog.at(-1).action, 'damage-recorded');

  assert.equal((await request('supervisor', 'POST', '/damage', { date: '2026-10-05', toyName: 'Hen', partName: 'Beak', qty: 2 })).status, 200);

  const list = await request('owner', 'GET', '/damage?from=2026-10-01&to=2026-10-06');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 7);
  // Newest first, and both names come back for the next person to pick.
  assert.deepEqual(list.body.entries.map(row => row.date), ['2026-10-06', '2026-10-05']);
  assert.deepEqual(list.body.toyNames, ['C-1 Pullback car', 'Hen']);
  assert.deepEqual(list.body.partNames, ['Beak', 'Top part']);

  // A range that holds nothing still offers every name ever typed.
  const empty = await request('owner', 'GET', '/damage?from=2026-09-01&to=2026-09-02');
  assert.equal(empty.body.entries.length, 0);
  assert.deepEqual(empty.body.toyNames, ['C-1 Pullback car', 'Hen']);

  assert.equal((await request('owner', 'POST', '/damage', { date: '2026-10-06', toyName: 'X', partName: 'Y', qty: 1 })).status, 403);
  assert.equal((await request('supervisor', 'DELETE', `/damage/${made.body.id}`)).status, 200);
  assert.equal(data.DamageEntry.length, 1);
});
