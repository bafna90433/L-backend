const express = require('express');
const jwt = require('jsonwebtoken');
const { resolveUserAccess } = require('./access-control');



/* ------------------------------------------------------------------
   Operations: work the MD hands out and then follows.

   This is not the task list. A task is the office's own checklist; an
   operation is a piece of work the MD wants to watch travel — it starts with
   one person, and when that person is already loaded they pass it on with a
   reason. Nothing is overwritten: the holder moves, and the hop is written to
   the trail, so the MD can see where a piece of work has been and why.

     GET    /api/operations            -> the MD sees all; staff see their own
     GET    /api/operations/staff      -> who an operation can be handed to
     POST   /api/operations            -> the MD hands work out
     POST   /api/operations/:id/reassign -> hand it on, with a reason
     PUT    /api/operations/:id        -> urgent, follow-up, done, details
     DELETE /api/operations/:id        -> the MD removes one
   ------------------------------------------------------------------ */

/**
 * Built as a factory so the routes can be exercised against a fixture store in
 * the tests, the way the production router is.
 */
function createOperationsRouter(options = {}) {
  const { User, Operation } = options.models || require('./models');
  const resolveAccess = options.resolveAccess || resolveUserAccess;
  const JWT_SECRET = options.jwtSecret || process.env.JWT_SECRET || 'labour_management_super_secret_key_123';
  const router = express.Router();

  const auth = async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Authorization token required' });
      }
      const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      if (!user) return res.status(401).json({ message: 'User not found' });
      const access = await resolveAccess(user).catch(() => ({ isActive: true }));
      if (access.isActive === false) return res.status(403).json({ message: 'This account is switched off.' });
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ message: 'Invalid token' });
    }
  };

  const ownerOnly = (req, res, next) => req.user.role === 'owner'
    ? next()
    : res.status(403).json({ message: 'Only the MD can do that.' });

  const guard = handler => async (req, res) => {
    try {
      const result = await handler(req);
      res.json(result);
    } catch (error) {
      res.status(error.statusCode || 500).json({ message: error.message || 'That did not go through.' });
    }
  };
  const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
  const id = value => String(value?._id || value?.id || value || '');
  const plain = row => (row?.toObject ? row.toObject() : row);
  const view = (row, names = new Map()) => {
    const source = plain(row);
    // A name written into a record is what the person was called that day. The
    // account is the live answer, so it wins while it exists; the written copy
    // is the fallback for somebody who has since left.
    const now = (key, written) => names.get(String(key || '')) || written || '';
    return {
      ...source,
      _id: id(row),
      assignedToName: now(source.assignedTo, source.assignedToName),
      createdByName: now(source.createdBy, source.createdByName),
      doneByName: now(source.doneBy, source.doneByName),
      doneRequestedByName: now(source.doneRequestedBy, source.doneRequestedByName),
      assignments: (source.assignments || []).map(hop => ({
        ...hop,
        fromName: now(hop.from, hop.fromName),
        toName: now(hop.to, hop.toName),
        byName: now(hop.by, hop.byName)
      })),
      messages: (source.messages || []).map(line => ({ ...line, byName: now(line.by, line.byName) }))
    };
  };
  /**
   * What each person is called, by id — one read, however many rows it covers.
   *
   * The MD's login is usually left with the name it was set up with, "Owner
   * Admin", but nobody in the factory calls them that. So an owner account
   * still carrying a set-up name is shown as MD; an owner who has been given a
   * real name keeps it, and everyone else is simply their own name.
   */
  const shownName = user => {
    const name = String(user.name || '').trim();
    if (user.role !== 'owner') return name;
    return !name || /owner|admin/i.test(name) ? 'MD' : name;
  };
  const currentNames = async () => new Map((await User.find({})).map(user => [id(user), shownName(user)]));

  /** Everyone still working here, minus the MD, who hands work out rather than taking it. */
  const staffList = async () => {
    const users = await User.find({});
    return users
      .filter(user => user.isActive !== false && user.role !== 'owner')
      .map(user => ({ _id: id(user), name: user.name, role: user.role }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  /**
   * What a person is allowed to see.
   *
   * Work assigned to you is yours to see without any extra permission, and so is
   * work you passed on — you handed it over, so you should be able to watch
   * whether it got done.
   */
  const visible = (row, me) => id(row.assignedTo) === me || (row.assignments || []).some(hop => String(hop.from) === me);

  router.get('/', auth, guard(async req => {
    const names = await currentNames();
    const rows = (await Operation.find({})).map(row => view(row, names));
    const mine = req.user.role === 'owner' ? rows : rows.filter(row => visible(row, id(req.user)));
    return mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }));

  router.get('/staff', auth, guard(async () => staffList()));

  router.post('/', auth, ownerOnly, guard(async req => {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    if (!title) fail('Write what the work is.');
    const to = id(body.assignedTo);
    if (!to) fail('Choose who it goes to.');
    const taker = await User.findById(to);
    if (!taker || taker.isActive === false) fail('That staff member was not found.');

    const now = new Date();
    const created = await Operation.create({
      title: title.slice(0, 200),
      details: String(body.details || '').trim().slice(0, 1000),
      urgent: Boolean(body.urgent),
      status: 'open',
      assignedTo: id(taker),
      assignedToName: taker.name || '',
      // The first hand-out is the first link of the trail; without it the page
      // could say where a piece of work went but never where it started.
      assignments: [{
        from: id(req.user), fromName: req.user.name || '', fromRole: 'owner',
        to: id(taker), toName: taker.name || '', reason: 'First assignment', at: now
      }],
      nextFollowup: String(body.nextFollowup || '').trim().slice(0, 40),
    doneRequestedBy: '',
    doneRequestedByName: '',
    doneRequestedAt: null,
      createdBy: id(req.user),
      createdByName: req.user.name || '',
      createdAt: now
    });
    return view(created, await currentNames());
  }));

  /**
   * Handing the work on.
   *
   * The MD gives it out, and the person it lands on may pass it to one other
   * person when their own load is too heavy. There it stops: the second holder
   * does the work rather than passing it round, so a job cannot travel the
   * floor. The MD is not bound by that and can move it at any time.
   */
  router.post('/:id/reassign', auth, guard(async req => {
    const row = await Operation.findById(req.params.id);
    if (!row) fail('That operation was not found.', 404);
    if (row.status === 'done') fail('This work is already finished, so it cannot be handed over.');

    const isOwner = req.user.role === 'owner';
    const holder = id(row.assignedTo);
    // The first hop is the MD handing it out; a second one is the one handover
    // the floor is allowed.
    const alreadyPassedOn = (row.assignments || []).length > 1;
    if (!isOwner) {
      if (holder !== id(req.user)) fail('Only the person holding this work can hand it over.', 403);
      if (alreadyPassedOn) fail('This work has already been handed over once. Ask the MD to move it again.', 403);
    }
    const reason = String(req.body?.reason || '').trim();
    if (!reason) fail('Say why you are handing this over.');
    const to = id(req.body?.to);
    if (!to) fail('Choose who takes it.');
    if (to === holder) fail('It is already with them.');
    const taker = await User.findById(to);
    if (!taker || taker.isActive === false) fail('That staff member was not found.');

    row.assignments = [...(row.assignments || []), {
      // Where it came from is the person who had it, not whoever signed the
      // move: that is what keeps the trail a chain.
      from: holder, fromName: row.assignedToName || '', fromRole: 'staff',
      by: id(req.user), byName: shownName(req.user), byRole: isOwner ? 'owner' : 'staff',
      to: id(taker), toName: taker.name || '', reason: reason.slice(0, 300), at: new Date()
    }];
    row.assignedTo = id(taker);
    row.assignedToName = taker.name || '';
    await row.save();
    return view(row, await currentNames());
  }));

  /**
   * A line in the conversation on this work.
   *
   * Anyone who has held it may write — including whoever handed it on, since
   * they usually know what was already tried — and so may the MD, who reads
   * the same thread rather than asking for a report.
   */
  router.post('/:id/message', auth, guard(async req => {
    const row = await Operation.findById(req.params.id);
    if (!row) fail('That operation was not found.', 404);
    if (req.user.role !== 'owner' && !visible(plain(row), id(req.user))) fail('This work is not yours to write on.', 403);

    const text = String(req.body?.text || '').trim();
    if (!text) fail('Write something first.');

    row.messages = [...(row.messages || []), {
      by: id(req.user), byName: req.user.name || '', byRole: req.user.role === 'owner' ? 'owner' : 'staff',
      text: text.slice(0, 1000), at: new Date()
    }];
    await row.save();
    return view(row, await currentNames());
  }));

  /**
   * "I have finished this."
   *
   * The person holding the work says so and the MD closes it, so the two are
   * never in doubt about who decided it was done. The word goes into the
   * conversation as well, because that is where the MD is already reading.
   */
  router.post('/:id/request-done', auth, guard(async req => {
    const row = await Operation.findById(req.params.id);
    if (!row) fail('That operation was not found.', 404);
    if (row.status === 'done') fail('This work is already closed.');
    if (id(row.assignedTo) !== id(req.user)) fail('Only the person holding this work can mark it done.', 403);

    const note = String(req.body?.note || '').trim();
    row.doneRequestedBy = id(req.user);
    row.doneRequestedByName = req.user.name || '';
    row.doneRequestedAt = new Date();
    row.messages = [...(row.messages || []), {
      by: id(req.user), byName: req.user.name || '', byRole: 'staff',
      text: note ? `Finished — ${note.slice(0, 900)}` : 'Finished. Waiting for the MD to close it.', at: new Date()
    }];
    await row.save();
    return view(row, await currentNames());
  }));

  router.put('/:id', auth, guard(async req => {
    const row = await Operation.findById(req.params.id);
    if (!row) fail('That operation was not found.', 404);

    const isOwner = req.user.role === 'owner';
    const holder = id(row.assignedTo);
    const involved = isOwner || holder === id(req.user);
    if (!involved) fail('This work is not yours to change.', 403);

    const body = req.body || {};
    // Anyone working the operation can raise the flag or move the follow-up;
    // only the MD rewrites what the work is.
    if (body.urgent !== undefined) row.urgent = Boolean(body.urgent);
    if (body.nextFollowup !== undefined) row.nextFollowup = String(body.nextFollowup).trim().slice(0, 40);
    if (body.details !== undefined) row.details = String(body.details).trim().slice(0, 1000);
    if (isOwner && body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) fail('The work needs a name.');
      row.title = title.slice(0, 200);
    }
    // The MD can wave away a claim that the work is finished without closing it.
    if (body.doneRequested === false) {
      row.doneRequestedBy = '';
      row.doneRequestedByName = '';
      row.doneRequestedAt = null;
    }
    if (body.status !== undefined) {
      const status = String(body.status);
      if (!['open', 'done'].includes(status)) fail('Status must be open or done.');
      if (status === 'done' && row.status !== 'done') {
        row.status = 'done';
        // Credit goes to whoever did the work, not to whoever signed it off.
        row.doneBy = row.doneRequestedBy || id(req.user);
        row.doneByName = row.doneRequestedByName || req.user.name || '';
        row.doneAt = new Date();
        row.doneRequestedBy = '';
        row.doneRequestedByName = '';
        row.doneRequestedAt = null;
      } else if (status === 'open' && row.status !== 'open') {
        row.status = 'open';
        row.doneBy = '';
        row.doneByName = '';
        row.doneAt = null;
      }
    }
    await row.save();
    return view(row, await currentNames());
  }));

  router.delete('/:id', auth, ownerOnly, guard(async req => {
    const row = await Operation.findById(req.params.id);
    if (!row) fail('That operation was not found.', 404);
    await Operation.deleteOne({ _id: req.params.id });
    return { ok: true };
  }));

  return router;
}

module.exports = createOperationsRouter();
module.exports.createOperationsRouter = createOperationsRouter;
