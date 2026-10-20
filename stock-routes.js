const express = require('express');
const jwt = require('jsonwebtoken');
const { resolveUserAccess } = require('./access-control');

/* ------------------------------------------------------------------
   Stock: the shelf, what comes in, and what the floor spends.

   Three things, and they stay apart on purpose:

     items   — a part, a screw or packing material, with its opening figure
     recipe  — what one work step spends to make a piece ("1 box per 8 pcs")
     moves   — every movement, in or out, with what caused it

   A balance is never written anywhere. It is the opening figure plus the
   movements, so a production entry that is corrected or deleted can reverse
   its own movements and leave the shelf telling the truth.

     GET    /api/stock                 -> items with their balances
     GET    /api/stock/ledger/:itemId  -> one item's movements
     POST   /api/stock/items           -> add an item
     PUT    /api/stock/items/:id
     DELETE /api/stock/items/:id       -> archived, movements kept
     POST   /api/stock/inward          -> stock received
     POST   /api/stock/adjust          -> a counted correction
     GET    /api/stock/recipe          -> the whole map, or one work step's
     POST   /api/stock/recipe          -> map an item to a work step
     DELETE /api/stock/recipe/:id
   ------------------------------------------------------------------ */

function createStockRouter(options = {}) {
  const models = options.models || require('./models');
  const { StockItem, StockRecipe, StockMove, Toy, ToyProcess } = models;
  const resolveAccess = options.resolveAccess || resolveUserAccess;
  const JWT_SECRET = options.jwtSecret || process.env.JWT_SECRET || 'labour_management_super_secret_key_123';
  const transaction = options.transaction || (work => work());
  const router = express.Router();

  const auth = async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ message: 'Authorization token required' });
      const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
      const user = await models.User.findById(decoded.id).select('-password');
      if (!user) return res.status(401).json({ message: 'User not found' });
      const access = await resolveAccess(user).catch(() => ({ isActive: true, permissions: [] }));
      if (access.isActive === false) return res.status(403).json({ message: 'This account is switched off.' });
      req.user = user;
      req.access = access;
      next();
    } catch {
      return res.status(401).json({ message: 'Invalid token' });
    }
  };

  /**
   * Who may look, and who may change.
   *
   * Stock sits with production: whoever records what the floor made is the
   * person who knows what it spent, so the same permissions carry over.
   */
  const held = req => req.access?.permissions || [];
  const allow = (...permissions) => (req, res, next) => {
    if (req.user.role === 'owner') return next();
    const mine = held(req);
    if (mine.includes('*') || permissions.some(permission => mine.includes(permission))) return next();
    return res.status(403).json({ message: 'You do not have access to stock. Ask the MD for permission.' });
  };
  const canRead = allow('production.reports', 'production.entry', 'production.masters');
  const canWrite = allow('production.entry', 'production.masters');
  const canMaster = allow('production.masters');

  const guard = (handler, mutation = false) => async (req, res) => {
    try {
      res.json(mutation ? await transaction(() => handler(req)) : await handler(req));
    } catch (error) {
      res.status(error.statusCode || 500).json({ message: error.message || 'That did not go through.' });
    }
  };
  const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
  const id = value => String(value?._id || value?.id || value || '');
  const plain = row => (row?.toObject ? row.toObject() : row);
  const number = (value, label, { min = 0 } = {}) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < min) fail(`${label} must be a number${min === 0 ? ' of zero or more' : ''}.`);
    return amount;
  };
  const day = value => {
    if (!value) return new Date();
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) fail('Date must use YYYY-MM-DD.');
    return date;
  };
  const dayKey = value => new Date(value).toISOString().slice(0, 10);

  /** Opening plus every movement: the only place a balance comes from. */
  const balances = async () => {
    const moves = await StockMove.find({});
    const total = new Map();
    for (const move of moves) {
      const key = id(move.itemId);
      const sums = total.get(key) || { inward: 0, production: 0, damage: 0, adjust: 0 };
      sums[move.reason] = (sums[move.reason] || 0) + Number(move.qty || 0);
      total.set(key, sums);
    }
    return total;
  };

  const itemView = (item, sums = {}) => {
    const row = plain(item);
    const inward = sums.inward || 0, production = sums.production || 0, damage = sums.damage || 0, adjust = sums.adjust || 0;
    return {
      ...row,
      _id: id(item),
      opening: Number(row.opening || 0),
      inward,
      // Spending is stored as a negative movement; the page reads better with
      // the figure the floor would say out loud.
      used: -production,
      damage: -damage,
      adjust,
      balance: Number(row.opening || 0) + inward + production + damage + adjust
    };
  };

  router.get('/', auth, canRead, guard(async () => {
    const [items, sums, toys] = await Promise.all([StockItem.find({}), balances(), Toy.find({})]);
    const toyName = new Map(toys.map(toy => [id(toy), toy.name]));
    return {
      items: items
        .filter(item => item.isActive !== false)
        .map(item => ({ ...itemView(item, sums.get(id(item))), toyName: toyName.get(id(item.toyId)) || '' }))
        .sort((a, b) => (a.toyName || '').localeCompare(b.toyName || '') || a.name.localeCompare(b.name))
    };
  }));

  router.get('/ledger/:itemId', auth, canRead, guard(async req => {
    const item = await StockItem.findById(req.params.itemId);
    if (!item) fail('That item was not found.', 404);
    const [moves, toys, processes] = await Promise.all([StockMove.find({ itemId: id(item) }), Toy.find({}), ToyProcess.find({})]);
    const toyName = new Map(toys.map(toy => [id(toy), toy.name]));
    const stepName = new Map(processes.map(step => [id(step), step.name]));
    const sums = (await balances()).get(id(item));
    return {
      item: itemView(item, sums),
      moves: moves
        .map(move => ({
          ...plain(move), _id: id(move), date: dayKey(move.date), qty: Number(move.qty || 0),
          toyName: toyName.get(id(move.toyId)) || '', processName: stepName.get(id(move.processId)) || ''
        }))
        .sort((a, b) => b.date.localeCompare(a.date) || new Date(b.createdAt) - new Date(a.createdAt))
    };
  }));

  const readItem = (body, previous = {}) => {
    const name = String(body.name ?? previous.name ?? '').trim();
    if (!name) fail('The item needs a name.');
    const kind = String(body.kind ?? previous.kind ?? 'part');
    if (!['part', 'screw', 'packing'].includes(kind)) fail('Kind must be part, screw or packing.');
    return {
      name: name.slice(0, 120),
      code: String(body.code ?? previous.code ?? '').trim().slice(0, 40),
      kind,
      unit: String(body.unit ?? previous.unit ?? 'pcs').trim().slice(0, 20) || 'pcs',
      toyId: id(body.toyId ?? previous.toyId ?? ''),
      opening: number(body.opening ?? previous.opening ?? 0, 'Opening stock'),
      minLevel: number(body.minLevel ?? previous.minLevel ?? 0, 'Minimum level')
    };
  };

  router.post('/items', auth, canMaster, guard(async req => {
    const data = readItem(req.body || {});
    if (data.toyId) {
      const toy = await Toy.findById(data.toyId);
      if (!toy) fail('That toy was not found.');
    }
    // One code, one item: two rows sharing a code cannot be told apart later.
    if (data.code) {
      const clash = (await StockItem.find({})).find(item => item.isActive !== false && String(item.code || '').trim().toLowerCase() === data.code.toLowerCase());
      if (clash) fail(`Code ${data.code} already belongs to ${clash.name}.`);
    }
    const created = await StockItem.create({ ...data, isActive: true, createdAt: new Date() });
    return itemView(created);
  }, true));

  router.put('/items/:id', auth, canMaster, guard(async req => {
    const before = await StockItem.findById(req.params.id);
    if (!before) fail('That item was not found.', 404);
    const data = readItem(req.body || {}, plain(before));
    if (data.code) {
      const clash = (await StockItem.find({})).find(item => id(item) !== id(before) && item.isActive !== false
        && String(item.code || '').trim().toLowerCase() === data.code.toLowerCase());
      if (clash) fail(`Code ${data.code} already belongs to ${clash.name}.`);
    }
    const after = await StockItem.findByIdAndUpdate(id(before), data, { new: true });
    return itemView(after, (await balances()).get(id(before)));
  }, true));

  router.delete('/items/:id', auth, canMaster, guard(async req => {
    const before = await StockItem.findById(req.params.id);
    if (!before) fail('That item was not found.', 404);
    // Archived, never deleted: its movements are part of what the shelf did.
    await StockItem.findByIdAndUpdate(id(before), { isActive: false }, { new: true });
    return { ok: true };
  }, true));

  const move = async (req, { itemId, qty, reason, note, date, entryId = '', toyId = '', processId = '', pieces = 0 }) => StockMove.create({
    date: date || new Date(), itemId, qty, reason, entryId, toyId, processId, pieces,
    note: String(note || '').slice(0, 200), byName: req.user.name || '', createdAt: new Date()
  });

  router.post('/inward', auth, canWrite, guard(async req => {
    const body = req.body || {};
    const item = await StockItem.findById(id(body.itemId));
    if (!item || item.isActive === false) fail('Choose the item that came in.');
    const qty = number(body.qty, 'Quantity');
    if (!qty) fail('Quantity must be more than zero.');
    const created = await move(req, { itemId: id(item), qty, reason: 'inward', note: body.note, date: day(body.date) });
    return { ...plain(created), _id: id(created), date: dayKey(created.date) };
  }, true));

  /**
   * A counted correction.
   *
   * The shelf and the record drift apart; this records the difference as its
   * own movement rather than quietly rewriting the opening figure, so the
   * ledger still explains how the balance got where it is.
   */
  router.post('/adjust', auth, canMaster, guard(async req => {
    const body = req.body || {};
    const item = await StockItem.findById(id(body.itemId));
    if (!item || item.isActive === false) fail('Choose the item you counted.');
    const counted = number(body.counted, 'Counted stock');
    const sums = (await balances()).get(id(item));
    const now = itemView(item, sums).balance;
    const difference = counted - now;
    if (!difference) return { ok: true, difference: 0, balance: now };
    const note = String(body.note || '').trim() || `Counted ${counted}, record said ${now}`;
    await move(req, { itemId: id(item), qty: difference, reason: 'adjust', note, date: day(body.date) });
    return { ok: true, difference, balance: counted };
  }, true));

  router.get('/recipe', auth, canRead, guard(async req => {
    const [rows, items, toys, processes] = await Promise.all([StockRecipe.find({}), StockItem.find({}), Toy.find({}), ToyProcess.find({})]);
    const itemById = new Map(items.map(item => [id(item), item]));
    const toyName = new Map(toys.map(toy => [id(toy), toy.name]));
    const stepName = new Map(processes.map(step => [id(step), step.name]));
    const wanted = { toyId: id(req.query.toyId || ''), processId: id(req.query.processId || '') };
    return {
      recipe: rows
        .filter(row => (!wanted.toyId || id(row.toyId) === wanted.toyId) && (!wanted.processId || id(row.processId) === wanted.processId))
        .map(row => {
          const item = itemById.get(id(row.itemId));
          return {
            ...plain(row), _id: id(row),
            itemName: item?.name || 'Archived item', itemCode: item?.code || '', unit: item?.unit || 'pcs',
            toyName: toyName.get(id(row.toyId)) || 'Archived toy', processName: stepName.get(id(row.processId)) || 'Archived work step'
          };
        })
        .sort((a, b) => a.toyName.localeCompare(b.toyName) || a.processName.localeCompare(b.processName) || a.itemName.localeCompare(b.itemName))
    };
  }));

  router.post('/recipe', auth, canMaster, guard(async req => {
    const body = req.body || {};
    const [toy, step, item] = await Promise.all([
      Toy.findById(id(body.toyId)), ToyProcess.findById(id(body.processId)), StockItem.findById(id(body.itemId))
    ]);
    if (!toy) fail('Choose the toy.');
    if (!step) fail('Choose the work step.');
    if (id(step.toyId) !== id(toy)) fail('That work step belongs to another toy.');
    if (!item || item.isActive === false) fail('Choose the item it spends.');
    const qty = number(body.qty, 'Quantity', { min: 0 });
    const per = number(body.per ?? 1, 'Per pieces');
    if (!qty) fail('Quantity must be more than zero.');
    if (!per) fail('"Per pieces" must be more than zero.');
    // One line per item on a step: two lines for the same item would both be
    // applied, and the shelf would fall by double.
    const clash = (await StockRecipe.find({})).find(row => id(row.toyId) === id(toy) && id(row.processId) === id(step) && id(row.itemId) === id(item));
    if (clash) {
      const updated = await StockRecipe.findByIdAndUpdate(id(clash), { qty, per, note: String(body.note || '').slice(0, 200) }, { new: true });
      return { ...plain(updated), _id: id(updated), replaced: true };
    }
    const created = await StockRecipe.create({
      toyId: id(toy), processId: id(step), itemId: id(item), qty, per,
      note: String(body.note || '').slice(0, 200), createdAt: new Date()
    });
    return { ...plain(created), _id: id(created) };
  }, true));

  router.delete('/recipe/:id', auth, canMaster, guard(async req => {
    const row = await StockRecipe.findById(req.params.id);
    if (!row) fail('That line was not found.', 404);
    await StockRecipe.deleteOne({ _id: id(row) });
    return { ok: true };
  }, true));

  return router;
}

module.exports = createStockRouter();
module.exports.createStockRouter = createStockRouter;
