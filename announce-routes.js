const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { User, SystemSettings } = require('./models');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

/* ------------------------------------------------------------------
   Announcement Bell — the MD rings, the staff PC plays their own tone.

   The push has to feel instant, so it rides a Server-Sent Events stream
   instead of the polling the rest of the app uses. A ring reaches an open
   Staff Desk in a few hundred milliseconds.

     POST /api/announce/ticket    -> short-lived ticket for the stream
     GET  /api/announce/stream    -> the SSE connection (ticket in query)
     GET  /api/announce/ringtones -> tone catalogue + per-staff choice
     PUT  /api/announce/ringtones -> MD saves who gets which tone
     POST /api/announce/ring      -> MD rings the selected staff
     POST /api/announce/ack       -> staff says "sun liya"
     GET  /api/announce/status    -> who is online + recent rings
   ------------------------------------------------------------------ */

/** Built-in tones. The browser synthesises these, so nothing has to download. */
const TONES = [
  { id: 'chime',    name: 'Office Chime',     hint: 'Soft two-note chime' },
  { id: 'bell',     name: 'Brass Bell',       hint: 'Classic reception bell' },
  { id: 'ping',     name: 'Sharp Ping',       hint: 'Short and bright' },
  { id: 'alert',    name: 'Alert Pulse',      hint: 'Repeating urgent beeps' },
  { id: 'arcade',   name: 'Rising Arcade',    hint: 'Playful upward run' },
  { id: 'digital',  name: 'Digital Ring',     hint: 'Telephone style ring' },
  { id: 'marimba',  name: 'Marimba',          hint: 'Warm wooden notes' },
  { id: 'siren',    name: 'Soft Siren',       hint: 'Slow rise and fall' }
];

const TONE_IDS = TONES.map(t => t.id);
const DEFAULT_TONE = 'chime';

const RINGTONE_KEY = 'announce.ringtones';
const LOG_KEY = 'announce.log';
const LOG_LIMIT = 60;

/* ---------- settings helpers (same shape on Mongo and Postgres) ---------- */

const readSetting = async (key, fallback) => {
  try {
    const row = await SystemSettings.findOne({ key });
    if (!row) return fallback;
    const value = row.value;
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
};

const writeSetting = async (key, value) =>
  SystemSettings.findOneAndUpdate({ key }, { value, updatedAt: new Date() }, { upsert: true, new: true });

/* ---------- auth ---------- */

const authMiddleware = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token required' });
    }
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ message: 'User not found' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

const ownerOnly = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ message: 'Access denied: MD only' });
  }
  next();
};

/* ---------- live connections ---------- */

/** userId -> Set of open responses. One person can have several tabs open. */
const clients = new Map();

/** One-shot tickets, because EventSource cannot send an Authorization header. */
const tickets = new Map();
const TICKET_TTL = 60 * 1000;

const sweepTickets = () => {
  const now = Date.now();
  for (const [key, entry] of tickets) if (entry.expires < now) tickets.delete(key);
};

const send = (res, event, payload) => {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
};

/** Push to every open tab of one person. Returns how many got it. */
const pushTo = (userId, event, payload) => {
  const set = clients.get(String(userId));
  if (!set || !set.size) return 0;
  let delivered = 0;
  for (const res of set) if (send(res, event, payload)) delivered++;
  return delivered;
};

const isOnline = userId => (clients.get(String(userId))?.size || 0) > 0;

/* ---------- stream ---------- */

router.post('/ticket', authMiddleware, (req, res) => {
  sweepTickets();
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { userId: String(req.user._id), expires: Date.now() + TICKET_TTL });
  res.json({ ticket, expiresIn: TICKET_TTL });
});

router.get('/stream', async (req, res) => {
  sweepTickets();
  const entry = tickets.get(String(req.query.ticket || ''));
  if (!entry) return res.status(401).json({ message: 'Stream ticket invalid or expired' });
  tickets.delete(String(req.query.ticket));

  const userId = entry.userId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Railway and nginx buffer responses unless told not to.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);

  send(res, 'ready', { at: Date.now() });

  // Anything quiet for too long gets dropped by proxies, so keep it warm.
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(beat);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(beat);
    const set = clients.get(userId);
    if (set) {
      set.delete(res);
      if (!set.size) clients.delete(userId);
    }
  });
});

/* ---------- ringtone assignment ---------- */

router.get('/ringtones', authMiddleware, async (req, res) => {
  try {
    const assigned = await readSetting(RINGTONE_KEY, {});
    // Staff only need their own tone; the MD needs the whole map.
    if (req.user.role !== 'owner') {
      const mine = assigned[String(req.user._id)] || { tone: DEFAULT_TONE };
      return res.json({ tones: TONES, mine });
    }
    res.json({ tones: TONES, assigned, defaultTone: DEFAULT_TONE });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/ringtones', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const { userId, tone, customUrl, customName } = req.body || {};
    if (!userId) return res.status(400).json({ message: 'userId is required' });
    if (tone && !TONE_IDS.includes(tone) && tone !== 'custom') {
      return res.status(400).json({ message: 'Unknown tone' });
    }
    if (tone === 'custom' && !customUrl) {
      return res.status(400).json({ message: 'Custom tone needs an audio file' });
    }

    const assigned = await readSetting(RINGTONE_KEY, {});
    const next = { ...assigned };
    next[String(userId)] = {
      tone: tone || DEFAULT_TONE,
      customUrl: tone === 'custom' ? String(customUrl) : '',
      customName: tone === 'custom' ? String(customName || 'Custom tone') : ''
    };

    await writeSetting(RINGTONE_KEY, next);
    res.json({ assigned: next });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/* ---------- ringing ---------- */

router.post('/ring', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const { staffIds, message = '', speak = false, repeat = 3, urgent = false } = req.body || {};
    if (!Array.isArray(staffIds) || !staffIds.length) {
      return res.status(400).json({ message: 'Kam se kam ek staff select kijiye' });
    }

    const assigned = await readSetting(RINGTONE_KEY, {});
    const staff = await User.find({ _id: { $in: staffIds } }).select('name username role');
    const ringId = crypto.randomBytes(8).toString('hex');
    const sentAt = Date.now();

    const targets = staff.map(person => {
      const id = String(person._id);
      const choice = assigned[id] || { tone: DEFAULT_TONE };
      const delivered = pushTo(id, 'ring', {
        ringId,
        message: String(message).slice(0, 400),
        tone: choice.tone || DEFAULT_TONE,
        customUrl: choice.customUrl || '',
        speak: Boolean(speak),
        repeat: Math.max(1, Math.min(10, Number(repeat) || 3)),
        urgent: Boolean(urgent),
        fromName: req.user.name,
        sentAt
      });
      return {
        userId: id,
        name: person.name,
        tone: choice.tone || DEFAULT_TONE,
        online: delivered > 0,
        acknowledgedAt: null
      };
    });

    const entry = {
      ringId,
      message: String(message).slice(0, 400),
      byName: req.user.name,
      sentAt,
      targets
    };

    const log = await readSetting(LOG_KEY, []);
    await writeSetting(LOG_KEY, [entry, ...(Array.isArray(log) ? log : [])].slice(0, LOG_LIMIT));

    res.json({
      ringId,
      sentAt,
      delivered: targets.filter(t => t.online).length,
      offline: targets.filter(t => !t.online).map(t => t.name),
      targets
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/ack', authMiddleware, async (req, res) => {
  try {
    const { ringId } = req.body || {};
    if (!ringId) return res.status(400).json({ message: 'ringId is required' });

    const acknowledgedAt = Date.now();
    const userId = String(req.user._id);

    const log = await readSetting(LOG_KEY, []);
    const list = Array.isArray(log) ? log : [];
    const next = list.map(entry => {
      if (entry.ringId !== ringId) return entry;
      return {
        ...entry,
        targets: (entry.targets || []).map(t =>
          t.userId === userId ? { ...t, acknowledgedAt, online: true } : t
        )
      };
    });
    await writeSetting(LOG_KEY, next);

    // Tell every MD tab straight away, so the tick appears while they watch.
    const owners = await User.find({ role: 'owner' }).select('_id');
    for (const owner of owners) {
      pushTo(owner._id, 'ack', {
        ringId,
        userId,
        name: req.user.name,
        acknowledgedAt
      });
    }

    res.json({ ok: true, acknowledgedAt });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/status', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const staff = await User.find({ role: { $ne: 'owner' } }).select('name username role isActive');
    const assigned = await readSetting(RINGTONE_KEY, {});
    const log = await readSetting(LOG_KEY, []);

    res.json({
      staff: staff.map(person => {
        const id = String(person._id);
        const choice = assigned[id] || { tone: DEFAULT_TONE };
        return {
          _id: id,
          name: person.name,
          username: person.username,
          online: isOnline(id),
          tone: choice.tone || DEFAULT_TONE,
          customName: choice.customName || ''
        };
      }),
      log: Array.isArray(log) ? log.slice(0, 20) : []
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
module.exports.TONES = TONES;
