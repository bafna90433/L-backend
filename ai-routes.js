const express = require('express');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here';

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
  'India, say plainly when a professional should be consulted.';

const SYSTEM_HINGLISH =
  'You are an assistant for the managing director of a small Indian business. ' +
  'Answer in Hinglish — Hindi written in the Roman alphabet, mixed naturally with ' +
  'English business words (for example: "Pehle supplier se rate confirm karein, phir ' +
  'order place karein"). Do not use Devanagari script. Be concise and practical — ' +
  'short paragraphs or numbered points, no filler.';

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

let anthropicClient = null;
const getAnthropic = () => {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
};

async function askClaude({ question, lang, history }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const error = new Error('Claude ki API key server par set nahi hai.');
    error.statusCode = 503;
    throw error;
  }

  let message;
  try {
    const stream = getAnthropic().messages.stream({
      model: 'claude-opus-5',
      max_tokens: 8000,
      system: systemFor(lang),
      thinking: { type: 'adaptive' },
      messages: [...history, { role: 'user', content: question }]
    });
    message = await stream.finalMessage();
  } catch (err) {
    // The SDK's message is the raw JSON body — pull out the readable part.
    const clean = new Error(err?.error?.error?.message || err.message || 'Claude request failed.');
    clean.statusCode = err.status || 500;
    throw clean;
  }

  if (message.stop_reason === 'refusal') {
    const error = new Error('Claude ne is sawaal ka jawab dene se mana kar diya.');
    error.statusCode = 422;
    throw error;
  }

  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/* ---------------- Gemini (Google) ---------------- */

async function askGemini({ question, lang, history }) {
  const key = process.env.GEMINI_API_KEY;
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
    { role: 'user', parts: [{ text: question }] }
  ];

  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemFor(lang) }] },
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
  return text;
}

/* ---------------- ChatGPT (OpenAI) ---------------- */

async function askOpenAI({ question, lang, history }) {
  const key = process.env.OPENAI_API_KEY;
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
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemFor(lang) },
        ...history,
        { role: 'user', content: question }
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
  return text;
}

const PROVIDERS = { claude: askClaude, gemini: askGemini, gpt: askOpenAI };

/* ---------------- Routes ---------------- */

// Which providers actually have a key on this server — the UI uses this to
// show real answers for configured models and a clear notice for the rest.
router.get('/status', authMiddleware, (req, res) => {
  res.json({
    gemini: !!process.env.GEMINI_API_KEY,
    gpt: !!process.env.OPENAI_API_KEY,
    claude: !!process.env.ANTHROPIC_API_KEY
  });
});

router.post('/ask', authMiddleware, async (req, res) => {
  const { model, question, lang, history } = req.body || {};

  const ask = PROVIDERS[model];
  if (!ask) {
    return res.status(400).json({ message: `Unknown model: ${model}` });
  }
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ message: 'Question is required.' });
  }

  const startedAt = Date.now();
  try {
    const text = await ask({
      question: question.trim().slice(0, MAX_QUESTION),
      lang: lang === 'hinglish' ? 'hinglish' : 'en',
      history: cleanHistory(history)
    });
    res.json({ text, model, ms: Date.now() - startedAt });
  } catch (error) {
    console.error(`AI (${model}) failed:`, error.message);
    res.status(error.statusCode || 500).json({
      message: error.message || 'AI request failed.',
      model
    });
  }
});

module.exports = router;
