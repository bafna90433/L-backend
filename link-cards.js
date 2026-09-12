/* ------------------------------------------------------------------
   Link cards for AI answers.

   An answer is much easier to act on when its sources look like cards —
   product photo, page title, site name — instead of bare URLs. For each
   link an AI cites we:

     1. follow redirects to the real page (Gemini cites redirect URLs),
     2. read the page's OpenGraph image/title/site,
     3. fall back to the site's favicon when the page blocks us
        (Amazon, Flipkart and most shopping sites do),
     4. optionally look the page up through Google Programmable Search
        to get a real product image when OG is unavailable.

   Nothing here is required for an answer to work — every step fails
   soft and the answer is returned regardless.
   ------------------------------------------------------------------ */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 7000;
const MAX_HTML_BYTES = 250000;
const MAX_CARDS = 6;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const cache = new Map(); // url -> { at, card }

// Product-photo CDNs used by the sites that block OpenGraph scraping.
const PRODUCT_IMAGE_PATTERNS = [
  /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png)/i,
  /https:\/\/rukminim[0-9]*\.flixcart\.com\/image\/[^"'\ ]+/i,
  /https:\/\/cdn[0-9]*\.smartprix\.com\/[^"'\ ]+\.(?:jpg|jpeg|png|webp)/i
];

/** Pull one meta tag's content, whatever order the attributes are in. */
function metaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, 'i')
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return match[1].trim();
  }
  return null;
}

function decodeEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const faviconFor = host => `https://www.google.com/s2/favicons?domain=${host}&sz=64`;

const prettySite = host => host.replace(/^www\./, '');

/** Fetch a page and read its OpenGraph card. Returns what it could get. */
async function readPage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  const finalUrl = response.url || url;
  const host = new URL(finalUrl).hostname;

  // Blocked or non-HTML: we still know the site, so the card is usable.
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.includes('html')) {
    return { url: finalUrl, host, title: null, image: null, site: null };
  }

  const html = (await response.text()).slice(0, MAX_HTML_BYTES);

  const title =
    metaContent(html, 'og:title') ||
    metaContent(html, 'twitter:title') ||
    (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] ||
    null;

  let image = metaContent(html, 'og:image') || metaContent(html, 'twitter:image');

  // The big Indian shopping sites ship no OpenGraph image, but their product
  // photos sit on well-known CDNs — pick the first one off the page.
  if (!image) {
    for (const pattern of PRODUCT_IMAGE_PATTERNS) {
      const match = html.match(pattern);
      if (match) { image = match[0]; break; }
    }
  }

  if (image && image.startsWith('//')) image = 'https:' + image;
  if (image && image.startsWith('/')) image = new URL(image, finalUrl).href;

  // Cloudflare / bot walls return a real page with a useless title.
  const blocked = /just a moment|attention required|are you a robot|access denied/i.test(title || '');

  return {
    url: finalUrl,
    host,
    title: blocked ? null : decodeEntities(title),
    image: blocked ? null : image,
    site: decodeEntities(metaContent(html, 'og:site_name'))
  };
}

/**
 * Google Programmable Search image lookup — the only reliable way to get a
 * product photo for sites that block scraping. Optional: without a search
 * engine id configured, cards simply use the site favicon instead.
 */
async function searchImage(query, config) {
  const { cseId, cseKey } = config || {};
  if (!cseId || !cseKey || !query) return null;

  try {
    const params = new URLSearchParams({
      key: cseKey,
      cx: cseId,
      q: query,
      searchType: 'image',
      num: '1',
      safe: 'active'
    });
    const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.items?.[0]?.link || null;
  } catch {
    return null;
  }
}

/**
 * Build display cards for the links an AI cited.
 *
 * @param {{url: string, title?: string}[]} links
 * @param {{cseId?: string, cseKey?: string}} [config]
 */
async function buildCards(links, config) {
  if (!Array.isArray(links) || !links.length) return [];

  const unique = [];
  const seen = new Set();
  for (const link of links) {
    if (!link?.url || seen.has(link.url)) continue;
    seen.add(link.url);
    unique.push(link);
    if (unique.length >= MAX_CARDS) break;
  }

  const now = Date.now();

  const cards = await Promise.all(
    unique.map(async link => {
      const cached = cache.get(link.url);
      if (cached && now - cached.at < CACHE_TTL_MS) {
        return { ...cached.card, title: cached.card.title || link.title || cached.card.host };
      }

      let page;
      try {
        page = await readPage(link.url);
      } catch {
        // Unreachable from the server — still show the link itself.
        let host = '';
        try { host = new URL(link.url).hostname; } catch { /* keep blank */ }
        page = { url: link.url, host, title: null, image: null, site: null };
      }

      if (!page.image) {
        page.image = await searchImage(link.title || page.title || page.host, config);
      }

      const card = {
        url: page.url,
        title: decodeEntities(page.title || link.title || page.host || page.url),
        site: page.site || prettySite(page.host || ''),
        host: page.host || '',
        image: page.image || null,
        favicon: page.host ? faviconFor(page.host) : null
      };

      cache.set(link.url, { at: now, card });
      return card;
    })
  );

  return cards.filter(card => card.url);
}

module.exports = { buildCards };
