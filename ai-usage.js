const { SystemSettings } = require('./models');

/* ------------------------------------------------------------------
   What the AI Council costs.

   None of the three providers expose a "credit left" number over their
   normal API keys, so this counts every call as it happens: tokens in,
   tokens out, and the money that works out to. The MD enters whatever
   they topped up, and the balance is that minus what has been spent.
   ------------------------------------------------------------------ */

const USAGE_KEY = 'ai.usage';
const RATES_KEY = 'ai.usage.rates';
const CREDIT_KEY = 'ai.usage.credit';

/**
 * USD per million tokens.
 *
 * Claude's figures are Anthropic's published API rates. The other two are
 * starting points — every rate is editable in Settings, because providers
 * change prices and each account can be on a different plan.
 */
const DEFAULT_RATES = {
  claude: { input: 5, output: 25, label: 'claude-opus-5' },
  gemini: { input: 0.3, output: 2.5, label: 'gemini-3.6-flash' },
  gpt: { input: 2.5, output: 10, label: 'gpt-4o' }
};

const PROVIDERS = Object.keys(DEFAULT_RATES);

const monthKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const readSetting = async (key, fallback) => {
  try {
    const row = await SystemSettings.findOne({ key });
    const value = row?.value;
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
};

const writeSetting = (key, value) =>
  SystemSettings.findOneAndUpdate({ key }, { value, updatedAt: new Date() }, { upsert: true, new: true });

const blankTotals = () => ({ input: 0, output: 0, calls: 0, usd: 0 });

/* ---------- rates ---------- */

const readRates = async () => {
  const saved = await readSetting(RATES_KEY, null);
  const rates = {};
  for (const provider of PROVIDERS) {
    const row = saved?.[provider] || {};
    rates[provider] = {
      input: Number.isFinite(Number(row.input)) ? Number(row.input) : DEFAULT_RATES[provider].input,
      output: Number.isFinite(Number(row.output)) ? Number(row.output) : DEFAULT_RATES[provider].output,
      label: row.label || DEFAULT_RATES[provider].label
    };
  }
  return rates;
};

const saveRates = async incoming => {
  const current = await readRates();
  const next = { ...current };
  for (const provider of PROVIDERS) {
    const row = incoming?.[provider];
    if (!row) continue;
    next[provider] = {
      input: Math.max(0, Number(row.input) || 0),
      output: Math.max(0, Number(row.output) || 0),
      label: String(row.label || current[provider].label).slice(0, 60)
    };
  }
  await writeSetting(RATES_KEY, next);
  return next;
};

/* ---------- credit the MD has topped up ---------- */

const readCredit = async () => {
  const saved = await readSetting(CREDIT_KEY, null);
  const credit = {};
  for (const provider of PROVIDERS) {
    const row = saved?.[provider] || {};
    credit[provider] = {
      addedUsd: Math.max(0, Number(row.addedUsd) || 0),
      note: String(row.note || '').slice(0, 80)
    };
  }
  return credit;
};

const saveCredit = async incoming => {
  const current = await readCredit();
  const next = { ...current };
  for (const provider of PROVIDERS) {
    const row = incoming?.[provider];
    if (!row) continue;
    next[provider] = {
      addedUsd: Math.max(0, Number(row.addedUsd) || 0),
      note: String(row.note || '').slice(0, 80)
    };
  }
  await writeSetting(CREDIT_KEY, next);
  return next;
};

/* ---------- recording ---------- */

/**
 * Pull the token counts out of whichever provider replied. Each one names
 * these fields differently, and any of them can be missing.
 */
const tokensFrom = (provider, raw) => {
  if (!raw) return { input: 0, output: 0 };

  if (provider === 'claude') {
    return {
      input: Number(raw.input_tokens || 0) + Number(raw.cache_read_input_tokens || 0) +
        Number(raw.cache_creation_input_tokens || 0),
      output: Number(raw.output_tokens || 0)
    };
  }

  if (provider === 'gemini') {
    return {
      input: Number(raw.promptTokenCount || 0),
      output: Number(raw.candidatesTokenCount || 0) + Number(raw.thoughtsTokenCount || 0)
    };
  }

  return {
    input: Number(raw.prompt_tokens || 0),
    output: Number(raw.completion_tokens || 0)
  };
};

/** Add one call to this month's tally. Never throws — billing must not break a reply. */
const record = async (provider, rawUsage) => {
  try {
    if (!PROVIDERS.includes(provider)) return;

    const { input, output } = tokensFrom(provider, rawUsage);
    if (!input && !output) return;

    const rates = await readRates();
    const rate = rates[provider];
    const usd = (input / 1e6) * rate.input + (output / 1e6) * rate.output;

    const all = (await readSetting(USAGE_KEY, {})) || {};
    const month = monthKey();
    const forMonth = all[month] || {};
    const totals = forMonth[provider] || blankTotals();

    forMonth[provider] = {
      input: totals.input + input,
      output: totals.output + output,
      calls: totals.calls + 1,
      usd: Number((totals.usd + usd).toFixed(6))
    };

    // Twelve months is plenty of history for a small office.
    const months = { ...all, [month]: forMonth };
    const keep = Object.keys(months).sort().slice(-12);
    const trimmed = {};
    for (const key of keep) trimmed[key] = months[key];

    await writeSetting(USAGE_KEY, trimmed);
  } catch {
    /* usage tracking is never worth failing a request over */
  }
};

/* ---------- reading back ---------- */

const summary = async () => {
  const [all, rates, credit] = await Promise.all([
    readSetting(USAGE_KEY, {}),
    readRates(),
    readCredit()
  ]);

  const month = monthKey();
  const thisMonth = {};
  const allTime = {};

  for (const provider of PROVIDERS) {
    thisMonth[provider] = (all?.[month] || {})[provider] || blankTotals();

    const running = blankTotals();
    for (const key of Object.keys(all || {})) {
      const row = all[key]?.[provider];
      if (!row) continue;
      running.input += row.input || 0;
      running.output += row.output || 0;
      running.calls += row.calls || 0;
      running.usd += row.usd || 0;
    }
    running.usd = Number(running.usd.toFixed(6));
    allTime[provider] = running;
  }

  const balance = {};
  for (const provider of PROVIDERS) {
    const added = credit[provider].addedUsd;
    balance[provider] = {
      addedUsd: added,
      spentUsd: allTime[provider].usd,
      leftUsd: Number(Math.max(0, added - allTime[provider].usd).toFixed(4)),
      // Without a top-up figure there is nothing to count down from.
      tracked: added > 0,
      note: credit[provider].note
    };
  }

  return { month, thisMonth, allTime, rates, balance, months: all || {} };
};

module.exports = {
  PROVIDERS,
  DEFAULT_RATES,
  record,
  summary,
  readRates,
  saveRates,
  readCredit,
  saveCredit
};
