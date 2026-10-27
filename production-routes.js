const express = require('express');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const rules = require('./production-rules');
const { id, plain, fail, shiftFor, dayKey, dayStart, dayEnd, integer, shiftMinutesFor, readEntry, readDamage, rate, performanceFlags, recordBreaks, standingRecords } = rules;
const { productionModels, transaction } = require('./production-storage');
const { initializeCatalogue } = require('./scripts/seed-production-masters');
const SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

function createProductionRouter(options = {}) {
  const models = options.models || productionModels(require('./models'));
  const { StockRecipe, StockMove } = models;
  const resolveAccess = options.resolveAccess || require('./access-control').resolveUserAccess;
  const atomic = options.transaction || transaction;
  const { User, Labour, ToyType, Toy, ToyProcess, ProductionEntry, ProductionLog, DamageEntry, DamagePart, SystemSettings } = models;
  const router = express.Router();
  // Shift and break times are stored, not compiled in, so the office can change
  // them. Re-read briefly rather than per request: every handler needs them.
  const SHIFT_KEY = 'production.shifts';
  // Production-only metadata: never added to the shared worker/payroll response.
  const TRAINING_PREFIX = 'production.training.';
  const trainingSchedules = async () => new Map((SystemSettings ? await SystemSettings.find({}) : []).filter(row => row.key.startsWith(TRAINING_PREFIX)).map(row => [row.key.slice(TRAINING_PREFIX.length), row.value || {}]));
  const saveTraining = async (worker, body, previous = {}) => {
    const schedule = rules.readTrainingDates(body, previous);
    if (body.trainingStart === undefined && body.trainingEnd === undefined) return schedule;
    if (!SystemSettings) fail('Training settings are not available on this server.');
    const key = `${TRAINING_PREFIX}${id(worker)}`;
    await SystemSettings.findOneAndUpdate({ key }, { key, value: schedule }, { upsert: true, new: true });
    return schedule;
  };
  let shiftsReadAt = 0;
  const loadShifts = async () => {
    if (!SystemSettings || Date.now() - shiftsReadAt < 15000) return;
    try { rules.configureShifts((await SystemSettings.findOne({ key: SHIFT_KEY }))?.value || null); shiftsReadAt = Date.now(); }
    catch { /* A settings read failure leaves the last known times in place. */ }
  };
  const auth = async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Authorization token required' });
      const decoded = jwt.verify(header.slice(7), options.jwtSecret || SECRET);
      await loadShifts();
      req.user = await User.findById(decoded.id).select('-password');
      if (!req.user) return res.status(401).json({ message: 'User not found' });
      req.access = await resolveAccess(req.user);
      if (req.access.isActive === false) return res.status(403).json({ message: 'This account is switched off.' });
      next();
    } catch { res.status(401).json({ message: 'Invalid token' }); }
  };
  const allow = (write, permissions) => (req, res, next) => {
    if (req.user.role === 'owner') return write ? res.status(403).json({ message: 'Owner production access is read-only.' }) : next();
    const held = req.access.permissions || [];
    if (held.includes('*') || permissions.some(key => held.includes(key))) return next();
    res.status(403).json({ message: 'Production permission required.' });
  };
  const read = allow(false, ['production.entry', 'production.reports', 'production.masters']);
  const write = allow(true, ['production.entry', 'production.masters']);
  const recorderName = (body, fallback) => {
    if (body.enteredByName === undefined) return fallback || '';
    if (typeof body.enteredByName !== 'string' || !body.enteredByName.trim() || body.enteredByName.trim().length > 100) fail('Type the entry by name (up to 100 characters).');
    return body.enteredByName.trim();
  };
  const admin = allow(true, ['production.masters']);
  const report = allow(false, ['production.reports', 'production.masters']);
  const handle = (handler, mutation = false) => async (req, res) => {
    try { res.json(mutation ? await atomic(() => handler(req)) : await handler(req)); }
    catch (error) {
      const badInput = error.name === 'CastError' || error.name === 'ValidationError' || ['P2002', 'P2003', 'P2023'].includes(error.code) || error.code === 11000;
      res.status(error.statusCode || (badInput ? 400 : 500)).json({ message: badInput ? 'Invalid or duplicate production data.' : (error.message || 'Production operation failed.') });
    }
  };
  const audit = (req, action, summary, before = null, after = null, entryId = '') => ProductionLog.create({ action, summary, before: before ? JSON.parse(JSON.stringify(plain(before))) : null, after: after ? JSON.parse(JSON.stringify(plain(after))) : null, entryId, byName: req.user.name || '', at: new Date() });
  const get = async (model, key, label) => {
    if (!key || typeof key !== 'string') fail(`Choose a ${label.toLowerCase()}.`);
    const row = await model.findById(key);
    if (!row) fail(`${label} was not found.`, 404);
    return row;
  };
  const activeWorker = async key => {
    const worker = await get(Labour, key, 'Worker');
    if (worker.status !== 'active') fail('Choose an active worker.');
    return worker;
  };
  const activeParent = async (model, key, label) => {
    const parent = await get(model, key, label);
    if (parent.isActive === false) fail(`Choose an active ${label.toLowerCase()}.`);
    return parent;
  };
  const validateSelection = async data => {
    const worker = await activeWorker(data.labourId), toy = await activeParent(Toy, data.toyId, 'Toy');
    await activeParent(ToyType, id(toy.typeId), 'Category');
    const process = await activeParent(ToyProcess, data.processId, 'Process');
    if (id(process.toyId) !== id(toy)) fail('The process must belong to the selected toy.');
    return { worker, toy, process };
  };
  const sort = (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name);
  const workerView = worker => ({ id: id(worker), name: worker.name, gender: worker.gender || 'Male', department: worker.department || '', unit: worker.unit || '', empCode: worker.empCode || '', status: worker.status, shift: shiftFor(worker).label, shiftStart: shiftFor(worker).start, shiftEnd: shiftFor(worker).end, shiftMinutes: shiftMinutesFor(worker) });
  const shiftHours = () => ({ Male: shiftMinutesFor({ gender: 'Male' }) / 60, Female: shiftMinutesFor({ gender: 'Female' }) / 60 });
  const shiftLengths = () => Object.fromEntries(['Male', 'Female'].map(gender => {
    const minutes = shiftMinutesFor({ gender });
    return [gender, { hours: minutes / 60, minutes, label: shiftFor({ gender }).label }];
  }));
  router.get('/shifts', auth, read, handle(async () => ({ ...rules.shiftSettings(), hours: shiftHours(), labels: { Male: shiftFor({ gender: 'Male' }).label, Female: shiftFor({ gender: 'Female' }).label } })));
  router.put('/shifts', auth, admin, handle(async req => {
    if (!SystemSettings) fail('Shift settings are not available on this server.');
    const value = rules.readShiftSettings(req.body || {});
    const before = rules.shiftSettings();
    await SystemSettings.findOneAndUpdate({ key: SHIFT_KEY }, { key: SHIFT_KEY, value }, { upsert: true, new: true });
    rules.configureShifts(value); shiftsReadAt = Date.now();
    const hours = shiftHours();
    await audit(req, 'shifts-updated', `Shift times set to male ${value.shifts.Male.start}–${value.shifts.Male.end} (${hours.Male} hr) and female ${value.shifts.Female.start}–${value.shifts.Female.end} (${hours.Female} hr), ${value.breaks.length} breaks`, before, value);
    return { ...rules.shiftSettings(), hours, labels: { Male: shiftFor({ gender: 'Male' }).label, Female: shiftFor({ gender: 'Female' }).label } };
  }, true));
  // Damage stands apart from production: no worker, no work step, and the two
  // names are typed. Names already used come back with the list so the next
  // person picks instead of inventing a second spelling.
  // A part typed on the floor becomes a master row, so the next person picks it
  // and the office can rename it in one place.
  const partFor = async (body, toyId) => {
    const parts = await DamagePart.find({});
    if (body.partId) {
      const picked = parts.find(row => id(row) === id(body.partId) && row.isActive !== false);
      if (!picked) fail('That damaged part is not in the list.');
      return picked;
    }
    const typed = String(body.partName || '').trim().slice(0, 100);
    if (!typed) fail('Type or choose the damaged part.');
    // The same part name on two different toys is two different parts.
    const existing = parts.find(row => row.name.trim().toLowerCase() === typed.toLowerCase() && (!toyId || !id(row.toyId) || id(row.toyId) === toyId));
    if (existing) {
      const fixes = {};
      if (existing.isActive === false) fixes.isActive = true;
      if (toyId && !id(existing.toyId)) fixes.toyId = toyId;
      if (Object.keys(fixes).length) return DamagePart.findByIdAndUpdate(id(existing), fixes, { new: true });
      return existing;
    }
    return DamagePart.create({ name: typed, toyId: toyId || '', isActive: true, createdAt: new Date() });
  };
  // Damage recorded before parts had a master kept the name as loose text.
  // This adopts those names into the list once, so nothing the floor already
  // reported is lost when the list arrives.
  router.post('/damage-parts/adopt', auth, admin, handle(async req => {
    const [entries, parts] = await Promise.all([DamageEntry.find({}), DamagePart.find({})]);
    const byName = new Map(parts.map(row => [row.name.trim().toLowerCase(), row]));
    let added = 0, linked = 0;
    for (const row of entries) {
      if (row.partId) continue;
      const name = String(row.partName || '').trim();
      if (!name) continue;
      let part = byName.get(name.toLowerCase());
      if (!part) { part = await DamagePart.create({ name, isActive: true, createdAt: new Date() }); byName.set(name.toLowerCase(), part); added += 1; }
      await DamageEntry.findByIdAndUpdate(id(row), { partId: id(part), partName: part.name, updatedAt: new Date() });
      linked += 1;
    }
    if (linked) await audit(req, 'damage-parts-imported', `Imported ${added} part names from ${linked} earlier damage records`);
    return { added, linked };
  }, true));
  router.get('/damage', auth, read, handle(async req => {
    const to = dayEnd(req.query.to), from = req.query.from ? dayStart(req.query.from) : dayStart(new Date(dayStart(to).getTime() - 29 * 86400000));
    if (from > to) fail('Choose a valid damage range.');
    const [range, everything, parts] = await Promise.all([DamageEntry.find({ date: { $gte: from, $lte: to } }), DamageEntry.find({}), DamagePart.find({})]);
    // The master name wins, so renaming a part renames it everywhere it was used.
    const partName = row => parts.find(part => id(part) === id(row.partId))?.name || row.partName;
    return {
      from: dayKey(from), to: dayKey(to),
      entries: range.map(row => ({ id: id(row), date: dayKey(row.date), toyName: row.toyName, partId: id(row.partId), partName: partName(row), qty: row.qty, enteredByName: row.enteredByName || '', createdAt: row.createdAt }))
        .sort((a, b) => b.date.localeCompare(a.date) || new Date(b.createdAt) - new Date(a.createdAt)),
      total: range.reduce((sum, row) => sum + row.qty, 0),
      toyNames: [...new Set(everything.map(row => row.toyName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      parts: parts.filter(row => row.isActive !== false).map(row => ({ id: id(row), name: row.name, toyId: id(row.toyId) })).sort((a, b) => a.name.localeCompare(b.name))
    };
  }));
  router.post('/damage', auth, write, handle(async req => {
    const body = req.body || {};
    // The toy is picked from the catalogue, so its name is taken from there
    // rather than from whatever the phone sent.
    const toy = body.toyId ? await activeParent(Toy, body.toyId, 'Toy') : null;
    const part = await partFor(body, toy ? id(toy) : '');
    const data = { ...readDamage({ ...body, toyName: toy ? toy.name : body.toyName, partName: part.name }), partId: id(part), partName: part.name };
    const created = await DamageEntry.create({ ...data, enteredBy: id(req.user), enteredByName: recorderName(body, req.user.name), createdAt: new Date(), updatedAt: new Date() });
    await audit(req, 'damage-recorded', `${data.toyName} — ${data.partName} — ${data.qty} damaged`, null, created, id(created));
    return { id: id(created) };
  }, true));
  router.delete('/damage/:id', auth, write, handle(async req => {
    const before = await get(DamageEntry, req.params.id, 'Damage record');
    await DamageEntry.deleteOne({ _id: req.params.id });
    await audit(req, 'damage-deleted', `Removed damage of ${before.qty} ${before.partName} on ${before.toyName}`, before, null, id(before));
    return { ok: true };
  }, true));
  // Every saved record keeps the name as it stood at the time, so changing an
  // account's name has to move those snapshots with it, or the floor sees two
  // people where there is one. Owner accounts are out of reach from here.
  const liveAccount = async username => {
    const account = await User.findOne({ username: String(username || '').trim() });
    if (!account) fail('That account was not found.', 404);
    if (account.role === 'owner') fail('An owner account cannot be changed from here.', 403);
    return account;
  };
  router.post('/recorder-name', auth, admin, handle(async req => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) fail('Send the new name.');
    const account = await liveAccount(req.body?.username);
    const from = String(account.name || '').trim();
    await User.findByIdAndUpdate(id(account), { name });
    let records = 0;
    if (from && from !== name) {
      for (const [model, field] of [[ProductionEntry, 'enteredByName'], [DamageEntry, 'enteredByName'], [ProductionLog, 'byName']]) {
        for (const row of await model.find({ [field]: from })) { await model.findByIdAndUpdate(id(row), { [field]: name }); records += 1; }
      }
    }
    await audit(req, 'recorder-renamed', `${from || 'An account'} is now ${name} on ${records} records`);
    return { from, to: name, records };
  }, true));
  router.post('/account-active', auth, admin, handle(async req => {
    const account = await liveAccount(req.body?.username);
    const isActive = req.body?.isActive !== false;
    await User.findByIdAndUpdate(id(account), { isActive });
    await audit(req, isActive ? 'account-enabled' : 'account-disabled', `${account.name || account.username} was switched ${isActive ? 'on' : 'off'}`);
    return { username: account.username, isActive };
  }, true));
  router.get('/masters', auth, read, handle(async () => {
    const [types, toys, processes, workers, damageParts] = await Promise.all([ToyType.find({}), Toy.find({}), ToyProcess.find({}), Labour.find({}), DamagePart.find({})]);
    const schedules = await trainingSchedules();
    const trainingWorkerView = worker => ({ ...workerView(worker), ...rules.readTrainingDates({}, schedules.get(id(worker))), isTraining: rules.isTrainingOn(schedules.get(id(worker)), dayKey()) });
    const typeIds = new Set(types.filter(row => row.isActive !== false).map(id));
    const activeToys = toys.filter(row => row.isActive !== false && typeIds.has(id(row.typeId))), toyIds = new Set(activeToys.map(id));
    return {
      features: { training: true, multiWork: true, manualEntryBy: true },
      types: types.filter(row => row.isActive !== false).sort(sort).map(row => ({ id: id(row), name: row.name, sortOrder: row.sortOrder || 0 })),
      toys: activeToys.sort(sort).map(row => ({ id: id(row), typeId: id(row.typeId), name: row.name, code: row.code || '', sortOrder: row.sortOrder || 0 })),
      processes: processes.filter(row => row.isActive !== false && toyIds.has(id(row.toyId))).sort(sort).map(row => ({ id: id(row), toyId: id(row.toyId), name: row.name, targetPerHour: row.targetPerHour || 0, target8h: row.target8h || 0, target12h: row.target12h || 0, sortOrder: row.sortOrder || 0 })),
      workers: workers.filter(row => row.status === 'active').map(trainingWorkerView).sort((a, b) => a.name.localeCompare(b.name)),
      archivedWorkers: workers.filter(row => row.status !== 'active').map(trainingWorkerView).sort((a, b) => a.name.localeCompare(b.name)),
      // The parts the floor has typed, so the office can rename them in one
      // place and the app can offer them as a list.
      damageParts: damageParts.filter(row => row.isActive !== false).map(row => ({ id: id(row), name: row.name, toyId: id(row.toyId), toyName: toys.find(toy => id(toy) === id(row.toyId))?.name || '' })).sort((a, b) => a.toyName.localeCompare(b.toyName) || a.name.localeCompare(b.name)),
      // Shift lengths travel with the catalogue so a shift target can be
      // labelled with the hours it is actually for, not a figure from before
      // breaks were taken off.
      shifts: shiftLengths()
    };
  }));
  const workerData = (body, previous) => {
    const name = String(body.name ?? previous?.name ?? '').trim(), gender = body.gender ?? previous?.gender ?? 'Male';
    if (!name) fail('Worker name is required.');
    if (!['Male', 'Female', 'Other'].includes(gender)) fail('Choose a valid gender.');
    return { name: name.slice(0, 100), gender, empCode: String(body.empCode ?? previous?.empCode ?? '').trim().slice(0, 50), department: String(body.department ?? previous?.department ?? '').trim().slice(0, 100), unit: String(body.unit ?? previous?.unit ?? '').trim().slice(0, 40) };
  };
  /**
   * The next free employee code, as 001, 002, and so on.
   *
   * Codes the office did not number this way — the biometric machine's own
   * numbers, the B-prefixed staff ones, COMPANY — are left out of the count
   * rather than renumbered, so adding a worker never disturbs them.
   */
  const nextEmpCode = async () => {
    const taken = new Set((await Labour.find({})).map(row => String(row.empCode || '').trim()));
    const used = [...taken].filter(code => /^\d+$/.test(code)).map(Number);
    let next = Math.max(0, ...used) + 1;
    while (taken.has(String(next).padStart(3, '0'))) next++;
    return String(next).padStart(3, '0');
  };
  /** Two people must never share a code, or attendance lands on the wrong one. */
  const refuseDuplicateCode = async (code, excludeId = '') => {
    if (!code) return;
    const clash = (await Labour.find({})).find(row => String(row.empCode || '').trim().toLowerCase() === code.toLowerCase() && id(row) !== excludeId);
    if (clash) fail(`Employee code ${code} already belongs to ${clash.name}.`);
  };
  router.post('/workers', auth, admin, handle(async req => {
    rules.readTrainingDates(req.body || {});
    const data = workerData(req.body || {}), shift = shiftFor(data);
    if (!data.empCode) data.empCode = await nextEmpCode();
    await refuseDuplicateCode(data.empCode);
    const worker = await Labour.create({ ...data, status: 'active', employeeType: 'labourer', whatsapp: '', monthlySalary: 0, shiftStart: shift.start, shiftEnd: shift.end, workingHours: shiftMinutesFor(data) / 60 });
    const schedule = await saveTraining(worker, req.body || {});
    const result = { ...workerView(worker), ...schedule };
    await audit(req, 'worker-created', `Added worker "${worker.name}"`, null, result);
    return result;
  }, true));
  router.put('/workers/:id', auth, admin, handle(async req => {
    const before = await get(Labour, req.params.id, 'Worker');
    const previous = (await trainingSchedules()).get(id(before));
    rules.readTrainingDates(req.body || {}, previous);
    // Payroll/contact and attendance fields on existing Labour rows are preserved.
    const changes = workerData(req.body || {}, before);
    if (!changes.empCode) changes.empCode = await nextEmpCode();
    await refuseDuplicateCode(changes.empCode, id(before));
    const worker = await Labour.findByIdAndUpdate(req.params.id, changes, { new: true });
    const schedule = await saveTraining(worker, req.body || {}, previous);
    const result = { ...workerView(worker), ...schedule };
    await audit(req, 'worker-updated', `Edited worker "${worker.name}"`, { ...workerView(before), ...previous }, result);
    return result;
  }, true));
  router.delete('/workers/:id', auth, admin, handle(async req => {
    const before = await get(Labour, req.params.id, 'Worker'), after = await Labour.findByIdAndUpdate(req.params.id, { status: 'inactive' }, { new: true });
    await audit(req, 'worker-archived', `Archived worker "${before.name}"`, workerView(before), workerView(after));
    return { ok: true };
  }, true));
  const specs = [
    { path: 'toy-types', model: ToyType, label: 'category', fields: ['name', 'sortOrder'] },
    { path: 'toys', model: Toy, label: 'toy', fields: ['name', 'sortOrder', 'code', 'typeId'] },
    { path: 'processes', model: ToyProcess, label: 'process', fields: ['name', 'sortOrder', 'targetPerHour', 'target8h', 'target12h', 'toyId'] },
    { path: 'damage-parts', model: DamagePart, label: 'damaged part', fields: ['name', 'toyId'] }
  ];
  const masterData = async (spec, body, previous = {}) => {
    const data = {};
    for (const field of spec.fields) if (body[field] !== undefined) data[field] = body[field];
    const merged = { ...plain(previous), ...data };
    if (!String(merged.name || '').trim()) fail('Name is required.');
    data.name = String(merged.name).trim().slice(0, 100);
    if (data.sortOrder !== undefined) integer(data.sortOrder, 'Sort order');
    for (const field of ['targetPerHour', 'target8h', 'target12h']) {
      if (data[field] !== undefined && (typeof data[field] !== 'number' || !Number.isFinite(data[field]) || data[field] < 0)) fail('Target must be a nonnegative number.');
    }
    if (spec.path === 'toys') { await activeParent(ToyType, merged.typeId, 'Category'); data.typeId = id(merged.typeId); if (data.code !== undefined) data.code = String(data.code).slice(0, 50); }
    // Parts adopted from old records have no toy, and renaming one of those
    // must not be blocked by a toy it never had.
    if (spec.path === 'damage-parts') {
      if (merged.toyId) { await activeParent(Toy, merged.toyId, 'Toy'); data.toyId = id(merged.toyId); } else data.toyId = '';
      // One part name per toy. Two rows called "Top part" on the same toy
      // cannot be told apart later, and damage would be split between them.
      const clash = (await DamagePart.find({})).find(row => id(row) !== id(previous)
        && row.isActive !== false
        && id(row.toyId) === data.toyId
        && row.name.trim().toLowerCase() === data.name.toLowerCase());
      if (clash) fail(`${clash.name} is already a part of this toy.`);
    }
    if (spec.path === 'processes') {
      const toy = await activeParent(Toy, merged.toyId, 'Toy'); await activeParent(ToyType, id(toy.typeId), 'Category'); data.toyId = id(merged.toyId);
      if (previous.toyId && id(previous.toyId) !== data.toyId && (await ProductionEntry.find({ processId: id(previous) })).length) fail('A used process cannot be moved to another toy.');
    }
    return data;
  };
  for (const spec of specs) {
    router.post(`/${spec.path}`, auth, admin, handle(async req => {
      const created = await spec.model.create({ ...await masterData(spec, req.body || {}), isActive: true });
      await audit(req, 'master-created', `Added ${spec.label} "${created.name}"`, null, created);
      return { ...plain(created), id: id(created) };
    }, true));
    router.put(`/${spec.path}/:id`, auth, admin, handle(async req => {
      const before = await get(spec.model, req.params.id, spec.label), data = await masterData(spec, req.body || {}, before);
      const after = await spec.model.findByIdAndUpdate(req.params.id, data, { new: true });
      await audit(req, 'master-updated', `Edited ${spec.label} "${after.name}"`, before, after);
      return { ...plain(after), id: id(after) };
    }, true));
    router.delete(`/${spec.path}/:id`, auth, admin, handle(async req => {
      const before = await get(spec.model, req.params.id, spec.label), after = await spec.model.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
      await audit(req, 'master-archived', `Archived ${spec.label} "${before.name}"`, before, after);
      return { ok: true };
    }, true));
  }
  router.post('/catalogue/initialize', auth, admin, handle(async req => {
    const result = await initializeCatalogue(models);
    await audit(req, 'catalogue-initialized', 'Initialized editable photo catalogue (existing rows preserved)', null, result);
    return result;
  }, true));
  const viewEntries = (entries, workers, toys, processes, types = [], schedules = new Map()) => {
    const wm = new Map(workers.map(row => [id(row), row])), tm = new Map(toys.map(row => [id(row), row])), pm = new Map(processes.map(row => [id(row), row])), cm = new Map(types.map(row => [id(row), row]));
    return entries.map(row => ({ id: id(row), date: dayKey(row.date), labourId: id(row.labourId), workerName: wm.get(id(row.labourId))?.name || 'Archived worker', toyId: id(row.toyId), toyName: tm.get(id(row.toyId))?.name || 'Archived toy', typeId: id(tm.get(id(row.toyId))?.typeId), typeName: cm.get(id(tm.get(id(row.toyId))?.typeId))?.name || '', processId: id(row.processId), processName: pm.get(id(row.processId))?.name || 'Archived process', gender: wm.get(id(row.labourId))?.gender || 'Male', shiftMinutes: shiftMinutesFor(wm.get(id(row.labourId))), minutes: row.minutes, pieces: row.pieces, workType: row.workType || 'regular', groupId: row.groupId || '', groupName: row.groupName || '', note: row.note || '', enteredByName: row.enteredByName || '', enteredBy: id(row.enteredBy), createdAt: row.createdAt, updatedAt: row.updatedAt, isTraining: row.workType === 'training' || rules.isTrainingOn(schedules.get(id(row.labourId)), row.date) }));
  };
  router.get('/day', auth, read, handle(async req => {
    const date = dayStart(req.query.date), filter = { date: { $gte: date, $lte: dayEnd(date) } };
    const [entries, workers, toys, processes, types] = await Promise.all([ProductionEntry.find(filter), Labour.find({}), Toy.find({}), ToyProcess.find({}), ToyType.find({})]);
    const schedules = await trainingSchedules();
    return { date: dayKey(date), workers: workers.filter(row => row.status === 'active').map(worker => {
      return { ...workerView(worker), isTraining: rules.isTrainingOn(schedules.get(id(worker)), date) };
    }).sort((a, b) => a.name.localeCompare(b.name)), entries: viewEntries(entries, workers, toys, processes, types, schedules).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) };
  }));
  /**
   * What a saved entry spends off the shelf.
   *
   * The recipe hangs off the work step, so an entry of 400 pieces of body
   * assembly spends 400 times whatever that step uses. Every movement carries
   * the entry id, which is what lets a correction or a deletion take exactly
   * those movements back and nothing else.
   *
   * Stock never stands in the way of recording work: if the shelf cannot
   * answer, the entry is still saved and the shortage shows up on the stock
   * page, because the floor's record of what it made is the more important of
   * the two.
   */
  const spendStock = async (req, entry) => {
    if (!StockRecipe || !StockMove) return;
    // Matched on the names rather than the ids: a catalogue typed by hand ends
    // up holding "Fighter Jet" and "FIGHTER-JET", with the parts mapped under
    // one and the work recorded under the other. Ids would never meet and the
    // shelf would quietly never move. One line per item, so a toy written twice
    // does not take its parts off twice either.
    const [toys, steps] = await Promise.all([Toy.find({}), ToyProcess.find({})]);
    const nameOf = (rows, wanted) => rules.flatName(rows.find(row => id(row) === id(wanted))?.name || '');
    const toyWanted = nameOf(toys, entry.toyId), stepWanted = nameOf(steps, entry.processId);
    const seen = new Set();
    const lines = (await StockRecipe.find({})).filter(row => {
      const same = toyWanted && nameOf(toys, row.toyId) === toyWanted && nameOf(steps, row.processId) === stepWanted;
      if (!same || seen.has(id(row.itemId))) return false;
      seen.add(id(row.itemId));
      return true;
    });
    for (const line of lines) {
      const per = Number(line.per) || 1, each = Number(line.qty) || 0;
      if (!each) continue;
      await StockMove.create({
        date: entry.date, itemId: id(line.itemId), qty: -(Number(entry.pieces || 0) * each / per),
        reason: 'production', entryId: id(entry), toyId: id(entry.toyId), processId: id(entry.processId),
        pieces: Number(entry.pieces || 0), note: '', byName: req.user.name || '', createdAt: new Date()
      });
    }
  };
  /** Take back what an entry spent, so it can be re-applied or forgotten. */
  const unspendStock = async entryId => {
    if (!StockMove) return;
    await StockMove.deleteMany({ entryId: id(entryId), reason: 'production' });
  };

  router.post('/entries', auth, write, handle(async req => {
    const data = readEntry(req.body || {}), { worker, toy, process } = await validateSelection(data);
    const created = await ProductionEntry.create({ ...data, enteredBy: id(req.user), enteredByName: recorderName(req.body || {}, req.user.name), createdAt: new Date(), updatedAt: new Date() });
    await spendStock(req, created);
    await audit(req, 'entry-created', `${worker.name} — ${toy.name} / ${process.name} — ${data.pieces} pcs in ${data.minutes} min`, null, created, id(created));
    return { id: id(created) };
  }, true));
  /**
   * One job done by several people together.
   *
   * It is saved as an ordinary entry per member, all carrying the same group id
   * and name, because every report in this system reads one worker per row. The
   * pieces are shared out and the hours are the hours each of them stood there,
   * so the factory total and each person's rate both stay true. All or none:
   * half a group saved would read as a group that was short of people.
   */
  router.post('/entries/group', auth, write, handle(async req => {
    const body = req.body || {};
    const labourIds = [...new Set((Array.isArray(body.labourIds) ? body.labourIds : []).map(row => id(row)).filter(Boolean))];
    if (labourIds.length < 2) fail('A group needs at least two different workers.');
    if (labourIds.length > 25) fail('A group can hold up to twenty-five workers.');
    const groupName = String(body.groupName || '').trim().slice(0, 60);
    if (!groupName) fail('Give the group a name.');
    const pieces = integer(body.pieces, 'Pieces');
    if (pieces < labourIds.length) fail(`${labourIds.length} workers need at least ${labourIds.length} pieces to share.`);
    const groupId = randomUUID();
    const shares = rules.sharePieces(pieces, labourIds.length);
    const created = [];
    let job = null;
    for (const [index, labourId] of labourIds.entries()) {
      const data = readEntry({ ...body, labourId, pieces: shares[index], groupId, groupName });
      const { worker, toy, process } = await validateSelection(data);
      job = { toy, process };
      const row = await ProductionEntry.create({ ...data, enteredBy: id(req.user), enteredByName: recorderName(body, req.user.name), createdAt: new Date(), updatedAt: new Date() });
      // Each member holds a share of the same batch, so the shares add up to
      // the batch and the shelf falls by the batch, not by the batch times the
      // number of people.
      await spendStock(req, row);
      created.push({ worker, row });
    }
    const { toy, process } = job;
    await audit(req, 'entry-group-created', `Group "${groupName}" (${created.map(row => row.worker.name).join(', ')}) — ${toy.name} / ${process.name} — ${pieces} pcs in ${created[0].row.minutes} min each`, null, { groupId, groupName, pieces, labourIds }, groupId);
    return { groupId, groupName, shares, entries: created.map(row => id(row.row)) };
  }, true));
  router.put('/entries/:id', auth, write, handle(async req => {
    const before = await get(ProductionEntry, req.params.id, 'Entry'), data = readEntry({ ...plain(before), ...req.body });
    await validateSelection(data);
    const after = await ProductionEntry.findByIdAndUpdate(req.params.id, { ...data, enteredByName: recorderName(req.body || {}, before.enteredByName), updatedAt: new Date() }, { new: true });
    // A corrected entry spends afresh: the old movements go, the new ones land.
    await unspendStock(req.params.id);
    await spendStock(req, after);
    await audit(req, 'entry-updated', `Edited production — ${data.pieces} pcs in ${data.minutes} min`, before, after, id(before));
    return { id: id(after) };
  }, true));
  router.delete('/entries/:id', auth, write, handle(async req => {
    const before = await get(ProductionEntry, req.params.id, 'Entry');
    await ProductionEntry.deleteOne({ _id: req.params.id });
    await unspendStock(req.params.id);
    await audit(req, 'entry-deleted', `Removed production entry of ${before.pieces} pcs`, before, null, id(before));
    return { ok: true };
  }, true));
  // The report is built from a plain query object so the assistant can ask
  // for the same figures the Reports page shows, without a second route.
  const buildReport = async (query = {}) => {
    const to = dayEnd(query.to), requestedDays = query.days === undefined ? 30 : Number(query.days);
    if (!Number.isSafeInteger(requestedDays) || requestedDays < 1 || requestedDays > 3660) fail('Days must be between 1 and 3660.');
    const from = query.from ? dayStart(query.from) : dayStart(new Date(dayStart(to).getTime() - (requestedDays - 1) * 86400000));
    if (from > to || to - from >= 3660 * 86400000) fail('Choose a valid report range up to 3660 days.');
    const days = Math.round((dayStart(to) - from) / 86400000) + 1;
    // Read all earlier days for a baseline; current/future days never enter it.
    const [history, workers, toys, processes, types] = await Promise.all([ProductionEntry.find({ date: { $lte: to } }), Labour.find({}), Toy.find({}), ToyProcess.find({}), ToyType.find({})]);
    const schedules = await trainingSchedules();
    // An entry marked training counts as training whatever the worker's dates
    // say, and a worker inside their training window still does.
    const classify = row => ({ ...plain(row), isTraining: row.workType === 'training' || rules.isTrainingOn(schedules.get(id(row.labourId)), row.date) });
    const entries = history.filter(row => new Date(row.date) >= from), wm = new Map(workers.map(row => [id(row), row])), tm = new Map(toys.map(row => [id(row), row])), pm = new Map(processes.map(row => [id(row), row]));
    const trend = new Map(), byWorker = new Map(), byToy = new Map(), byProcess = new Map();
    for (let n = 0; n < days; n++) { const date = dayKey(new Date(from.getTime() + n * 86400000)); trend.set(date, { date, pieces: 0, minutes: 0, workers: new Set() }); }
    const add = (map, key, row) => { const total = map.get(key) || { pieces: 0, minutes: 0, dates: new Set() }; total.pieces += row.pieces; total.minutes += row.minutes; total.dates.add(dayKey(row.date)); map.set(key, total); };
    for (const row of entries) {
      const daily = trend.get(dayKey(row.date)); daily.pieces += row.pieces; daily.minutes += row.minutes; daily.workers.add(id(row.labourId));
      add(byWorker, id(row.labourId), row); add(byToy, id(row.toyId), row); add(byProcess, id(row.processId), row);
    }
    const measure = total => ({ pieces: total.pieces, minutes: total.minutes, hours: Math.round(total.minutes / 6) / 10, perHour: rate(total.pieces, total.minutes) });
    const flags = performanceFlags(history.map(classify)).filter(row => row.date >= dayKey(from)).map(row => ({ ...row, workerName: wm.get(row.workerId)?.name || 'Archived worker', toyName: tm.get(row.toyId)?.name || 'Archived toy', processName: pm.get(row.processId)?.name || 'Archived process' })).sort((a, b) => b.date.localeCompare(a.date) || b.drop - a.drop);
    const records = recordBreaks(history.map(classify)).filter(row => row.date >= dayKey(from)).map(row => ({ ...row, workerName: wm.get(row.workerId)?.name || 'Archived worker', previousWorkerName: wm.get(row.previousWorkerId)?.name || 'Archived worker', toyName: tm.get(row.toyId)?.name || 'Archived toy', processName: pm.get(row.processId)?.name || 'Archived process' })).sort((a, b) => b.date.localeCompare(a.date) || b.improvement - a.improvement);
    const recordBoard = standingRecords(history.map(classify)).map(row => ({ ...row, workerName: wm.get(row.workerId)?.name || 'Archived worker', toyName: tm.get(row.toyId)?.name || 'Archived toy', processName: pm.get(row.processId)?.name || 'Archived process' }));
    const dailyRecords = rules.dailyPieceRecords(history.map(classify));
    const recordNames = row => {
      const toy = tm.get(row.toyId), type = types.find(type => id(type) === id(toy?.typeId));
      return { ...row, competitorName: row.competitorWorkerId ? wm.get(row.competitorWorkerId)?.name || 'Archived worker' : undefined, workerName: wm.get(row.workerId)?.name || 'Archived worker', previousWorkerName: wm.get(row.previousWorkerId)?.name || 'Archived worker', toyName: toy?.name || 'Archived toy', categoryName: type?.name || 'Archived category', processName: pm.get(row.processId)?.name || 'Archived process' };
    };
    const dailyRecordBoard = dailyRecords.board.map(recordNames);
    const dailyRecordsBroken = dailyRecords.broken.filter(row => row.date >= dayKey(from)).map(recordNames).sort((a, b) => b.date.localeCompare(a.date) || b.pieces - a.pieces);
    const total = entries.reduce((sum, row) => ({ pieces: sum.pieces + row.pieces, minutes: sum.minutes + row.minutes }), { pieces: 0, minutes: 0 });
    const subtotal = rows => ({ ...measure(rows.reduce((sum, row) => ({ pieces: sum.pieces + row.pieces, minutes: sum.minutes + row.minutes }), { pieces: 0, minutes: 0 })), entries: rows.length, workers: new Set(rows.map(row => id(row.labourId))).size });
    const training = entries.filter(row => classify(row).isTraining), regular = entries.filter(row => !classify(row).isTraining);
    // Overtime belongs to a day, not to an entry: four jobs inside one long
    // day are one day of overtime, not four.
    const otDays = rules.overtimeDays(entries, key => wm.get(key));
    const overtime = otDays.filter(row => row.otMinutes > 0).map(row => ({ ...row, workerName: wm.get(row.workerId)?.name || 'Archived worker' }));
    const otMinutesTotal = overtime.reduce((sum, row) => sum + row.otMinutes, 0);
    const otOf = key => {
      const mine = overtime.filter(row => row.workerId === key);
      return { otHours: Math.round(mine.reduce((sum, row) => sum + row.otMinutes, 0) / 6) / 10, otDays: mine.length };
    };
    return {
      from: dayKey(from), to: dayKey(to), days, quantityKind: 'process-pieces', totals: { ...measure(total), entries: entries.length, workers: byWorker.size, otHours: Math.round(otMinutesTotal / 6) / 10, otDays: overtime.length, otWorkers: new Set(overtime.map(row => row.workerId)).size },
      overtime, overtimeGraceMinutes: rules.OVERTIME_GRACE_MINUTES,
      trainingTotals: subtotal(training), regularTotals: subtotal(regular),
      trainingWorkers: [...byWorker.keys()].filter(key => training.some(row => id(row.labourId) === key)).map(key => ({ id: key, name: wm.get(key)?.name || 'Archived worker', ...subtotal(training.filter(row => id(row.labourId) === key)), ...rules.readTrainingDates({}, schedules.get(key)) })),
      entries: viewEntries(entries, workers, toys, processes, types, schedules).sort((a, b) => b.date.localeCompare(a.date) || new Date(b.createdAt) - new Date(a.createdAt)),
      trend: [...trend.values()].map(row => ({ date: row.date, ...measure(row), workers: row.workers.size })),
      workers: [...byWorker].map(([key, total]) => {
        return { id: key, name: wm.get(key)?.name || 'Archived worker', gender: wm.get(key)?.gender || 'Male', ...measure(total), regular: subtotal(regular.filter(row => id(row.labourId) === key)), training: subtotal(training.filter(row => id(row.labourId) === key)), ...otOf(key), daysWorked: total.dates.size };
      }).sort((a, b) => b.pieces - a.pieces),
      toys: [...byToy].map(([key, total]) => ({ id: key, name: tm.get(key)?.name || 'Archived toy', ...measure(total) })).sort((a, b) => b.pieces - a.pieces),
      processes: [...byProcess].map(([key, total]) => ({ id: key, name: pm.get(key)?.name || 'Archived process', toyId: id(pm.get(key)?.toyId), toyName: tm.get(id(pm.get(key)?.toyId))?.name || 'Archived toy', ...measure(total) })).sort((a, b) => b.pieces - a.pieces),
      records, recordBoard, dailyRecordBoard, dailyRecordsBroken, flags, todayFlags: flags.filter(row => row.date === dayKey(to)).length, processCount: byProcess.size
    };
  };
  router.get('/report', auth, report, handle(req => buildReport(req.query)));
/**
   * The production assistant: a question in plain words, answered from this
   * factory's own figures.
   *
   * The model is given a prepared summary rather than the raw rows — a month of
   * entries would not fit in a prompt, and totals it has to add up itself are
   * totals it can get wrong. It is told to answer only from that summary, so an
   * unanswerable question gets "not in the data" instead of an invention.
   */
  const askRoutes = require('./ai-routes');
  router.post('/ask', auth, report, handle(async req => {
    const question = String(req.body?.question || '').trim();
    if (!question) fail('Ask a question first.');
    if (question.length > 1000) fail('Keep the question under 1000 characters.');

    const to = req.body?.to || dayKey(new Date());
    const days = Number(req.body?.days) || 30;
    const data = await buildReport({ days: String(days), to });
    const from = data.from;

    const [damageRows, damageParts, allProcesses, allToys, allTypes, allLabours] = await Promise.all([
      DamageEntry.find({ date: { $gte: dayStart(from), $lte: dayEnd(to) } }),
      DamagePart.find({}),
      ToyProcess.find({}),
      Toy.find({}),
      ToyType.find({}),
      Labour.find({})
    ]);
    const partName = row => damageParts.find(part => id(part) === id(row.partId))?.name || row.partName || 'Not recorded';
    const damageByToy = new Map(), damageByPart = new Map();
    for (const row of damageRows) {
      damageByToy.set(row.toyName, (damageByToy.get(row.toyName) || 0) + row.qty);
      const key = `${row.toyName} — ${partName(row)}`;
      damageByPart.set(key, (damageByPart.get(key) || 0) + row.qty);
    }

    const toyMap = new Map(allToys.map(t => [id(t), t.name]));
    const typeMap = new Map(allTypes.map(t => [id(t), t.name]));
    const targetOf = new Map(allProcesses.map(step => [id(step), step.targetPerHour || 0]));

    // Every active worker on the books, whether or not they logged work.
    const activeLabours = allLabours.filter(row => row.status === 'active' && row.empCode !== 'COMPANY' && !row.name.toLowerCase().includes('company'));
    const maleLabours = activeLabours.filter(w => w.gender === 'Male');
    const femaleLabours = activeLabours.filter(w => w.gender === 'Female');
    const prodWorkerMap = new Map((data.workers || []).map(w => [w.id, w]));

    const workforceDirectory = activeLabours.map(w => {
      const prod = prodWorkerMap.get(id(w));
      return {
        id: id(w),
        name: w.name,
        gender: w.gender || 'Male',
        empCode: w.empCode || '',
        department: w.department || 'Production',
        shiftHours: shiftMinutesFor(w) / 60,
        hasLoggedProduction: !!prod,
        totalPieces: prod ? prod.pieces : 0,
        totalHoursWorked: prod ? prod.hours : 0,
        daysWorked: prod ? prod.daysWorked : 0,
        averageRatePerHour: prod ? prod.perHour : 0
      };
    }).sort((a, b) => (b.totalPieces - a.totalPieces) || a.name.localeCompare(b.name));

    // Full master catalogue of all toys and work steps with their official target rates
    const masterCatalogue = allProcesses.filter(p => p.isActive !== false).map(step => {
      const toy = allToys.find(t => id(t) === id(step.toyId));
      const toyName = toy?.name || toyMap.get(id(step.toyId)) || 'General';
      const typeName = typeMap.get(id(toy?.typeId)) || '';
      const targetPerHour = step.targetPerHour || 0;
      return {
        toyName,
        category: typeName,
        workStepName: step.name,
        targetPerHour,
        targetPerFemaleShift: Math.round(targetPerHour * shiftMinutesFor({ gender: 'Female' }) / 60),
        targetPerMaleShift: Math.round(targetPerHour * shiftMinutesFor({ gender: 'Male' }) / 60)
      };
    });

    const pack = {
      factory: 'Bafna Toys',
      period: { from, to: data.to, days: data.days },
      shiftHours: shiftLengths(),
      workforce: {
        totalActiveWorkers: activeLabours.length,
        maleWorkersCount: maleLabours.length,
        femaleWorkersCount: femaleLabours.length,
        workersLoggedProductionCount: data.workers.length,
        workersWithoutProductionCount: activeLabours.length - data.workers.length,
        directory: workforceDirectory
      },
      masterCatalogue,
      totals: {
        ...data.totals,
        totalFactoryActiveWorkers: activeLabours.length,
        workersWithLoggedProduction: data.workers.length
      },
      dailyTotals: data.trend.filter(row => row.pieces > 0),
      workersWithProduction: data.workers,
      workers: data.workers,
      toys: data.toys,
      workSteps: (data.processes || []).map(step => ({ ...step, targetPerHour: targetOf.get(step.id) || 0 })),
      reviewFlags: data.flags,
      recordsBroken: data.records,
      standingRecords: data.recordBoard,
      training: { totals: data.trainingTotals, workers: data.trainingWorkers },
      overtime: {
        graceMinutes: data.overtimeGraceMinutes,
        totalHours: data.totals.otHours,
        days: data.totals.otDays,
        workers: data.totals.otWorkers,
        byDay: data.overtime
      },
      damage: {
        totalPieces: damageRows.reduce((sum, row) => sum + row.qty, 0),
        entries: damageRows.length,
        byToy: [...damageByToy].map(([toy, pieces]) => ({ toy, pieces })).sort((a, b) => b.pieces - a.pieces),
        byPart: [...damageByPart].map(([part, pieces]) => ({ part, pieces })).sort((a, b) => b.pieces - a.pieces)
      }
    };

    const enabled = await askRoutes.readEnabledProviders();
    const wanted = String(req.body?.model || '');
    const order = [wanted, 'gemini', 'claude', 'gpt'].filter((name, index, all) => name && all.indexOf(name) === index);
    const available = order.filter(name => askRoutes.PROVIDERS[name] && enabled[name] !== false);
    if (!available.length) fail('No AI provider is switched on. Turn one on in Settings → AI Council APIs.', 503);

    const lang = req.body?.lang === 'hinglish' ? 'hinglish' : 'en';
    // What the model needs is what the figures mean, not a script of answers.
    // Counts and totals belong in the data, where they stay true: a prompt that
    // said "83 workers" was still saying it after the 84th was hired.
    const instructions = [
      'You are the production analyst for Bafna Toys, a toy factory in India.',
      'Answer the question that was asked, fully, using the DATA below. Read every count and total from the data itself.',
      'If the data cannot answer something, say what it does show and what is missing. Never invent a figure.',
      'The DATA below was read just now and is current. Earlier turns in this conversation may quote figures from before the latest entries were saved, so where they disagree the DATA wins — and say so if the change matters.',
      '',
      'What the figures mean:',
      '- Quantities are process pieces. One toy passes several work steps, so these are not finished toys.',
      "- A worker is judged against the target rate of the work steps they actually did, never against another worker's raw output.",
      '- Shift lengths are already net of breaks.',
      "- overtime is worked out from the hours entered, not typed in: a day's minutes above that worker's own shift length. It is per worker per day, so a long day split across four jobs is one overtime day.",
      '- workforce.directory is every active worker on the books; workers[] is only those with production in this period. The two are different numbers and both matter.',
      '- Training work counts in output but is excluded from rankings, flags and records.',
      '- damage is counted separately from production: it is broken pieces, not output.',
      '',
      'How to answer:',
      'Give the whole picture, not a headline. Name the people, the toys and the work steps, give the numbers behind each claim, and use a table when there is more than a handful of rows. Say what the numbers suggest doing. Keep it readable on a phone.',
      'The page already puts an Excel download under every answer, covering the same data, so point to that rather than refusing a file.',
      lang === 'hinglish' ? 'Reply in Hinglish: Hindi written in English letters, mixed with the English words the office uses.' : 'Reply in English.',
      '',
      'DATA (' + pack.period.from + ' to ' + pack.period.to + '):',
      JSON.stringify(pack)
    ].join('\n');

    // Embed prior turns as plain text in the question rather than using each
    // provider's multi-turn "history" array.  Newer Gemini models with thinking
    // enabled require thinking-blocks in model turns, which we don't store.
    // Text injection is provider-agnostic and never triggers that validation.
    // The whole thread is carried, not the last few turns: a follow-up like
    // "aur uska damage?" only makes sense if what came before is still there.
    // Older turns drop out only when the budget runs out, and the model is told
    // that happened rather than quietly losing them.
    const HISTORY_BUDGET = 24000;
    const rawHistory = Array.isArray(req.body?.history)
      ? req.body.history.filter(turn =>
          turn &&
          typeof turn.question === 'string' && turn.question.trim() &&
          typeof turn.answer === 'string' && turn.answer.trim()
        )
      : [];

    const kept = [];
    let spent = 0;
    for (let index = rawHistory.length - 1; index >= 0; index--) {
      const turn = rawHistory[index];
      const text = `User: ${String(turn.question).trim().slice(0, 1000)}\nAssistant: ${String(turn.answer).trim().slice(0, 3000)}`;
      if (spent + text.length > HISTORY_BUDGET) break;
      spent += text.length;
      kept.unshift(text);
    }
    const dropped = rawHistory.length - kept.length;

    const contextBlock = kept.length > 0
      ? 'EARLIER IN THIS CONVERSATION'
        + (dropped > 0 ? ` (${dropped} older ${dropped === 1 ? 'turn' : 'turns'} left out for length)` : '')
        + ':\n\n'
        + kept.map((text, i) => `[Turn ${i + 1 + dropped}]\n${text}`).join('\n\n')
        + '\n\n---\n\n'
      : '';

    const fullQuestion = contextBlock
      ? `${contextBlock}Current question: ${question}`
      : question;

    let answer = null;
    let chosenModel = null;
    let lastError = null;

    for (const candidate of available) {
      try {
        answer = await askRoutes.PROVIDERS[candidate]({
          question: fullQuestion,
          lang,
          history: [],
          systemOverride: instructions,
          noSearch: true
        });
        chosenModel = candidate;
        void askRoutes.recordAiUsage(candidate, answer.usage);
        break;
      } catch (err) {
        lastError = err;
        console.warn(`AI provider ${candidate} failed:`, err.message);
      }
    }

    if (!answer) {
      throw lastError || new Error('All AI providers failed to answer.');
    }

    await audit(req, 'assistant-asked', `Asked the production assistant: ${question.slice(0, 120)}`, null, null);
    return { answer: answer.text, model: chosenModel, period: pack.period, data: pack };
  }));
  router.get('/history', auth, read, handle(async req => {
    const limit = req.query.limit === undefined ? 60 : Number(req.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('History limit must be between 1 and 200.');
    const filter = {};
    // One entry's own story, for the owner opening a record that was corrected.
    if (req.query.entryId) filter.entryId = String(req.query.entryId);
    if (req.query.from || req.query.to) filter.at = { ...(req.query.from ? { $gte: dayStart(req.query.from) } : {}), ...(req.query.to ? { $lte: dayEnd(req.query.to) } : {}) };
    const rows = await ProductionLog.find(filter);
    return { history: rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit).map(row => ({ id: id(row), action: row.action, summary: row.summary, byName: row.byName, at: row.at, entryId: row.entryId || '', before: row.before || null, after: row.after || null })) };
  }));
  return router;
}
module.exports = createProductionRouter();
module.exports.createProductionRouter = createProductionRouter;
module.exports.SHIFTS = rules.SHIFTS;
module.exports.shiftMinutesFor = shiftMinutesFor;
