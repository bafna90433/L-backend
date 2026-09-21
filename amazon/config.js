const crypto = require('crypto');
const { SystemSettings } = require('../models');

/* ------------------------------------------------------------------
   Where the Amazon connection details live.

   The LWA client secret and the refresh token are the keys to the whole
   seller account, so they are encrypted before they touch the database and
   are never sent back to a browser — the panel only ever sees a masked
   version, the same way the AI keys work.
   ------------------------------------------------------------------ */

const SETTINGS_KEY = 'amazon_sp_api_config';
const ENCRYPTION_SECRET =
  process.env.AI_SETTINGS_ENCRYPTION_KEY ||
  process.env.JWT_SECRET ||
  'labour_management_super_secret_key_123';
const CIPHER = 'aes-256-gcm';

/**
 * Selling regions. India sits in Amazon's "Europe" region despite the
 * geography — every call for amazon.in goes to the EU host.
 */
const REGIONS = {
  eu: { label: 'Europe / India', host: 'sellingpartnerapi-eu.amazon.com' },
  na: { label: 'North America', host: 'sellingpartnerapi-na.amazon.com' },
  fe: { label: 'Far East', host: 'sellingpartnerapi-fe.amazon.com' }
};

/** The marketplaces this office is likely to sell in. */
const MARKETPLACES = [
  { id: 'A21TJRUUN4KGV', name: 'India (amazon.in)', region: 'eu', currency: 'INR' },
  { id: 'A2EUQ1WTGCTBG2', name: 'Canada', region: 'na', currency: 'CAD' },
  { id: 'ATVPDKIKX0DER', name: 'United States', region: 'na', currency: 'USD' },
  { id: 'A1F83G8C2ARO7P', name: 'United Kingdom', region: 'eu', currency: 'GBP' },
  { id: 'A1PA6795UKMFR9', name: 'Germany', region: 'eu', currency: 'EUR' },
  { id: 'A2VIGQ35RCS4UG', name: 'United Arab Emirates', region: 'eu', currency: 'AED' },
  { id: 'A1VC38T7YXB528', name: 'Japan', region: 'fe', currency: 'JPY' },
  { id: 'A39IBJ37TRP1C6', name: 'Australia', region: 'fe', currency: 'AUD' }
];

const DEFAULTS = {
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  sellerId: '',
  marketplaceId: 'A21TJRUUN4KGV',
  region: 'eu',
  // Sandbox returns fixed make-believe data. Useful for building the panel,
  // useless for running the shop — so this must be switched off once the
  // production application is approved.
  sandbox: true
};

const SECRET_FIELDS = ['clientSecret', 'refreshToken'];

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
    console.error('Could not decrypt an Amazon credential:', error.message);
    return '';
  }
}

function mask(value) {
  if (!value) return '';
  if (value.length < 12) return '•'.repeat(8);
  return `${value.slice(0, 5)}${'•'.repeat(8)}${value.slice(-4)}`;
}

async function readStored() {
  const row = await SystemSettings.findOne({ key: SETTINGS_KEY });
  return row?.value && typeof row.value === 'object' ? row.value : {};
}

/** The real values, for server-side use only. */
async function getAmazonConfig() {
  const stored = await readStored();

  const config = { ...DEFAULTS };
  for (const field of Object.keys(DEFAULTS)) {
    if (SECRET_FIELDS.includes(field)) continue;
    if (stored[field] !== undefined && stored[field] !== null) config[field] = stored[field];
  }

  // Environment variables are the fallback, so a deployment can be configured
  // without anyone opening the panel.
  config.clientId = String(stored.clientId || process.env.AMAZON_LWA_CLIENT_ID || '').trim();
  config.clientSecret = decryptSecret(stored.clientSecret) || process.env.AMAZON_LWA_CLIENT_SECRET || '';
  config.refreshToken = decryptSecret(stored.refreshToken) || process.env.AMAZON_REFRESH_TOKEN || '';
  config.sellerId = String(stored.sellerId || process.env.AMAZON_SELLER_ID || '').trim();
  config.sandbox = stored.sandbox === undefined ? DEFAULTS.sandbox : stored.sandbox !== false;

  const marketplace = MARKETPLACES.find(m => m.id === config.marketplaceId);
  config.region = marketplace?.region || config.region;
  config.currency = marketplace?.currency || 'INR';
  config.host = REGIONS[config.region]?.host || REGIONS.eu.host;
  config.baseUrl = `https://${config.sandbox ? 'sandbox.' : ''}${config.host}`;
  config.connected = Boolean(config.clientId && config.clientSecret && config.refreshToken);

  return config;
}

/** The safe version, for the browser. No secret ever leaves the server. */
async function getPublicAmazonConfig() {
  const config = await getAmazonConfig();
  return {
    clientId: config.clientId,
    clientSecretMasked: mask(config.clientSecret),
    refreshTokenMasked: mask(config.refreshToken),
    hasClientSecret: Boolean(config.clientSecret),
    hasRefreshToken: Boolean(config.refreshToken),
    sellerId: config.sellerId,
    marketplaceId: config.marketplaceId,
    region: config.region,
    sandbox: config.sandbox,
    currency: config.currency,
    baseUrl: config.baseUrl,
    connected: config.connected,
    marketplaces: MARKETPLACES,
    regions: REGIONS
  };
}

async function saveAmazonConfig(input = {}) {
  const stored = await readStored();
  const next = { ...stored };

  if (typeof input.clientId === 'string') next.clientId = input.clientId.trim();
  if (typeof input.sellerId === 'string') next.sellerId = input.sellerId.trim();
  if (typeof input.sandbox === 'boolean') next.sandbox = input.sandbox;

  if (typeof input.marketplaceId === 'string' && MARKETPLACES.some(m => m.id === input.marketplaceId)) {
    next.marketplaceId = input.marketplaceId;
  }

  // A blank field means "leave what is already saved" — the panel never sends
  // a secret back, so an empty box must not wipe a working connection.
  for (const field of SECRET_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) next[field] = encryptSecret(value.trim());
    if (input[`clear_${field}`] === true) next[field] = '';
  }

  await SystemSettings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: { value: next, updatedAt: new Date() } },
    { upsert: true, new: true }
  );

  return getPublicAmazonConfig();
}

module.exports = {
  REGIONS,
  MARKETPLACES,
  getAmazonConfig,
  getPublicAmazonConfig,
  saveAmazonConfig
};
