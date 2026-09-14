const express = require('express');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const { getAiConfig, getPublicAiConfig, saveAiConfig } = require('./ai-config');
const { buildCards } = require('./link-cards');
const bcrypt = require('bcryptjs');
const { User, SystemSettings } = require('./models');
const { resolveUserAccess } = require('./access-control');
const aiUsage = require('./ai-usage');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

/* ------------------------------------------------------------------
   AI Council backend — one question, answers from several providers.

   POST /api/ai/ask
     body: { model: 'claude' | 'gemini' | 'gpt',
             question: string,
             lang: 'en' | 'hinglish',
             history: [{ role: 'user' | 'assistant', content: string }] }
     ->   { text, model, ms }

   Every provider key stays on the server — the browser never sees one.
   ------------------------------------------------------------------ */

// Keep replies short enough to read in a chat column.
const SYSTEM_EN =
  'You are an assistant for the managing director of a small Indian business. ' +
  'Answer in clear, plain English. Be concise and practical — short paragraphs or ' +
  'numbered points, no filler. If the question is about money, contracts or law in ' +
  'India, say plainly when a professional should be consulted. Format longer answers with clean Markdown headings, ' +
  'short paragraphs, bullet lists and tables where useful. Never show raw formatting instructions.';

const SYSTEM_HINGLISH =
  'You are an assistant for the managing director of a small Indian business. ' +
  'Answer in Hinglish — Hindi written in the Roman alphabet, mixed naturally with ' +
  'English business words (for example: "Pehle supplier se rate confirm karein, phir ' +
  'order place karein"). Do not use Devanagari script. Be concise and practical — ' +
  'short paragraphs or numbered points, no filler. Format longer answers with clean Markdown headings, ' +
  'short paragraphs, bullet lists and tables where useful.';

const systemFor = lang => (lang === 'hinglish' ? SYSTEM_HINGLISH : SYSTEM_EN);

const MAX_QUESTION = 8000;
const MAX_HISTORY = 12;

/** Same JWT check the main API uses — the AI route must not be open to the internet. */
const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token required' });
    }
    req.auth = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

/** Gate a route on one AI permission — the same ones MD assigns from Access Control. */
const aiPermissionMiddleware = feature => async (req, res, next) => {
  try {
    const user = await User.findById(req.auth.id);
    if (!user) return res.status(401).json({ message: 'User nahi mila.' });
    const access = await aiAccessFor(user);
    if (!access.isActive || !access[feature]) {
      return res.status(403).json({ message: 'Is feature ka access nahi hai. MD se permission lagwa lijiye.' });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: 'Access check nahi ho paaya.' });
  }
};

const ownerOnlyMiddleware = (req, res, next) => {
  if (req.auth?.role !== 'owner') return res.status(403).json({ message: 'Access denied: Owners only' });
  next();
};

/** At most this many images per question, and this big each once decoded. */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** Keep only images the providers will actually accept. */
function cleanImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(img => img && typeof img.data === 'string' && IMAGE_TYPES.includes(img.mimeType))
    .filter(img => Buffer.byteLength(img.data, 'base64') <= MAX_IMAGE_BYTES)
    .slice(0, MAX_IMAGES)
    .map(img => ({ mimeType: img.mimeType, data: img.data }));
}

/** Trim the conversation we replay to the provider. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));
}

/* ---------------- Claude (Anthropic) ---------------- */

async function askClaude({ question, lang, history, systemOverride, noSearch, images = [] }) {
  const config = (await getAiConfig()).claude;
  if (!config.apiKey) {
    const error = new Error('Claude ki API key server par set nahi hai.');
    error.statusCode = 503;
    throw error;
  }

  let message;
  try {
    const client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.workspaceId ? {
        defaultHeaders: { 'anthropic-workspace-id': config.workspaceId }
      } : {})
    });
    const stream = client.messages.stream({
      model: config.model,
      max_tokens: 8000,
      system: systemOverride || systemFor(lang),
      thinking: { type: 'adaptive' },
      // Let Claude look things up, so prices and product names are current
      // and every answer can cite real pages. Rewriting existing answers needs
      // no search, and skipping it is much faster.
      ...(noSearch
        ? {}
        : { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] }),
      messages: [
        ...history,
        {
          role: 'user',
          content: images.length
            ? [
                ...images.map(img => ({
                  type: 'image',
                  source: { type: 'base64', media_type: img.mimeType, data: img.data }
                })),
                { type: 'text', text: question }
              ]
            : question
        }
      ]
    });
    message = await stream.finalMessage();
  } catch (err) {
    // The SDK's message is the raw JSON body — pull out the readable part.
    const rawMessage = err?.error?.error?.message || err.message || 'Claude request failed.';
    const clean = new Error(
      String(rawMessage).includes('anthropic-workspace-id')
        ? 'Claude Workspace ID required hai. Settings > AI Council APIs > Claude me Workspace ID add karke save karein.'
        : rawMessage
    );
    clean.statusCode = err.status || 500;
    throw clean;
  }

  if (message.stop_reason === 'refusal') {
    const error = new Error('Claude ne is sawaal ka jawab dene se mana kar diya.');
    error.statusCode = 422;
    throw error;
  }

  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

  // Pages Claude actually read during the search, for the source cards.
  const links = [];
  for (const block of message.content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result?.type === 'web_search_result' && result.url) {
        links.push({ url: result.url, title: result.title });
      }
    }
  }

  return { text, links, usage: message.usage };
}

/* ---------------- Gemini (Google) ---------------- */

async function askGemini({ question, lang, history, systemOverride, noSearch, images = [] }) {
  const config = (await getAiConfig()).gemini;
  const key = config.apiKey;
  if (!key) {
    const error = new Error('Gemini ki API key server par set nahi hai.');
    error.statusCode = 503;
    throw error;
  }

  const contents = [
    ...history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    {
      role: 'user',
      parts: [
        ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
        { text: question }
      ]
    }
  ];

  const model = config.model;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents,
        ...(noSearch ? {} : { tools: [{ google_search: {} }] }),
        systemInstruction: { parts: [{ text: systemOverride || systemFor(lang) }] },
        generationConfig: { maxOutputTokens: 4096 }
      })
    }
  );

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'Gemini request failed.');
    error.statusCode = response.status;
    throw error;
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim();

  if (!text) throw new Error('Gemini ne khaali jawab bheja.');

  // Pages Google Search grounding actually used, for the source cards.
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const links = chunks
    .map(chunk => chunk?.web)
    .filter(source => source?.uri)
    .filter((source, index, all) => all.findIndex(item => item.uri === source.uri) === index)
    .map(source => ({ url: source.uri, title: source.title }));

  return { text, links, usage: data?.usageMetadata };
}

/* ---------------- ChatGPT (OpenAI) ---------------- */

async function askOpenAI({ question, lang, history, systemOverride, noSearch, images = [] }) {
  const config = (await getAiConfig()).gpt;
  const key = config.apiKey;
  if (!key) {
    const error = new Error('ChatGPT ki API key abhi add nahi hui hai.');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemOverride || systemFor(lang) },
        ...history,
        {
          role: 'user',
          content: images.length
            ? [
                { type: 'text', text: question },
                ...images.map(img => ({
                  type: 'image_url',
                  image_url: { url: `data:${img.mimeType};base64,${img.data}` }
                }))
              ]
            : question
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'OpenAI request failed.');
    error.statusCode = response.status;
    throw error;
  }

  const text = (data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('ChatGPT ne khaali jawab bheja.');
  return { text, links: [], usage: data?.usage };
}

const PROVIDERS = { claude: askClaude, gemini: askGemini, gpt: askOpenAI };

/* ---------------- Routes ---------------- */

// Which providers actually have a key on this server — the UI uses this to
// show real answers for configured models and a clear notice for the rest.
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const config = await getAiConfig();
    res.json({ gemini: !!config.gemini.apiKey, gpt: !!config.gpt.apiKey, claude: !!config.claude.apiKey });
  } catch (error) {
    res.status(500).json({ message: 'AI configuration could not be loaded.' });
  }
});

router.get('/config', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try { res.json(await getPublicAiConfig()); }
  catch (error) { res.status(500).json({ message: 'AI configuration could not be loaded.' }); }
});

router.put('/config', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try { res.json(await saveAiConfig(req.body)); }
  catch (error) {
    console.error('AI configuration save failed:', error.message);
    res.status(500).json({ message: 'AI configuration could not be saved.' });
  }
});

router.post('/test/:provider', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  const ask = PROVIDERS[req.params.provider];
  if (!ask) return res.status(400).json({ message: 'Unknown AI provider.' });
  const startedAt = Date.now();
  try {
    await ask({ question: 'Reply with only: Connection successful', lang: 'en', history: [] });
    res.json({ ok: true, ms: Date.now() - startedAt });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Connection test failed.' });
  }
});

router.post('/ask', authMiddleware, aiPermissionMiddleware('council'), async (req, res) => {
  const { model, question, lang, history, images } = req.body || {};

  const ask = PROVIDERS[model];
  if (!ask) {
    return res.status(400).json({ message: `Unknown model: ${model}` });
  }

  const enabled = await readEnabled();
  if (!enabled[model]) {
    return res.status(403).json({ message: `${model} is switched off in Settings.` });
  }
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ message: 'Question is required.' });
  }

  const startedAt = Date.now();
  try {
    const answer = await ask({
      question: question.trim().slice(0, MAX_QUESTION),
      lang: lang === 'hinglish' ? 'hinglish' : 'en',
      history: cleanHistory(history),
      images: cleanImages(images)
    });

    // What that call cost, for the meter in the AI Council.
    void aiUsage.record(model, answer.usage);

    // Source cards are a bonus — never fail an answer over them.
    let sources = [];
    try {
      sources = await buildCards(answer.links, {
        cseId: process.env.GOOGLE_CSE_ID,
        cseKey: process.env.GOOGLE_CSE_KEY || process.env.GEMINI_API_KEY
      });
    } catch (cardError) {
      console.error('Link cards failed:', cardError.message);
    }

    res.json({ text: answer.text, sources, model, ms: Date.now() - startedAt });
  } catch (error) {
    console.error(`AI (${model}) failed:`, error.message);
    res.status(error.statusCode || 500).json({
      message: error.message || 'AI request failed.',
      model
    });
  }
});

/* ---------------- Spend, credit and visibility ---------------- */

const VISIBILITY_KEY = 'ai.council.hidden';
const ENABLED_KEY = 'ai.council.providers';
const ALL_MODELS = ['gemini', 'gpt', 'claude'];

const readHidden = async () => {
  try {
    const row = await SystemSettings.findOne({ key: VISIBILITY_KEY });
    return row?.value === true;
  } catch {
    return false;
  }
};

/** Which providers the MD wants on the page. Unset means all of them. */
const readEnabled = async () => {
  let saved = null;
  try {
    const row = await SystemSettings.findOne({ key: ENABLED_KEY });
    saved = row?.value;
  } catch {
    saved = null;
  }

  const enabled = {};
  for (const model of ALL_MODELS) {
    enabled[model] = saved && typeof saved === 'object' ? saved[model] !== false : true;
  }

  // Turning every one off would leave an empty page, so keep at least one.
  if (!ALL_MODELS.some(model => enabled[model])) enabled.gemini = true;
  return enabled;
};

/** Any signed-in user needs this, so their menu and page can follow it. */
router.get('/visibility', authMiddleware, async (req, res) => {
  res.json({ hidden: await readHidden(), providers: await readEnabled() });
});

router.put('/visibility', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    if (typeof req.body?.hidden === 'boolean') {
      await SystemSettings.findOneAndUpdate(
        { key: VISIBILITY_KEY },
        { value: req.body.hidden, updatedAt: new Date() },
        { upsert: true, new: true }
      );
    }

    if (req.body?.providers && typeof req.body.providers === 'object') {
      const current = await readEnabled();
      const next = { ...current };
      for (const model of ALL_MODELS) {
        if (typeof req.body.providers[model] === 'boolean') next[model] = req.body.providers[model];
      }
      if (!ALL_MODELS.some(model => next[model])) {
        return res.status(400).json({ message: 'Keep at least one AI switched on.' });
      }
      await SystemSettings.findOneAndUpdate(
        { key: ENABLED_KEY },
        { value: next, updatedAt: new Date() },
        { upsert: true, new: true }
      );
    }

    res.json({ hidden: await readHidden(), providers: await readEnabled() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/usage', authMiddleware, aiPermissionMiddleware('council'), async (req, res) => {
  try {
    res.json(await aiUsage.summary());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/usage/rates', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    res.json({ rates: await aiUsage.saveRates(req.body?.rates) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/usage/credit', authMiddleware, ownerOnlyMiddleware, async (req, res) => {
  try {
    res.json({ credit: await aiUsage.saveCredit(req.body?.credit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/* ---------------- Saved chats ----------------

   The history used to live in the browser, so clearing the browser or moving
   to another PC lost everything. It now lives with the user's account, which
   works on both the Mongo and Postgres setups without a schema change.
   ------------------------------------------------------------------------ */

const CHATS_LIMIT = 60;
const chatsKeyFor = userId => `ai.council.chats.${userId}`;

const readChats = async userId => {
  try {
    const row = await SystemSettings.findOne({ key: chatsKeyFor(userId) });
    const value = row?.value;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

router.get('/chats', authMiddleware, aiPermissionMiddleware('council'), async (req, res) => {
  try {
    res.json({ chats: await readChats(req.auth.id) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/chats', authMiddleware, aiPermissionMiddleware('council'), async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.chats) ? req.body.chats : null;
    if (!incoming) return res.status(400).json({ message: 'chats must be a list' });

    const chats = incoming.slice(0, CHATS_LIMIT);
    await SystemSettings.findOneAndUpdate(
      { key: chatsKeyFor(req.auth.id) },
      { value: chats, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ saved: chats.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/* ---------------- One answer out of three ---------------- */

const COMBINE_EN =
  'You are given the same question answered by three different AI models. ' +
  'Write ONE final answer for a busy managing director. ' +
  'Start with the direct answer in one or two sentences. ' +
  'Then give the key points the models agree on. ' +
  'If they disagree on anything that matters, say so plainly under a short ' +
  '"Where they differ" heading and name which model said what. ' +
  'Leave out anything only one model mentioned in passing. ' +
  'Use clean Markdown, keep it shorter than any single original answer, and ' +
  'never mention that you were given other answers to merge.';

const COMBINE_HINGLISH =
  COMBINE_EN +
  ' Write the final answer in Hinglish — Hindi in the Roman alphabet mixed with ' +
  'English business words. Do not use Devanagari script.';

router.post('/combine', authMiddleware, aiPermissionMiddleware('council'), async (req, res) => {
  const { question, answers, lang } = req.body || {};

  if (!question || !Array.isArray(answers) || answers.length < 2) {
    return res.status(400).json({ message: 'Need at least two answers to combine.' });
  }

  const body = answers
    .filter(a => a && a.text)
    .map(a => `### ${a.name || a.model}
${String(a.text).slice(0, 12000)}`)
    .join('\n\n');

  const prompt = `QUESTION:
${question}

ANSWERS:

${body}`;
  const system = lang === 'hinglish' ? COMBINE_HINGLISH : COMBINE_EN;
  const startedAt = Date.now();

  // Claude writes the tightest summary; Gemini stands in if it is not set up.
  const order = ['claude', 'gemini', 'gpt'];
  let lastError = null;

  for (const model of order) {
    try {
      const result = await PROVIDERS[model]({
        question: prompt,
        lang: lang === 'hinglish' ? 'hinglish' : 'en',
        history: [],
        systemOverride: system,
        // Everything needed is already in the prompt.
        noSearch: true
      });
      void aiUsage.record(model, result.usage);
      return res.json({ text: result.text, by: model, ms: Date.now() - startedAt });
    } catch (error) {
      lastError = error;
    }
  }

  res.status(lastError?.statusCode || 500).json({
    message: lastError?.message || 'Could not combine the answers.'
  });
});

/** What this user may open in the AI workspace. */
async function aiAccessFor(user) {
  const access = await resolveUserAccess(user);
  const permissions = access.permissions || [];
  const everything = user.role === 'owner' || permissions.includes('*');

  return {
    isActive: access.isActive !== false,
    roleName: access.roleName,
    // role 'ai' accounts exist only for the AI workspace, so they get both.
    council: everything || user.role === 'ai' || permissions.includes('ai.council'),
    studio: everything || user.role === 'ai' || permissions.includes('ai.studio')
  };
}

/* ---------------- Separate login for the AI workspace ----------------
   AI-only users (role 'ai') sign in here instead of the owner dashboard,
   so the design work does not need the MD's credentials. Owners can use
   the same login too. The token it issues is the normal app token, so
   every /api/ai/* and /api/image/* route accepts it.
   ------------------------------------------------------------------- */

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ message: 'Username aur password dono zaroori hain.' });
    }

    const user = await User.findOne({ username: String(username).trim() });
    if (!user || !(await bcrypt.compare(String(password), user.password))) {
      return res.status(401).json({ message: 'Username ya password galat hai.' });
    }

    const access = await aiAccessFor(user);

    if (!access.isActive) {
      return res.status(403).json({ message: 'Ye account band hai. MD se baat kijiye.' });
    }
    if (!access.council && !access.studio) {
      return res.status(403).json({
        message: 'Is account ko AI workspace ka access nahi hai. MD se "AI Studio" role lagwa lijiye.'
      });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        roleName: access.roleName,
        imageUrl: user.imageUrl || '',
        canCouncil: access.council,
        canStudio: access.studio
      }
    });
  } catch (error) {
    console.error('AI login failed:', error.message);
    res.status(500).json({ message: 'Login nahi ho paaya.' });
  }
});

/** Change your own password from inside the AI workspace. */
router.post('/auth/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Purana aur naya password dono chahiye.' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: 'Naya password kam se kam 6 characters ka rakhein.' });
    }

    const user = await User.findById(req.auth.id);
    if (!user) return res.status(404).json({ message: 'User nahi mila.' });

    if (!(await bcrypt.compare(String(currentPassword), user.password))) {
      return res.status(401).json({ message: 'Purana password galat hai.' });
    }

    user.password = await bcrypt.hash(String(newPassword), 10);
    await user.save();
    res.json({ message: 'Password badal gaya.' });
  } catch (error) {
    console.error('Password change failed:', error.message);
    res.status(500).json({ message: 'Password nahi badla ja saka.' });
  }
});

router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.auth.id).select('-password');
    if (!user) return res.status(401).json({ message: 'User nahi mila.' });
    const access = await aiAccessFor(user);
    if (!access.isActive || (!access.council && !access.studio)) {
      return res.status(403).json({ message: 'Is account ko AI workspace ka access nahi hai.' });
    }

    res.json({
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        roleName: access.roleName,
        imageUrl: user.imageUrl || '',
        canCouncil: access.council,
        canStudio: access.studio
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'User load nahi hua.' });
  }
});

module.exports = router;
