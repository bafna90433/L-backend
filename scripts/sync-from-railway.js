require('dotenv').config();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { connectDatabase } = require('../database');
const { User, Labour, ToyType, Toy, ToyProcess, ProductionEntry, DamagePart, DamageEntry } = require('../models');

async function sync() {
  await connectDatabase();
  console.log('Connected to local MongoDB.');

  const user = await User.findOne({ role: 'owner' });
  if (!user) throw new Error('Owner user not found');
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET);

  console.log('Fetching masters from Railway...');
  const mastersRes = await fetch('https://l-backend-production-ff32.up.railway.app/api/production/masters', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!mastersRes.ok) throw new Error(`Masters fetch failed: ${mastersRes.status}`);
  const masters = await mastersRes.json();

  console.log(`Fetched: ${masters.types.length} types, ${masters.toys.length} toys, ${masters.processes.length} processes, ${masters.workers.length} workers.`);

  // 1. Sync Types
  const typeIdMap = new Map();
  for (const t of masters.types) {
    let doc = await ToyType.findOne({ name: t.name });
    if (!doc) {
      doc = await ToyType.create({ name: t.name, sortOrder: t.sortOrder || 0 });
    }
    typeIdMap.set(t.id, doc._id);
  }
  console.log('Types synced.');

  // 2. Sync Toys
  const toyIdMap = new Map();
  for (const toy of masters.toys) {
    const localTypeId = typeIdMap.get(toy.typeId) || (await ToyType.findOne({}))?._id;
    let doc = await Toy.findOne({ name: toy.name });
    if (!doc) {
      doc = await Toy.create({
        typeId: localTypeId,
        name: toy.name,
        code: toy.code || '',
        sortOrder: toy.sortOrder || 0,
        isActive: true
      });
    } else {
      doc.typeId = localTypeId;
      doc.code = toy.code || '';
      doc.sortOrder = toy.sortOrder || 0;
      doc.isActive = true;
      await doc.save();
    }
    toyIdMap.set(toy.id, doc._id);
  }
  console.log('Toys synced.');

  // 3. Sync Processes
  const processIdMap = new Map();
  for (const proc of masters.processes) {
    const localToyId = toyIdMap.get(proc.toyId);
    if (!localToyId) continue;
    let doc = await ToyProcess.findOne({ toyId: localToyId, name: proc.name });
    if (!doc) {
      doc = await ToyProcess.create({
        toyId: localToyId,
        name: proc.name,
        targetPerHour: proc.targetPerHour || 0,
        target8h: proc.target8h || 0,
        target12h: proc.target12h || 0,
        sortOrder: proc.sortOrder || 0,
        isActive: true
      });
    } else {
      doc.targetPerHour = proc.targetPerHour || 0;
      doc.target8h = proc.target8h || 0;
      doc.target12h = proc.target12h || 0;
      doc.sortOrder = proc.sortOrder || 0;
      doc.isActive = true;
      await doc.save();
    }
    processIdMap.set(proc.id, doc._id);
  }
  console.log('Processes synced with targets.');

  // 4. Sync Workers
  const workerIdMap = new Map();
  for (const w of masters.workers) {
    let doc = await Labour.findOne({ name: w.name });
    if (!doc) {
      doc = await Labour.create({
        name: w.name,
        gender: w.gender || 'Male',
        department: w.department || 'Production',
        empCode: w.empCode || '',
        status: 'active',
        employeeType: 'labourer',
        whatsapp: '',
        monthlySalary: 0
      });
    }
    workerIdMap.set(w.id, doc._id);
  }
  console.log('Workers synced.');

  // 5. Sync Damage Parts
  const partIdMap = new Map();
  if (Array.isArray(masters.damageParts)) {
    for (const p of masters.damageParts) {
      const localToyId = toyIdMap.get(p.toyId);
      let doc = await DamagePart.findOne({ name: p.name, toyId: localToyId });
      if (!doc) {
        doc = await DamagePart.create({
          name: p.name,
          toyId: localToyId,
          isActive: true
        });
      }
      partIdMap.set(p.id, doc._id);
    }
    console.log('Damage parts synced.');
  }

  // 6. Sync Report Entries
  console.log('Fetching report entries from Railway...');
  const reportRes = await fetch('https://l-backend-production-ff32.up.railway.app/api/production/report?days=365', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (reportRes.ok) {
    const reportData = await reportRes.json();
    const entries = reportData.entries || [];
    console.log(`Syncing ${entries.length} production entries...`);

    for (const e of entries) {
      const localLabourId = workerIdMap.get(e.labourId) || (await Labour.findOne({ name: e.workerName }))?._id;
      const localToyId = toyIdMap.get(e.toyId) || (await Toy.findOne({ name: e.toyName }))?._id;
      const localProcId = processIdMap.get(e.processId) || (await ToyProcess.findOne({ toyId: localToyId, name: e.processName }))?._id;

      if (!localLabourId || !localToyId || !localProcId) {
        continue;
      }

      const existing = await ProductionEntry.findOne({
        labourId: localLabourId,
        date: new Date(e.date),
        toyId: localToyId,
        processId: localProcId,
        pieces: e.pieces
      });

      if (!existing) {
        await ProductionEntry.create({
          date: new Date(e.date),
          labourId: localLabourId,
          toyId: localToyId,
          processId: localProcId,
          minutes: e.minutes,
          pieces: e.pieces,
          workType: e.workType || 'regular',
          note: e.note || '',
          enteredByName: e.enteredByName || '',
          createdAt: new Date(e.createdAt || Date.now())
        });
      }
    }
    console.log('Production entries synced.');
  }

  // 7. Sync Damage Entries
  console.log('Fetching damage entries from Railway...');
  const damageRes = await fetch('https://l-backend-production-ff32.up.railway.app/api/production/damage?from=2026-01-01&to=2026-12-31', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (damageRes.ok) {
    const damageData = await damageRes.json();
    const rows = damageData.entries || [];
    console.log(`Syncing ${rows.length} damage entries...`);
    for (const d of rows) {
      const localToyId = (await Toy.findOne({ name: d.toyName }))?._id;
      const localPartId = partIdMap.get(d.partId) || (await DamagePart.findOne({ name: d.partName }))?._id;

      const existing = await DamageEntry.findOne({
        date: new Date(d.date),
        toyName: d.toyName,
        qty: d.qty
      });
      if (!existing) {
        await DamageEntry.create({
          date: new Date(d.date),
          toyName: d.toyName,
          partId: localPartId,
          partName: d.partName,
          qty: d.qty,
          enteredByName: d.enteredByName || ''
        });
      }
    }
    console.log('Damage entries synced.');
  }

  console.log('ALL DATA SYNCED SUCCESSFULLY FROM RAILWAY TO LOCAL MONGODB!');
  process.exit(0);
}

sync().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
