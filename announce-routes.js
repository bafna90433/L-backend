const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { User, SystemSettings } = require('./models');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { getAiConfig } = require('./ai-config');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

/* ------------------------------------------------------------------
   Announcement Bell — the MD rings, the staff PC plays their own tone.

   The push has to feel instant, so it rides a Server-Sent Events stream
   instead of the polling the rest of the app uses. A ring reaches an open
   Staff Desk in a few hundred milliseconds.

     POST /api/announce/ticket    -> short-lived ticket for the stream
     GET  /api/announce/stream    -> the SSE connection (ticket in query)
     GET  /api/announce/ringtones -> tone catalogue + the office ringtone
     PUT  /api/announce/ringtones -> MD picks the office ringtone
     POST /api/announce/ring      -> MD rings or announces to selected staff
     POST /api/announce/speech    -> the spoken line for an announcement
     POST /api/announce/polish    -> Gemini tidies the MD's wording
     POST /api/announce/ack       -> staff acknowledges the ring
     GET  /api/announce/status    -> who is online + recent rings
   ------------------------------------------------------------------ */

/** Built-in tones. The browser synthesises these, so nothing has to download. */
const TONES = [
  { id: 'telephone', name: 'Telephone Ring',  hint: 'Classic kring-kring, rings until answered' },
  { id: 'siren',   name: 'Emergency Siren', hint: 'Loud rising and falling siren' },
  { id: 'wail',    name: 'Two-Tone Wail',   hint: 'Ambulance style two-tone' },
  { id: 'klaxon',  name: 'Klaxon Horn',     hint: 'Deep factory horn' },
  { id: 'alert',   name: 'Alert Pulse',     hint: 'Fast urgent beeps' },
  { id: 'digital', name: 'Digital Ring',    hint: 'Telephone style ring' },
  { id: 'bell',    name: 'School Bell',     hint: 'Loud metallic bell' },
  { id: 'ping',    name: 'Sharp Ping',      hint: 'Short and bright' },
  { id: 'arcade',  name: 'Rising Arcade',   hint: 'Playful upward run' },
  { id: 'marimba', name: 'Marimba',         hint: 'Warm wooden notes' },
  { id: 'chime',   name: 'Office Chime',    hint: 'Soft two-note chime' }
];

const TONE_IDS = TONES.map(t => t.id);
const DEFAULT_TONE = 'telephone';

const RINGTONE_KEY = 'announce.ringtone';
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

const readRingtone = async () => {
  const saved = await readSetting(RINGTONE_KEY, null);
  if (!saved || typeof saved !== 'object') return { tone: DEFAULT_TONE, customUrl: '', customName: '' };
  return {
    tone: saved.tone || DEFAULT_TONE,
    customUrl: saved.customUrl || '',
    customName: saved.customName || ''
  };
};

router.get('/ringtones', authMiddleware, async (req, res) => {
  try {
    res.json({ tones: TONES, ringtone: await readRingtone(), defaultTone: DEFAULT_TONE });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/ringtones', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const { tone, customUrl, customName } = req.body || {};
    if (tone && !TONE_IDS.includes(tone) && tone !== 'custom') {
      return res.status(400).json({ message: 'Unknown tone' });
    }
    if (tone === 'custom' && !customUrl) {
      return res.status(400).json({ message: 'A custom tone needs an audio file' });
    }

    const ringtone = {
      tone: tone || DEFAULT_TONE,
      customUrl: tone === 'custom' ? String(customUrl) : '',
      customName: tone === 'custom' ? String(customName || 'Custom tone') : ''
    };

    await writeSetting(RINGTONE_KEY, ringtone);
    res.json({ ringtone });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/* ---------- spoken announcements ---------- */

/** Announcement Bell intentionally uses one consistent office voice. */
const VOICES = {
  en: 'en-IN-PrabhatNeural'
};

const LANGS = Object.keys(VOICES);

/** The same line gets announced over and over, so keep the audio around. */
const speechCache = new Map();
const SPEECH_CACHE_MAX = 120;

/** How long one voice attempt gets before it is abandoned. */
const SYNTH_TIMEOUT_MS = 12000;

/**
 * One attempt at Microsoft's neural voice.
 *
 * The stream can also just stop — no 'end', no 'error' — so this refuses to
 * wait forever. Without the timeout a single bad connection hangs the request
 * and the announcement is never spoken at all.
 */
const synthOnce = (text, lang) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new Error('voice service did not answer in time')),
      SYNTH_TIMEOUT_MS
    );

    (async () => {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(VOICES[lang] || VOICES.en, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text);

      const chunks = [];
      audioStream.on('data', chunk => chunks.push(chunk));
      audioStream.on('end', () => {
        const audio = Buffer.concat(chunks);
        if (audio.length < 2000) finish(reject, new Error('empty audio'));
        else finish(resolve, audio.toString('base64'));
      });
      audioStream.on('error', error => finish(reject, error));
    })().catch(error => finish(reject, error));
  });

/**
 * Google's voice, used only when Microsoft's keeps failing. It is capped at a
 * couple of hundred characters, which is fine for an announcement line.
 */
const synthFallback = async (text, lang) => {
  const res = await fetch(
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 200))}` +
      `&tl=${lang}&client=tw-ob`,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }
  );
  if (!res.ok) throw new Error(`fallback voice failed (${res.status})`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000) throw new Error('fallback voice returned nothing');
  return audio.toString('base64');
};

/**
 * The neural voice service drops its stream every few calls, which is why
 * announcements used to be silent at random. Try it twice, then fall back to a
 * second voice, and remember whatever worked.
 */
const speak = (text, lang) => {
  const key = `${lang}|${text}`;
  const hit = speechCache.get(key);
  // A finished recording, or one already being made. Storing the promise means
  // the pre-warm and the staff browser share one synthesis instead of racing.
  if (hit) return hit;

  const work = buildSpeech(text, lang).catch(error => {
    // A failure must not be remembered, or it would never be retried.
    speechCache.delete(key);
    throw error;
  });

  if (speechCache.size >= SPEECH_CACHE_MAX) speechCache.delete(speechCache.keys().next().value);
  speechCache.set(key, work);
  return work;
};

const buildSpeech = async (text, lang) => {
  let audio = null;
  let lastError = null;

  for (let attempt = 0; attempt < 2 && !audio; attempt++) {
    try {
      audio = await synthOnce(text, lang);
    } catch (error) {
      lastError = error;
    }
  }

  if (!audio) {
    try {
      audio = await synthFallback(text, lang);
      console.warn('Announcement voice fell back to the backup:', lastError?.message);
    } catch (error) {
      throw lastError || error;
    }
  }

  return audio;
};

router.post('/speech', authMiddleware, async (req, res) => {
  try {
    const text = String(req.body?.text || '').slice(0, 400).trim();
    const lang = LANGS.includes(req.body?.lang) ? req.body.lang : 'en';
    if (!text) return res.status(400).json({ message: 'Nothing to say' });

    const audioContent = await speak(text, lang);
    res.json({ audioContent, mimeType: 'audio/mp3' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/* ---------- wording help ---------- */

/**
 * Tidy the MD's rough note into one clean announcement line.
 *
 * This uses the Gemini key the MD saved in Settings, not an environment
 * variable, so it works on the live server without any extra setup.
 */
router.post('/polish', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const draft = String(req.body?.text || '').slice(0, 300).trim();
    if (!draft) return res.status(400).json({ message: 'Nothing to improve' });

    const config = (await getAiConfig()).gemini;
    if (!config.apiKey) {
      return res.status(503).json({ message: 'Add a Gemini key in Settings first' });
    }

    const instruction =
      'You rewrite short office announcements for an Indian company. ' +
      'Reply with exactly one sentence, under 18 words, polite and clear. ' +
      'It is read aloud immediately after the staff member name, so never include a name, ' +
      'a greeting, quotation marks or any explanation. Reply with the sentence only.';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: draft }] }],
          systemInstruction: { parts: [{ text: instruction }] },
          generationConfig: { maxOutputTokens: 2048, temperature: 0.4 }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ message: data?.error?.message || 'Gemini refused' });
    }

    const reply = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || '')
      .join('')
      .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
      .split('\n')[0]
      .trim();

    if (!reply) return res.status(502).json({ message: 'Gemini sent nothing back' });
    res.json({ reply });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/* ---------- ringing ---------- */

router.post('/ring', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const {
      staffIds,
      message = '',
      mode = 'ring',
      lang = 'en',
      durationMs = 30000,
      urgent = false
    } = req.body || {};
    if (!Array.isArray(staffIds) || !staffIds.length) {
      return res.status(400).json({ message: 'Select at least one staff member' });
    }

    const announcing = mode === 'announce';
    const speechLang = LANGS.includes(lang) ? lang : 'en';
    const line = String(message).slice(0, 400).trim();

    if (announcing && !line) {
      return res.status(400).json({ message: 'An announcement needs a message' });
    }

    // One ringtone for the whole office — the MD picks it once.
    const ringtone = await readRingtone();
    const ringFor = Math.max(3000, Math.min(120000, Number(durationMs) || 30000));
    const staff = await User.find({ _id: { $in: staffIds } }).select('name username role');
    const ringId = crypto.randomBytes(8).toString('hex');
    const sentAt = Date.now();

    const targets = staff.map(person => {
      const id = String(person._id);
      // The announcement greets the person by name, the way it would be said
      // over a real office PA system.
      const speech = announcing ? `${person.name}, ${line}` : '';
      const delivered = pushTo(id, 'ring', {
        ringId,
        message: line,
        mode: announcing ? 'announce' : 'ring',
        speech,
        lang: speechLang,
        tone: ringtone.tone,
        customUrl: ringtone.customUrl,
        durationMs: ringFor,
        urgent: Boolean(urgent),
        fromName: req.user.name,
        sentAt
      });
      return {
        userId: id,
        name: person.name,
        online: delivered > 0,
        acknowledgedAt: null
      };
    });

    const entry = {
      ringId,
      message: line,
      mode: announcing ? 'announce' : 'ring',
      byName: req.user.name,
      sentAt,
      targets
    };

    const log = await readSetting(LOG_KEY, []);
    await writeSetting(LOG_KEY, [entry, ...(Array.isArray(log) ? log : [])].slice(0, LOG_LIMIT));

    // Build the voice now and push it down the same stream the moment it is
    // ready. The alert and the tone land immediately; the spoken line follows a
    // few seconds later without the browser having to ask for it.
    if (announcing) {
      for (const target of targets) {
        const person = staff.find(p => String(p._id) === target.userId);
        if (!person) continue;

        const spoken = `${person.name}, ${line}`;
        speak(spoken, speechLang)
          .then(audioContent => {
            pushTo(target.userId, 'speech', {
              ringId,
              audioContent,
              mimeType: 'audio/mp3'
            });
          })
          .catch(error => {
            // The browser can still ask for it itself; this is just the fast path.
            console.warn(`Could not build the announcement for ${person.name}:`, error.message);
          });
      }
    }

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
    const log = await readSetting(LOG_KEY, []);

    res.json({
      ringtone: await readRingtone(),
      tones: TONES,
      staff: staff.map(person => ({
        _id: String(person._id),
        name: person.name,
        username: person.username,
        online: isOnline(String(person._id))
      })),
      log: Array.isArray(log) ? log.slice(0, 20) : []
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
module.exports.TONES = TONES;
