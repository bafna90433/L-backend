const crypto = require('crypto');
const { SystemSettings } = require('./models');

const SETTINGS_KEY = 'ai_council_secure_config';
const ENCRYPTION_SECRET = process.env.AI_SETTINGS_ENCRYPTION_KEY
  || process.env.JWT_SECRET
  || 'labour_management_super_secret_key_123';
const CIPHER = 'aes-256-gcm';

const PROVIDER_DEFAULTS = {
  gemini: { model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', envKey: 'GEMINI_API_KEY' },
  gpt: { model: process.env.OPENAI_MODEL || 'gpt-4o', envKey: 'OPENAI_API_KEY' },
  claude: { model: process.env.ANTHROPIC_MODEL || 'claude-opus-5', envKey: 'ANTHROPIC_API_KEY' }
};

const encryptionKey = () => crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();

function encryptSecret(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    const [iv, tag, encrypted] = String(value).split('.').map(part => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !encrypted) return '';
    const decipher = crypto.createDecipheriv(CIPHER, encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (error) {
    console.error('Could not decrypt an AI API key:', error.message);
    return '';
  }
}

function maskKey(value) {
  if (!value) return '';
  if (value.length < 9) return '•'.repeat(Math.max(value.length, 4));
  return `${value.slice(0, 4)}${'•'.repeat(8)}${value.slice(-4)}`;
}

async function readStoredValue() {
  const setting = await SystemSettings.findOne({ key: SETTINGS_KEY }).lean();
  return setting?.value && typeof setting.value === 'object' ? setting.value : {};
}

async function getAiConfig() {
  const stored = await readStoredValue();
  return Object.fromEntries(Object.entries(PROVIDER_DEFAULTS).map(([provider, defaults]) => {
    const savedKey = decryptSecret(stored?.[provider]?.apiKey);
    const envKey = process.env[defaults.envKey] || '';
    const apiKey = savedKey || envKey;
    return [provider, {
      apiKey,
      model: String(stored?.[provider]?.model || defaults.model).trim(),
      source: savedKey ? 'settings' : (envKey ? 'environment' : null)
    }];
  }));
}

async function getPublicAiConfig() {
  const config = await getAiConfig();
  return {
    providers: Object.fromEntries(Object.entries(config).map(([provider, value]) => [provider, {
      configured: Boolean(value.apiKey),
      maskedKey: maskKey(value.apiKey),
      model: value.model,
      source: value.source
    }]))
  };
}

async function saveAiConfig(input = {}) {
  const stored = await readStoredValue();
  const next = { ...stored };
  for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    const submitted = input[provider];
    if (!submitted || typeof submitted !== 'object') continue;
    const current = stored[provider] && typeof stored[provider] === 'object' ? stored[provider] : {};
    next[provider] = { ...current };
    if (submitted.clearKey === true) next[provider].apiKey = '';
    if (typeof submitted.apiKey === 'string' && submitted.apiKey.trim()) {
      next[provider].apiKey = encryptSecret(submitted.apiKey.trim());
    }
    if (typeof submitted.model === 'string') {
      next[provider].model = submitted.model.trim() || defaults.model;
    }
  }
  await SystemSettings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: { value: next, updatedAt: new Date() } },
    { upsert: true, new: true }
  );
  return getPublicAiConfig();
}

module.exports = { getAiConfig, getPublicAiConfig, saveAiConfig };
