const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createOperationsRouter } = require('../operations-routes');

const SECRET = 'isolated-operations-test-secret';
const clone = value => structuredClone(value);

/** A store that behaves enough like the real models for these routes. */
function fixture() {
  const data = {
    User: [
      { _id: 'owner', name: 'MD', role: 'owner', isActive: true },
      { _id: 'ramya', name: 'Ramya', role: 'staff', isActive: true },
      { _id: 'preeti', name: 'Preeti', role: 'staff', isActive: true },
      { _id: 'deepa', name: 'Deepa', role: 'staff', isActive: true },
      { _id: 'gone', name: 'Left Us', role: 'staff', isActive: false }
    ],
    Operation: []
  };
  let seq = 0;
  // The routes mutate the document they were handed and then call save(), so
  // save has to write back that same object, not the copy it was built from.
  const doc = (name, row) => {
    const self = {
      ...row,
      save: async () => {
        const { save, ...rest } = self;
        const index = data[name].findIndex(item => item._id === self._id);
        data[name][index] = clone(rest);
        return self;
      }
    };
    return self;
  };
  const model = name => ({
    find: async () => clone(data[name]),
    findById: async key => {
      const row = data[name].find(item => item._id === key);
      if (!row) return null;
      return name === 'User' ? { ...clone(row), select: () => ({ ...clone(row) }) } : doc(name, clone(row));
    },
    create: async payload => {
      const row = { _id: `op-${++seq}`, ...clone(payload) };
      data[name].push(row);
      return clone(row);
    },
    deleteOne: async where => {
      const index = data[name].findIndex(item => item._id === where._id);
      if (index >= 0) data[name].splice(index, 1);
    }
  });
  // The router both awaits findById directly and chains .select('-password'),
  // so this stands in for a Mongoose query: awaitable, and chainable.
  const query = row => ({
    select: () => query(row),
    then: (resolve, reject) => Promise.resolve(row ? clone(row) : null).then(resolve, reject)
  });
  const User = { ...model('User'), findById: key => query(data.User.find(item => item._id === key)) };
  return { data, models: { User, Operation: model('Operation') } };
}

async function setup(t) {
  const store = fixture();
  const app = express();
  app.use(express.json());
  app.use('/api/operations', createOperationsRouter({
    models: store.models,
    resolveAccess: async user => ({ isActive: user.isActive !== false }),
    jwtSecret: SECRET
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (who, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/operations${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${jwt.sign({ id: who }, SECRET)}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { ...store, request };
}

test('the MD hands work out and the first hand-out starts the trail', async t => {
  const { request } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: '  Meta scrap payment follow-up  ', assignedTo: 'ramya', urgent: true, nextFollowup: '2026-10-20' });

  assert.equal(made.status, 200);
  assert.equal(made.body.title, 'Meta scrap payment follow-up');
  assert.equal(made.body.assignedToName, 'Ramya');
  assert.equal(made.body.urgent, true);
  assert.equal(made.body.status, 'open');
  // The trail starts at the MD, so the page can always say where work began.
  assert.equal(made.body.assignments.length, 1);
  assert.equal(made.body.assignments[0].fromName, 'MD');
  assert.equal(made.body.assignments[0].toName, 'Ramya');
  assert.equal(made.body.assignments[0].fromRole, 'owner');

  // Staff cannot hand work out, and the work needs a name and a taker.
  assert.equal((await request('ramya', 'POST', '/', { title: 'Mine now', assignedTo: 'preeti' })).status, 403);
  for (const bad of [{ title: '', assignedTo: 'ramya' }, { title: 'No taker' }, { title: 'Gone', assignedTo: 'gone' }]) {
    assert.equal((await request('owner', 'POST', '/', bad)).status, 400, JSON.stringify(bad));
  }
});

test('whoever holds the work can hand it on, with a reason, and the trail grows', async t => {
  const { request } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: 'Scrap follow-up', assignedTo: 'ramya' });
  const path = `/${made.body._id}/reassign`;

  // Somebody who is not holding it cannot move it.
  assert.equal((await request('preeti', 'POST', path, { to: 'deepa', reason: 'not mine' })).status, 403);
  // A reason is not optional, and it has to go to somebody else.
  assert.equal((await request('ramya', 'POST', path, { to: 'preeti' })).status, 400);
  assert.equal((await request('ramya', 'POST', path, { to: 'ramya', reason: 'myself' })).status, 400);

  const moved = await request('ramya', 'POST', path, { to: 'preeti', reason: 'Four days of load already' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.assignedToName, 'Preeti');
  assert.equal(moved.body.assignments.length, 2);
  assert.equal(moved.body.assignments[1].fromName, 'Ramya');
  assert.equal(moved.body.assignments[1].reason, 'Four days of load already');
  // Each hop starts where the one before it ended.
  assert.equal(moved.body.assignments[0].to, moved.body.assignments[1].from);

  // The MD can move it too, even though it is not with them.
  const again = await request('owner', 'POST', path, { to: 'deepa', reason: 'Preeti is on leave' });
  assert.equal(again.body.assignments.length, 3);
  assert.equal(again.body.assignedToName, 'Deepa');
});

test('everyone sees their own work and the work they passed on, nobody else', async t => {
  const { request } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: 'Travelling job', assignedTo: 'ramya' });
  await request('owner', 'POST', '/', { title: 'Deepa only', assignedTo: 'deepa' });
  await request('ramya', 'POST', `/${made.body._id}/reassign`, { to: 'preeti', reason: 'Too loaded' });

  const titles = who => request(who, 'GET', '/').then(res => res.body.map(row => row.title).sort());
  assert.deepEqual(await titles('owner'), ['Deepa only', 'Travelling job']);
  // Ramya let it go but still watches it; Preeti holds it; Deepa sees only hers.
  assert.deepEqual(await titles('ramya'), ['Travelling job']);
  assert.deepEqual(await titles('preeti'), ['Travelling job']);
  assert.deepEqual(await titles('deepa'), ['Deepa only']);

  // The people an operation can be handed to never include the MD.
  const staff = await request('ramya', 'GET', '/staff');
  assert.deepEqual(staff.body.map(row => row.name), ['Deepa', 'Preeti', 'Ramya']);
});

test('finishing, flagging and removing follow who is allowed to do them', async t => {
  const { request, data } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: 'Finish me', assignedTo: 'ramya' });
  const path = `/${made.body._id}`;

  // The holder can raise the flag and close the work; a bystander cannot.
  assert.equal((await request('deepa', 'PUT', path, { urgent: true })).status, 403);
  assert.equal((await request('ramya', 'PUT', path, { urgent: true })).body.urgent, true);
  const done = await request('ramya', 'PUT', path, { status: 'done' });
  assert.equal(done.body.status, 'done');
  assert.equal(done.body.doneByName, 'Ramya');
  assert.ok(done.body.doneAt);
  // Finished work cannot be handed on, and reopening clears who finished it.
  assert.equal((await request('ramya', 'POST', `${path}/reassign`, { to: 'preeti', reason: 'late' })).status, 400);
  const reopened = await request('owner', 'PUT', path, { status: 'open' });
  assert.equal(reopened.body.doneByName, '');
  assert.equal(reopened.body.doneAt, null);
  // Only the MD rewrites what the work is, and only the MD removes it.
  assert.equal((await request('ramya', 'PUT', path, { title: 'Renamed by staff' })).body.title, 'Finish me');
  assert.equal((await request('ramya', 'DELETE', path)).status, 403);
  assert.equal((await request('owner', 'DELETE', path)).status, 200);
  assert.equal(data.Operation.length, 0);
});
