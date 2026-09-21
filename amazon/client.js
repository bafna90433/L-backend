const { getAmazonConfig } = require('./config');

/* ------------------------------------------------------------------
   Talking to Amazon's Selling Partner API.

   Since October 2023 SP-API no longer needs AWS IAM or Signature V4 — a
   Login with Amazon access token in the `x-amz-access-token` header is the
   whole of the authentication. The token lasts an hour, so it is fetched
   once and reused until it is nearly expired.
   ------------------------------------------------------------------ */

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/** Access tokens live an hour; refresh a minute early to avoid a race. */
let tokenCache = { value: '', expiresAt: 0, forRefreshToken: '' };

class AmazonError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

async function getAccessToken(config) {
  const now = Date.now();
  if (
    tokenCache.value &&
    tokenCache.expiresAt > now &&
    tokenCache.forRefreshToken === config.refreshToken
  ) {
    return tokenCache.value;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret
  });

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new AmazonError(
      data.error_description || data.error || 'Amazon refused the login credentials.',
      res.status === 400 ? 401 : res.status,
      data
    );
  }

  tokenCache = {
    value: data.access_token,
    expiresAt: now + Math.max(60, (data.expires_in || 3600) - 60) * 1000,
    forRefreshToken: config.refreshToken
  };

  return tokenCache.value;
}

/** Forget the cached token — used when the credentials change. */
function resetToken() {
  tokenCache = { value: '', expiresAt: 0, forRefreshToken: '' };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One SP-API call.
 *
 * Amazon rate-limits hard and answers 429 when a burst runs out, so a
 * throttled call waits and tries again rather than surfacing as an error.
 */
async function spCall(path, { method = 'GET', query = {}, body = null, retries = 2 } = {}) {
  const config = await getAmazonConfig();

  if (!config.connected) {
    throw new AmazonError(
      'Amazon is not connected yet. Add the LWA credentials in the panel settings.',
      503
    );
  }

  const url = new URL(path, config.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }

  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    const token = await getAccessToken(config);

    const res = await fetch(url, {
      method,
      headers: {
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    if (res.status === 429) {
      // Back off and let the token bucket refill.
      lastError = new AmazonError('Amazon is rate limiting us. Try again in a moment.', 429);
      await sleep(1200 * (attempt + 1));
      attempt++;
      continue;
    }

    const text = await res.text();
    const data = text ? safeJson(text) : {};

    if (!res.ok) {
      const first = Array.isArray(data?.errors) ? data.errors[0] : null;
      throw new AmazonError(
        first?.message || first?.code || `Amazon returned ${res.status}.`,
        res.status,
        data
      );
    }

    return data;
  }

  throw lastError || new AmazonError('Amazon did not answer.', 504);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

module.exports = { spCall, getAccessToken, resetToken, AmazonError };
