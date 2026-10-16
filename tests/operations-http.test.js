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
      { _id: 'owner', name: 'Owner Admin', role: 'owner', isActive: true },
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

test('work may be handed on once by the floor, and no further', async t => {
  const { request } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: 'Scrap follow-up', assignedTo: 'ramya' });
  const path = `/${made.body._id}/reassign`;

  // Not yours to move, and a reason is not optional.
  assert.equal((await request('preeti', 'POST', path, { to: 'deepa', reason: 'not mine' })).status, 403);
  assert.equal((await request('ramya', 'POST', path, { to: 'preeti' })).status, 400);
  assert.equal((await request('ramya', 'POST', path, { to: 'ramya', reason: 'already there' })).status, 400);

  // The person it landed on may pass it to one other person.
  const moved = await request('ramya', 'POST', path, { to: 'preeti', reason: 'Four days of load already' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.assignedToName, 'Preeti');
  assert.equal(moved.body.assignments.length, 2);
  assert.equal(moved.body.assignments[1].fromName, 'Ramya');
  assert.equal(moved.body.assignments[1].byRole, 'staff');
  assert.equal(moved.body.assignments[1].reason, 'Four days of load already');
  // Each hop starts where the one before it ended.
  assert.equal(moved.body.assignments[0].to, moved.body.assignments[1].from);

  // There it stops: the second holder does the work, they do not pass it round.
  const again = await request('preeti', 'POST', path, { to: 'deepa', reason: 'I am busy too' });
  assert.equal(again.status, 403);
  assert.match(again.body.message, /already been handed over once/i);

  // The MD is not bound by that.
  const byMD = await request('owner', 'POST', path, { to: 'deepa', reason: 'Preeti is on leave' });
  assert.equal(byMD.status, 200);
  assert.equal(byMD.body.assignments.length, 3);
  assert.equal(byMD.body.assignments[2].byName, 'MD');
  assert.equal(byMD.body.assignments[2].byRole, 'owner');
  assert.equal(byMD.body.assignments[2].fromName, 'Preeti');
});

test('the people on a piece of work talk on it, and the MD reads the same thread', async t => {
  const { request } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: 'Scrap follow-up', assignedTo: 'ramya' });
  const path = `/${made.body._id}/message`;
  await request('owner', 'POST', `/${made.body._id}/reassign`, { to: 'preeti', reason: 'load' });

  assert.equal((await request('preeti', 'POST', path, { text: '  Called them, no answer  ' })).status, 200);
  // Ramya handed it on but still knows the history, so she may still write.
  assert.equal((await request('ramya', 'POST', path, { text: 'Try the Chennai number' })).status, 200);
  const said = await request('owner', 'POST', path, { text: 'Close it by Friday' });
  assert.deepEqual(said.body.messages.map(line => line.text), ['Called them, no answer', 'Try the Chennai number', 'Close it by Friday']);
  assert.deepEqual(said.body.messages.map(line => line.byName), ['Preeti', 'Ramya', 'MD']);
  assert.equal(said.body.messages[2].byRole, 'owner');

  // Somebody with nothing to do with this work cannot read into it or write on it.
  assert.equal((await request('deepa', 'POST', path, { text: 'who, me?' })).status, 403);
  // And an empty line is not a message.
  assert.equal((await request('preeti', 'POST', path, { text: '   ' })).status, 400);
});

test('everyone sees their own work and the work they passed on, nobody else', async t => {
  const { request } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: 'Travelling job', assignedTo: 'ramya' });
  await request('owner', 'POST', '/', { title: 'Deepa only', assignedTo: 'deepa' });
  await request('ramya', 'POST', `/${made.body._id}/reassign`, { to: 'preeti', reason: 'Ramya is loaded' });

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
  // The follow-up date is the holder's to keep current, and the MD sees it.
  assert.equal((await request('ramya', 'PUT', path, { nextFollowup: '2026-10-24' })).body.nextFollowup, '2026-10-24');
  assert.equal((await request('owner', 'GET', '/')).body[0].nextFollowup, '2026-10-24');
  assert.equal((await request('ramya', 'PUT', path, { nextFollowup: '' })).body.nextFollowup, '');
  assert.equal((await request('deepa', 'PUT', path, { nextFollowup: '2026-11-01' })).status, 403);
  const done = await request('ramya', 'PUT', path, { status: 'done' });
  assert.equal(done.body.status, 'done');
  assert.equal(done.body.doneByName, 'Ramya');
  assert.ok(done.body.doneAt);
  // Finished work cannot be handed on, and reopening clears who finished it.
  assert.equal((await request('owner', 'POST', `${path}/reassign`, { to: 'preeti', reason: 'late' })).status, 400);
  const reopened = await request('owner', 'PUT', path, { status: 'open' });
  assert.equal(reopened.body.doneByName, '');
  assert.equal(reopened.body.doneAt, null);
  // Only the MD rewrites what the work is, and only the MD removes it.
  assert.equal((await request('ramya', 'PUT', path, { title: 'Renamed by staff' })).body.title, 'Finish me');
  assert.equal((await request('ramya', 'DELETE', path)).status, 403);
  assert.equal((await request('owner', 'DELETE', path)).status, 200);
  assert.equal(data.Operation.length, 0);
});

test('a renamed account reads by its new name everywhere, even on old records', async t => {
  const { request, data } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: 'Scrap follow-up', assignedTo: 'ramya' });
  await request('owner', 'POST', `/${made.body._id}/reassign`, { to: 'preeti', reason: 'Ramya is loaded' });
  await request('preeti', 'POST', `/${made.body._id}/message`, { text: 'On it' });
  // Written into the record at the time, the way the floor said it that day.
  assert.equal(made.body.assignments[0].fromName, 'MD');

  // The MD renames the account; nothing in the saved records is rewritten.
  data.User.find(user => user._id === 'owner').name = 'Managing Director';
  data.User.find(user => user._id === 'preeti').name = 'Preeti S';

  const [row] = (await request('owner', 'GET', '/')).body;
  assert.equal(row.assignments[0].fromName, 'Managing Director');
  assert.equal(row.assignments[1].byName, 'Managing Director');
  assert.equal(row.assignments[1].toName, 'Preeti S');
  assert.equal(row.assignedToName, 'Preeti S');
  assert.equal(row.messages[0].byName, 'Preeti S');
  // Somebody who has left keeps the name the record was written with.
  assert.equal(row.assignments[1].fromName, 'Ramya');
  data.User.splice(data.User.findIndex(user => user._id === 'ramya'), 1);
  const [gone] = (await request('owner', 'GET', '/')).body;
  assert.equal(gone.assignments[1].fromName, 'Ramya');
});

test('the MD reads as MD whatever the login was set up as', async t => {
  const { request, data } = await setup(t);
  // The account is still called "Owner Admin", which is nobody's name on the floor.
  const made = await request('owner', 'POST', '/', { title: 'Scrap follow-up', assignedTo: 'ramya' });
  assert.equal(made.body.assignments[0].fromName, 'MD');
  assert.equal(made.body.createdByName, 'MD');

  await request('owner', 'POST', `/${made.body._id}/message`, { text: 'Close it by Friday' });
  const [row] = (await request('ramya', 'GET', '/')).body;
  assert.equal(row.messages[0].byName, 'MD');

  // An owner given a real name keeps it — the rule only covers the set-up name.
  data.User.find(user => user._id === 'owner').name = 'Sir Bafna';
  const [renamed] = (await request('ramya', 'GET', '/')).body;
  assert.equal(renamed.assignments[0].fromName, 'Sir Bafna');
  assert.equal(renamed.messages[0].byName, 'Sir Bafna');
  // And staff names are never rewritten, whatever they contain.
  assert.equal(renamed.assignments[0].toName, 'Ramya');
});

test('the floor says the work is finished and the MD closes it', async t => {
  const { request } = await setup(t);
  const made = await request('owner', 'POST', '/', { title: 'Chase the pending payment', assignedTo: 'ramya' });
  const op = `/${made.body._id}`;

  // Only the person holding it can say it is finished.
  assert.equal((await request('preeti', 'POST', `${op}/request-done`, { note: 'paid' })).status, 403);

  const said = await request('ramya', 'POST', `${op}/request-done`, { note: 'Customer paid this morning' });
  assert.equal(said.status, 200);
  assert.equal(said.body.doneRequestedByName, 'Ramya');
  assert.ok(said.body.doneRequestedAt);
  // It is still open until the MD closes it, and the word is in the thread.
  assert.equal(said.body.status, 'open');
  assert.equal(said.body.messages.at(-1).text, 'Finished — Customer paid this morning');

  // The MD can wave the claim away without closing the work.
  const waved = await request('owner', 'PUT', op, { doneRequested: false });
  assert.equal(waved.body.doneRequestedByName, '');
  assert.equal(waved.body.status, 'open');

  // Or close it — and the credit stays with whoever did the work.
  await request('ramya', 'POST', `${op}/request-done`, {});
  const closed = await request('owner', 'PUT', op, { status: 'done' });
  assert.equal(closed.body.status, 'done');
  assert.equal(closed.body.doneByName, 'Ramya');
  assert.equal(closed.body.doneRequestedByName, '');
  assert.ok(closed.body.doneAt);
  // Closed work cannot be claimed finished again.
  assert.equal((await request('ramya', 'POST', `${op}/request-done`, {})).status, 400);
});
