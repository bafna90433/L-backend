const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createStockRouter } = require('../stock-routes');

const SECRET = 'isolated-stock-test-secret';
const clone = value => structuredClone(value);

function fixture() {
  const data = {
    User: [
      { _id: 'owner', name: 'MD', role: 'owner', isActive: true, permissions: ['*'] },
      { _id: 'admin', name: 'Production Admin', role: 'production-admin', isActive: true, permissions: ['production.masters', 'production.entry', 'production.reports'] },
      { _id: 'supervisor', name: 'Floor Supervisor', role: 'production-supervisor', isActive: true, permissions: ['production.entry'] },
      { _id: 'office', name: 'Office', role: 'staff', isActive: true, permissions: [] }
    ],
    Toy: [{ _id: 'toy', name: 'Fighter jet', isActive: true }, { _id: 'toy2', name: 'Bird', isActive: true }],
    ToyProcess: [
      { _id: 'assemble', name: 'Body assemble', toyId: 'toy', isActive: true },
      { _id: 'packing', name: 'BOPP packing', toyId: 'toy', isActive: true },
      { _id: 'other', name: 'Wheel joint', toyId: 'toy2', isActive: true }
    ],
    StockItem: [], StockRecipe: [], StockMove: []
  };
  let seq = 0;
  const matches = (row, where) => Object.entries(where).every(([key, value]) => String(row[key] ?? '') === String(value ?? ''));
  const model = name => ({
    find: async (where = {}) => clone(data[name].filter(row => matches(row, where))),
    findById: async key => {
      const row = data[name].find(item => item._id === key);
      return row ? clone(row) : null;
    },
    create: async payload => { const row = { _id: `${name}-${++seq}`, ...clone(payload) }; data[name].push(row); return clone(row); },
    findByIdAndUpdate: async (key, update) => {
      const row = data[name].find(item => item._id === key);
      if (!row) return null;
      Object.assign(row, clone(update));
      return clone(row);
    },
    deleteOne: async where => { const at = data[name].findIndex(row => matches(row, where)); if (at >= 0) data[name].splice(at, 1); },
    deleteMany: async (where = {}) => { data[name] = data[name].filter(row => !matches(row, where)); }
  });
  const User = { findById: key => ({ select: async () => { const row = data.User.find(item => item._id === key); return row ? clone(row) : null; } }) };
  return { data, models: { ...Object.fromEntries(Object.keys(data).map(name => [name, model(name)])), User } };
}

async function setup(t) {
  const store = fixture();
  const app = express();
  app.use(express.json());
  app.use('/api/stock', createStockRouter({
    models: store.models,
    resolveAccess: async user => ({ isActive: user.isActive !== false, permissions: user.permissions || [] }),
    jwtSecret: SECRET
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (who, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stock${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${jwt.sign({ id: who }, SECRET)}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { ...store, request };
}

test('an item carries its opening figure and refuses a code somebody else has', async t => {
  const { request } = await setup(t);
  const made = await request('admin', 'POST', '/items', { name: '  Screw SC-2  ', code: ' sc-2 ', kind: 'screw', unit: 'pcs', opening: 10000, minLevel: 2000 });
  assert.equal(made.status, 200);
  assert.equal(made.body.name, 'Screw SC-2');
  assert.equal(made.body.code, 'sc-2');
  assert.equal(made.body.balance, 10000);

  // The code is what people read off the bin, so two items cannot share one.
  const clash = await request('admin', 'POST', '/items', { name: 'Another screw', code: 'SC-2' });
  assert.equal(clash.status, 400);
  assert.match(clash.body.message, /already belongs to Screw SC-2/);

  for (const bad of [{ name: '' }, { name: 'Odd', kind: 'gadget' }, { name: 'Odd', opening: -5 }]) {
    assert.equal((await request('admin', 'POST', '/items', bad)).status, 400, JSON.stringify(bad));
  }
  // The floor reads stock; only master data may add to it.
  assert.equal((await request('supervisor', 'POST', '/items', { name: 'Nope' })).status, 403);
  assert.equal((await request('supervisor', 'GET', '/')).status, 200);
  assert.equal((await request('office', 'GET', '/')).status, 403);
});

test('the balance is the opening figure plus every movement', async t => {
  const { request } = await setup(t);
  const item = await request('admin', 'POST', '/items', { name: 'Windup box', unit: 'box', opening: 500, toyId: 'toy' });
  const id = item.body._id;

  assert.equal((await request('supervisor', 'POST', '/inward', { itemId: id, qty: 1200, date: '2026-10-20', note: 'From Sharma' })).status, 200);
  assert.equal((await request('supervisor', 'POST', '/inward', { itemId: id, qty: 0 })).status, 400);

  const [row] = (await request('admin', 'GET', '/')).body.items;
  assert.equal(row.opening, 500);
  assert.equal(row.inward, 1200);
  assert.equal(row.balance, 1700);
  assert.equal(row.toyName, 'Fighter jet');

  // A count that disagrees with the record is written as its own movement,
  // so the ledger still explains the balance.
  const counted = await request('admin', 'POST', '/adjust', { itemId: id, counted: 1650, date: '2026-10-20' });
  assert.equal(counted.body.difference, -50);
  assert.equal(counted.body.balance, 1650);
  const ledger = await request('admin', 'GET', `/ledger/${id}`);
  assert.equal(ledger.body.item.balance, 1650);
  assert.deepEqual(ledger.body.moves.map(move => move.reason), ['adjust', 'inward']);
  assert.match(ledger.body.moves[0].note, /Counted 1650, record said 1700/);
  assert.equal(ledger.body.moves[1].byName, 'Floor Supervisor');
  // Counting it at what the record already says writes nothing.
  assert.equal((await request('admin', 'POST', '/adjust', { itemId: id, counted: 1650 })).body.difference, 0);
});

test('a recipe line belongs to one work step and is never doubled', async t => {
  const { request, data } = await setup(t);
  const screw = (await request('admin', 'POST', '/items', { name: 'Screw SC-2', code: 'SC-2', kind: 'screw' })).body._id;
  const box = (await request('admin', 'POST', '/items', { name: 'Windup box', unit: 'box', kind: 'packing' })).body._id;

  assert.equal((await request('admin', 'POST', '/recipe', { toyId: 'toy', processId: 'assemble', itemId: screw, qty: 8, per: 1 })).status, 200);
  // "One box per eight pieces", the way the floor says it.
  assert.equal((await request('admin', 'POST', '/recipe', { toyId: 'toy', processId: 'packing', itemId: box, qty: 1, per: 8 })).status, 200);

  // A work step from another toy does not belong to this one.
  assert.equal((await request('admin', 'POST', '/recipe', { toyId: 'toy', processId: 'other', itemId: screw, qty: 1 })).status, 400);
  for (const bad of [{ qty: 0 }, { per: 0 }]) {
    assert.equal((await request('admin', 'POST', '/recipe', { toyId: 'toy', processId: 'assemble', itemId: box, qty: 1, per: 1, ...bad })).status, 400, JSON.stringify(bad));
  }

  // Mapping the same item again corrects the line instead of adding a second.
  const again = await request('admin', 'POST', '/recipe', { toyId: 'toy', processId: 'assemble', itemId: screw, qty: 9, per: 1 });
  assert.equal(again.body.replaced, true);
  assert.equal(data.StockRecipe.filter(row => row.itemId === screw).length, 1);
  assert.equal(data.StockRecipe.find(row => row.itemId === screw).qty, 9);

  const forStep = await request('admin', 'GET', '/recipe?toyId=toy&processId=packing');
  assert.equal(forStep.body.recipe.length, 1);
  assert.equal(forStep.body.recipe[0].itemName, 'Windup box');
  assert.equal(forStep.body.recipe[0].processName, 'BOPP packing');
  assert.equal(forStep.body.recipe[0].per, 8);

  // A step can also put something on the shelf, and the line remembers which
  // way it goes — including when it is corrected later.
  const made = await request('admin', 'POST', '/recipe', { toyId: 'toy', processId: 'assemble', itemId: box, qty: 1, per: 1, makes: true });
  assert.equal(made.status, 200);
  assert.equal(made.body.makes, true);
  const fixed = await request('admin', 'POST', '/recipe', { toyId: 'toy', processId: 'assemble', itemId: box, qty: 2, per: 1, makes: true });
  assert.equal(fixed.body.replaced, true);
  assert.equal(fixed.body.makes, true);
  assert.equal((await request('admin', 'DELETE', `/recipe/${made.body._id}`)).status, 200);

  assert.equal((await request('admin', 'DELETE', `/recipe/${again.body._id}`)).status, 200);
  assert.equal(data.StockRecipe.length, 1);
});

test('an archived item leaves the list but keeps its movements', async t => {
  const { request, data } = await setup(t);
  const id = (await request('admin', 'POST', '/items', { name: 'Old part', opening: 10 })).body._id;
  await request('admin', 'POST', '/inward', { itemId: id, qty: 5 });
  assert.equal((await request('admin', 'DELETE', `/items/${id}`)).status, 200);
  assert.equal((await request('admin', 'GET', '/')).body.items.length, 0);
  assert.equal(data.StockMove.length, 1);
  assert.equal((await request('admin', 'GET', `/ledger/${id}`)).body.item.balance, 15);
});
