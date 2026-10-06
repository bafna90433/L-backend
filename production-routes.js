const express = require('express');
const jwt = require('jsonwebtoken');
const rules = require('./production-rules');
const { id, plain, fail, shiftFor, dayKey, dayStart, dayEnd, integer, availableMinutesFor, attendance, readEntry, readDamage, rate, performanceFlags, recordBreaks, standingRecords } = rules;
const { productionModels, transaction } = require('./production-storage');
const { initializeCatalogue } = require('./scripts/seed-production-masters');
const SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

function createProductionRouter(options = {}) {
  const models = options.models || productionModels(require('./models'));
  const resolveAccess = options.resolveAccess || require('./access-control').resolveUserAccess;
  const atomic = options.transaction || transaction;
  const { User, Labour, ToyType, Toy, ToyProcess, ProductionDay, ProductionEntry, ProductionLog, DamageEntry, DamagePart, SystemSettings } = models;
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
  const workerView = worker => ({ id: id(worker), name: worker.name, gender: worker.gender || 'Male', department: worker.department || '', empCode: worker.empCode || '', status: worker.status, shift: shiftFor(worker).label, shiftStart: shiftFor(worker).start, shiftEnd: shiftFor(worker).end, shiftMinutes: availableMinutesFor(worker) });
  const shiftHours = () => ({ Male: availableMinutesFor({ gender: 'Male' }) / 60, Female: availableMinutesFor({ gender: 'Female' }) / 60 });
  const shiftLengths = () => Object.fromEntries(['Male', 'Female'].map(gender => {
    const minutes = availableMinutesFor({ gender });
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
    const created = await DamageEntry.create({ ...data, enteredBy: id(req.user), enteredByName: req.user.name, createdAt: new Date(), updatedAt: new Date() });
    await audit(req, 'damage-recorded', `${data.toyName} — ${data.partName} — ${data.qty} damaged`, null, created, id(created));
    return { id: id(created) };
  }, true));
  router.delete('/damage/:id', auth, write, handle(async req => {
    const before = await get(DamageEntry, req.params.id, 'Damage record');
    await DamageEntry.deleteOne({ _id: req.params.id });
    await audit(req, 'damage-deleted', `Removed damage of ${before.qty} ${before.partName} on ${before.toyName}`, before, null, id(before));
    return { ok: true };
  }, true));
  router.get('/masters', auth, read, handle(async () => {
    const [types, toys, processes, workers, damageParts] = await Promise.all([ToyType.find({}), Toy.find({}), ToyProcess.find({}), Labour.find({}), DamagePart.find({})]);
    const schedules = await trainingSchedules();
    const trainingWorkerView = worker => ({ ...workerView(worker), ...rules.readTrainingDates({}, schedules.get(id(worker))), isTraining: rules.isTrainingOn(schedules.get(id(worker)), dayKey()) });
    const typeIds = new Set(types.filter(row => row.isActive !== false).map(id));
    const activeToys = toys.filter(row => row.isActive !== false && typeIds.has(id(row.typeId))), toyIds = new Set(activeToys.map(id));
    return {
      features: { training: true, multiWork: true },
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
    return { name: name.slice(0, 100), gender, empCode: String(body.empCode ?? previous?.empCode ?? '').trim().slice(0, 50), department: String(body.department ?? previous?.department ?? '').trim().slice(0, 100) };
  };
  router.post('/workers', auth, admin, handle(async req => {
    rules.readTrainingDates(req.body || {});
    const data = workerData(req.body || {}), shift = shiftFor(data);
    const worker = await Labour.create({ ...data, status: 'active', employeeType: 'labourer', whatsapp: '', monthlySalary: 0, shiftStart: shift.start, shiftEnd: shift.end, workingHours: availableMinutesFor(data) / 60 });
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
    const worker = await Labour.findByIdAndUpdate(req.params.id, workerData(req.body || {}, before), { new: true });
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
    if (spec.path === 'damage-parts') { if (merged.toyId) { await activeParent(Toy, merged.toyId, 'Toy'); data.toyId = id(merged.toyId); } else data.toyId = ''; }
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
    return entries.map(row => ({ id: id(row), date: dayKey(row.date), labourId: id(row.labourId), workerName: wm.get(id(row.labourId))?.name || 'Archived worker', toyId: id(row.toyId), toyName: tm.get(id(row.toyId))?.name || 'Archived toy', typeId: id(tm.get(id(row.toyId))?.typeId), typeName: cm.get(id(tm.get(id(row.toyId))?.typeId))?.name || '', processId: id(row.processId), processName: pm.get(id(row.processId))?.name || 'Archived process', minutes: row.minutes, pieces: row.pieces, workType: row.workType || 'regular', note: row.note || '', enteredByName: row.enteredByName || '', enteredBy: id(row.enteredBy), createdAt: row.createdAt, updatedAt: row.updatedAt, isTraining: rules.isTrainingOn(schedules.get(id(row.labourId)), row.date) }));
  };
  router.get('/day', auth, read, handle(async req => {
    const date = dayStart(req.query.date), filter = { date: { $gte: date, $lte: dayEnd(date) } };
    const [days, entries, workers, toys, processes, types] = await Promise.all([ProductionDay.find(filter), ProductionEntry.find(filter), Labour.find({}), Toy.find({}), ToyProcess.find({}), ToyType.find({})]);
    const schedules = await trainingSchedules();
    return { date: dayKey(date), workers: workers.filter(row => row.status === 'active').map(worker => {
      const day = days.find(row => id(row.labourId) === id(worker)), logged = entries.filter(row => id(row.labourId) === id(worker));
      return { ...workerView(worker), isTraining: rules.isTrainingOn(schedules.get(id(worker)), date), status: day?.status || 'present', inTime: day?.inTime || shiftFor(worker).start, outTime: day?.outTime || shiftFor(worker).end, breakMinutes: day?.breakMinutes ?? rules.breakMinutesFor(worker, day?.inTime, day?.outTime), availableMinutes: day?.availableMinutes ?? availableMinutesFor(worker, day), workedMinutes: logged.reduce((sum, row) => sum + row.minutes, 0), pieces: logged.reduce((sum, row) => sum + row.pieces, 0), note: day?.note || '' };
    }).sort((a, b) => a.name.localeCompare(b.name)), entries: viewEntries(entries, workers, toys, processes, types, schedules).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) };
  }));
  router.post('/day', auth, write, handle(async req => {
    const body = req.body || {}, worker = await activeWorker(body.labourId), date = dayStart(body.date);
    const data = { ...attendance(worker, body), date, labourId: id(worker), updatedAt: new Date() };
    const entries = await ProductionEntry.find({ date, labourId: id(worker) });
    if (entries.reduce((sum, row) => sum + row.minutes, 0) > data.availableMinutes) fail('Attendance cannot be reduced below already logged production minutes.');
    const before = await ProductionDay.findOne({ date, labourId: id(worker) });
    if (!before?.enteredBy) Object.assign(data, { enteredBy: id(req.user), enteredByName: req.user.name });
    if (!before) data.createdAt = new Date();
    const after = await ProductionDay.findOneAndUpdate({ date, labourId: id(worker) }, data, { upsert: true, new: true });
    await audit(req, 'attendance', `${worker.name} — ${data.status} ${data.inTime}–${data.outTime}`, before, after);
    return { id: id(after), availableMinutes: data.availableMinutes, availableHours: data.availableMinutes / 60, breakMinutes: data.breakMinutes };
  }, true));
  // A common attendance-row write prevents concurrent Mongo entries from
  // passing the same budget snapshot; Postgres uses serializable transactions.
  const budget = async (data, worker, exclude = '') => {
    const filter = { date: data.date, labourId: data.labourId }, day = await ProductionDay.findOne(filter);
    const logged = (await ProductionEntry.find(filter)).filter(row => id(row) !== exclude).reduce((sum, row) => sum + row.minutes, 0), available = day?.availableMinutes ?? availableMinutesFor(worker, day);
    if (logged + data.minutes > available) fail(`Only ${Math.max(0, available - logged)} production minutes remain for this worker.`);
    // Ensure this is a real write even when two entries share one millisecond.
    const touchedAt = new Date(Math.max(Date.now(), (new Date(day?.updatedAt || 0).getTime() || 0) + 1));
    const touch = day ? { updatedAt: touchedAt } : { ...filter, ...attendance(worker, {}), enteredBy: '', enteredByName: '', createdAt: new Date(), updatedAt: touchedAt };
    await ProductionDay.findOneAndUpdate(filter, touch, { upsert: true, new: true });
  };
  router.post('/entries', auth, write, handle(async req => {
    const data = readEntry(req.body || {}), { worker, toy, process } = await validateSelection(data);
    await budget(data, worker);
    const created = await ProductionEntry.create({ ...data, enteredBy: id(req.user), enteredByName: req.user.name, createdAt: new Date(), updatedAt: new Date() });
    await audit(req, 'entry-created', `${worker.name} — ${toy.name} / ${process.name} — ${data.pieces} pcs in ${data.minutes} min`, null, created, id(created));
    return { id: id(created) };
  }, true));
  router.put('/entries/:id', auth, write, handle(async req => {
    const before = await get(ProductionEntry, req.params.id, 'Entry'), data = readEntry({ ...plain(before), ...req.body });
    const { worker } = await validateSelection(data); await budget(data, worker, id(before));
    const after = await ProductionEntry.findByIdAndUpdate(req.params.id, { ...data, updatedAt: new Date() }, { new: true });
    await audit(req, 'entry-updated', `Edited production — ${data.pieces} pcs in ${data.minutes} min`, before, after, id(before));
    return { id: id(after) };
  }, true));
  router.delete('/entries/:id', auth, write, handle(async req => {
    const before = await get(ProductionEntry, req.params.id, 'Entry');
    await ProductionEntry.deleteOne({ _id: req.params.id });
    await audit(req, 'entry-deleted', `Removed production entry of ${before.pieces} pcs`, before, null, id(before));
    return { ok: true };
  }, true));
  router.get('/report', auth, report, handle(async req => {
    const to = dayEnd(req.query.to), requestedDays = req.query.days === undefined ? 30 : Number(req.query.days);
    if (!Number.isSafeInteger(requestedDays) || requestedDays < 1 || requestedDays > 3660) fail('Days must be between 1 and 3660.');
    const from = req.query.from ? dayStart(req.query.from) : dayStart(new Date(dayStart(to).getTime() - (requestedDays - 1) * 86400000));
    if (from > to || to - from >= 3660 * 86400000) fail('Choose a valid report range up to 3660 days.');
    const days = Math.round((dayStart(to) - from) / 86400000) + 1;
    // Read all earlier days for a baseline; current/future days never enter it.
    const [history, dayRows, workers, toys, processes, types] = await Promise.all([ProductionEntry.find({ date: { $lte: to } }), ProductionDay.find({ date: { $gte: from, $lte: to } }), Labour.find({}), Toy.find({}), ToyProcess.find({}), ToyType.find({})]);
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
    const total = entries.reduce((sum, row) => ({ pieces: sum.pieces + row.pieces, minutes: sum.minutes + row.minutes }), { pieces: 0, minutes: 0 });
    const subtotal = rows => ({ ...measure(rows.reduce((sum, row) => ({ pieces: sum.pieces + row.pieces, minutes: sum.minutes + row.minutes }), { pieces: 0, minutes: 0 })), entries: rows.length, workers: new Set(rows.map(row => id(row.labourId))).size });
    const training = entries.filter(row => classify(row).isTraining), regular = entries.filter(row => !classify(row).isTraining);
    return {
      from: dayKey(from), to: dayKey(to), days, quantityKind: 'process-pieces', totals: { ...measure(total), entries: entries.length, workers: byWorker.size },
      trainingTotals: subtotal(training), regularTotals: subtotal(regular),
      trainingWorkers: [...byWorker.keys()].filter(key => training.some(row => id(row.labourId) === key)).map(key => ({ id: key, name: wm.get(key)?.name || 'Archived worker', ...subtotal(training.filter(row => id(row.labourId) === key)), ...schedules.get(key) })),
      entries: viewEntries(entries, workers, toys, processes, types, schedules).sort((a, b) => b.date.localeCompare(a.date) || new Date(b.createdAt) - new Date(a.createdAt)),
      trend: [...trend.values()].map(row => ({ date: row.date, ...measure(row), workers: row.workers.size })),
      workers: [...byWorker].map(([key, total]) => {
        const available = [...total.dates].reduce((sum, date) => { const row = dayRows.find(row => dayKey(row.date) === date && id(row.labourId) === key); return sum + (row?.availableMinutes ?? availableMinutesFor(wm.get(key), row)); }, 0);
        return { id: key, name: wm.get(key)?.name || 'Archived worker', gender: wm.get(key)?.gender || 'Male', ...measure(total), regular: subtotal(regular.filter(row => id(row.labourId) === key)), training: subtotal(training.filter(row => id(row.labourId) === key)), daysWorked: total.dates.size, loggedPercent: available ? Math.round(total.minutes / available * 100) : null };
      }).sort((a, b) => b.pieces - a.pieces),
      toys: [...byToy].map(([key, total]) => ({ id: key, name: tm.get(key)?.name || 'Archived toy', ...measure(total) })).sort((a, b) => b.pieces - a.pieces),
      processes: [...byProcess].map(([key, total]) => ({ id: key, name: pm.get(key)?.name || 'Archived process', toyId: id(pm.get(key)?.toyId), toyName: tm.get(id(pm.get(key)?.toyId))?.name || 'Archived toy', ...measure(total) })).sort((a, b) => b.pieces - a.pieces),
      records, recordBoard, flags, todayFlags: flags.filter(row => row.date === dayKey(to)).length, processCount: byProcess.size
    };
  }));
  router.get('/history', auth, read, handle(async req => {
    const limit = req.query.limit === undefined ? 60 : Number(req.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('History limit must be between 1 and 200.');
    const filter = {};
    if (req.query.from || req.query.to) filter.at = { ...(req.query.from ? { $gte: dayStart(req.query.from) } : {}), ...(req.query.to ? { $lte: dayEnd(req.query.to) } : {}) };
    const rows = await ProductionLog.find(filter);
    return { history: rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit).map(row => ({ id: id(row), action: row.action, summary: row.summary, byName: row.byName, at: row.at, entryId: row.entryId || '', before: row.before, after: row.after })) };
  }));
  return router;
}
module.exports = createProductionRouter();
module.exports.createProductionRouter = createProductionRouter;
module.exports.SHIFTS = rules.SHIFTS;
module.exports.availableMinutesFor = availableMinutesFor;
