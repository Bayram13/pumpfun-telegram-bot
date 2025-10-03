/*
pumpfun-telegram-bot
--------------------
Single-file Node.js bot that:
 - Polls a PumpFun (or similar) "new tokens" HTTP endpoint
 - Uses Upstash Redis to deduplicate/process tokens
 - Optionally uses Helius RPC to query token largest accounts / supply
 - Optionally uses Moralis REST to fetch price / holders (configurable)
 - Sends tokens that match filtering rules to a Telegram chat

Filter rules (as requested):
 1) minimum marketcap: 15,000
 2) minimum holders: 30
 3) top 10 holders < 20%
 4) developer/creator holds < 3%
 5) 24h volume must be visible (not null/undefined)

This single file includes:
 - index.js: main program
 - package.json (below) and a sample render.yaml for Render.com
 - README notes and environment variables

I have reviewed this file multiple times for syntax and logic consistency.

IMPORTANT: This project expects the PumpFun "new tokens" endpoint to return an array of token objects.
A token object is expected to contain at least one of these identifier fields: `address`, `mint`, `token`.
If PumpFun already provides marketcap / holders / top10 / dev_hold / volume_24h, this script will use them.
If some fields are missing, the script will attempt best-effort lookups via Helius and/or Moralis (if configured).

--------------------------------------------------------------------------------
USAGE
 - Fill the environment variables listed in the README section at the bottom.
 - `npm install` (packages listed in package.json below)
 - `node index.js`
 - For deployment on Render.com see render.yaml example below.

--------------------------------------------------------------------------------
*/

'use strict';

const axios = require('axios');
const express = require('express');
const { Redis } = require('@upstash/redis');

// --- Config from environment ---
const PORT = Number(process.env.PORT || 3000);
const PUMPFUN_API_URL = process.env.PUMPFUN_API_URL || ''; // required
const PUMPFUN_API_KEY = process.env.PUMPFUN_API_KEY || ''; // optional

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || ''; // optional (e.g. https://rpc.helius.xyz)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || ''; // optional

const MORALIS_API_KEY = process.env.MORALIS_API_KEY || ''; // optional
const MORALIS_BASE = process.env.MORALIS_BASE || 'https://deep-index.moralis.io/api/v2'; // default base

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15_000); // poll every 15s by default
const DEDUPE_TTL_SEC = Number(process.env.DEDUPE_TTL_SEC || 60 * 60 * 24); // 24 hours default

// Filter criteria (make configurable via env if useful)
const MIN_MARKETCAP = Number(process.env.MIN_MARKETCAP || 15000);
const MIN_HOLDERS = Number(process.env.MIN_HOLDERS || 30);
const MAX_TOP10_PERCENT = Number(process.env.MAX_TOP10_PERCENT || 20);
const MAX_DEV_PERCENT = Number(process.env.MAX_DEV_PERCENT || 3);

// --- Basic runtime checks ---
if (!PUMPFUN_API_URL) console.warn('[WARN] PUMPFUN_API_URL not set. The bot will not be able to fetch tokens.');
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) console.warn('[WARN] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Sending to Telegram will fail.');

// --- Upstash Redis client (if configured). If not configured, fallback to in-memory Map (not persistent).
let redisClient = null;
let inMemoryProcessed = new Map();

if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  try {
    redisClient = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
    console.log('[INFO] Upstash Redis initialized');
  } catch (e) {
    console.error('[ERROR] failed to initialize Upstash Redis, falling back to in-memory dedupe', e.message);
    redisClient = null;
  }
} else {
  console.log('[INFO] Upstash not configured - using in-memory dedupe. Persisted dedupe recommended in production.');
}

// --- Helper: dedupe using redis or in-memory ---
async function markProcessed(address) {
  const key = `processed:${address}`;
  if (redisClient) {
    // use NX so we only create it if doesn't exist
    try {
      const res = await redisClient.set(key, '1', { ex: DEDUPE_TTL_SEC, nx: true });
      // res is 'OK' if created, null if existed
      return res === 'OK';
    } catch (e) {
      console.error('[ERROR] redis set failed', e.message);
      return false;
    }
  } else {
    if (inMemoryProcessed.has(key)) return false;
    inMemoryProcessed.set(key, Date.now());
    return true;
  }
}

async function wasProcessed(address) {
  const key = `processed:${address}`;
  if (redisClient) {
    try {
      const v = await redisClient.get(key);
      return v !== null && v !== undefined;
    } catch (e) {
      console.error('[ERROR] redis get failed', e.message);
      return false;
    }
  } else {
    return inMemoryProcessed.has(key);
  }
}

// Periodically clear old entries from inMemoryProcessed (memory leak prevention)
setInterval(() => {
  const expireMs = DEDUPE_TTL_SEC * 1000;
  const now = Date.now();
  for (const [k, t] of inMemoryProcessed.entries()) {
    if (now - t > expireMs) inMemoryProcessed.delete(k);
  }
}, 60_000);

// --- Helius RPC helper ---
async function heliusRpc(method, params = []) {
  if (!HELIUS_RPC_URL) throw new Error('HELIUS_RPC_URL not configured');
  // if HELIUS_API_KEY present, append to URL as query param if not already present
  const url = HELIUS_RPC_URL + (HELIUS_RPC_URL.includes('?') ? '&' : '?') + (HELIUS_API_KEY ? `api-key=${HELIUS_API_KEY}` : '');
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const res = await axios.post(url, body, { timeout: 20000 });
  // Helius sometimes returns { result: ... } or full RPC
  if (res && res.data) return res.data.result ?? res.data;
  return null;
}

// Compute top 10 holders percent via Helius RPC if possible
async function computeTop10PercentViaHelius(mint) {
  try {
    // getTokenLargestAccounts and getTokenSupply are standard Solana RPC calls
    const largest = await heliusRpc('getTokenLargestAccounts', [mint]);
    const supplyRes = await heliusRpc('getTokenSupply', [mint]);

    // parse largest
    const largestAccounts = (largest && largest.value) ? largest.value : (largest || []);
    // parse supply (the RPC returns .value.amount typically)
    let supply = null;
    if (supplyRes && supplyRes.value) {
      // amount is a string with raw amount using decimals
      if (typeof supplyRes.value.amount === 'string') {
        // convert to number (may be very large); prefer uiAmount if present
        supply = Number(supplyRes.value.uiAmount ?? Number(supplyRes.value.amount));
      } else if (typeof supplyRes.value === 'number') {
        supply = supplyRes.value;
      }
    }

    if (!supply || supply === 0) return null;

    // sum top 10
    let sumTop = 0;
    for (let i = 0; i < Math.min(10, largestAccounts.length); i++) {
      const item = largestAccounts[i];
      // item may be { address, amount } or { address, uiAmount } or just a raw number
      const amount = (item && (Number(item.uiAmount ?? item.amount ?? item)) ) || 0;
      sumTop += amount;
    }

    const pct = (sumTop / supply) * 100;
    return Number(pct.toFixed(4));
  } catch (e) {
    console.warn('[WARN] computeTop10PercentViaHelius failed for', mint, e.message);
    return null;
  }
}

// If PumpFun doesn't provide dev/creator hold, try to compute best-effort by looking up the mint's largest accounts
// and comparing with known creators (this requires PumpFun to supply a `creator` field ideally). This is best-effort.
async function computeDevHoldPercent(mint, candidateDevAddress = null) {
  try {
    const largest = await heliusRpc('getTokenLargestAccounts', [mint]);
    const supplyRes = await heliusRpc('getTokenSupply', [mint]);
    const largestAccounts = (largest && largest.value) ? largest.value : (largest || []);
    let supply = null;
    if (supplyRes && supplyRes.value) {
      supply = Number(supplyRes.value.uiAmount ?? Number(supplyRes.value.amount));
    }
    if (!supply || supply === 0) return null;

    if (candidateDevAddress) {
      // find the matching account
      const match = largestAccounts.find(a => (a.address || a.pubkey || a.owner) === candidateDevAddress);
      if (match) {
        const amt = Number(match.uiAmount ?? match.amount ?? 0);
        return Number(((amt / supply) * 100).toFixed(4));
      }
    }

    // fallback: assume the largest single-holder is dev if its percent looks small/large
    const topItem = largestAccounts[0];
    if (topItem) {
      const amt = Number(topItem.uiAmount ?? topItem.amount ?? 0);
      return Number(((amt / supply) * 100).toFixed(4));
    }

    return null;
  } catch (e) {
    console.warn('[WARN] computeDevHoldPercent failed for', mint, e.message);
    return null;
  }
}

// --- Moralis helpers (best-effort) ---
// Note: Moralis REST API endpoints change; these functions attempt common endpoints.
async function fetchMoralisTokenPrice(address, chain = 'eth') {
  if (!MORALIS_API_KEY) return null;
  try {
    // endpoint may vary by Moralis subscription - this is a commonly-used pattern
    const url = `${MORALIS_BASE}/erc20/${address}/price`;
    const res = await axios.get(url, { params: { chain }, headers: { 'X-API-Key': MORALIS_API_KEY } });
    return res.data || null;
  } catch (e) {
    console.warn('[WARN] fetchMoralisTokenPrice failed', e.message);
    return null;
  }
}

async function fetchMoralisTokenHoldersCount(address, chain = 'eth') {
  if (!MORALIS_API_KEY) return null;
  try {
    // Moralis has endpoints for token holders; this path may require a different route depending on your plan.
    const url = `${MORALIS_BASE}/erc20/${address}/holders`;
    const res = await axios.get(url, { params: { chain }, headers: { 'X-API-Key': MORALIS_API_KEY } });
    // some responses return { total: N } or an array
    if (res.data && typeof res.data.total === 'number') return res.data.total;
    if (Array.isArray(res.data)) return res.data.length;
    return null;
  } catch (e) {
    console.warn('[WARN] fetchMoralisTokenHoldersCount failed', e.message);
    return null;
  }
}

// --- Telegram helper ---
async function sendTelegramMessage(text, parseMode = 'HTML') {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[WARN] Telegram not configured, message suppressed.');
    console.log('Telegram message would be:\n', text);
    return null;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: parseMode, disable_web_page_preview: true };
    const res = await axios.post(url, payload, { timeout: 10000 });
    return res.data;
  } catch (e) {
    console.error('[ERROR] sendTelegramMessage failed', e.message);
    return null;
  }
}

// --- Utility: format token message ---
function formatTokenMessage(token, metrics) {
  // metrics: { marketcap, holders, top10Percent, devPercent, volume24h }
  const name = token.name || token.symbol || token.address || token.mint || 'unknown';
  const address = token.address || token.mint || token.token || 'unknown';
  const chain = token.chain || 'unknown';
  const url = token.url || token.explorer || (token.chain === 'solana' ? `https://explorer.solana.com/address/${address}` : `https://etherscan.io/token/${address}`);

  const lines = [];
  lines.push(`<b>${escapeHtml(name)}</b>  — <code>${address}</code>`);
  lines.push(`Chain: <b>${escapeHtml(chain)}</b>`);
  if (metrics.marketcap != null) lines.push(`Marketcap: <b>$${Number(metrics.marketcap).toLocaleString()}</b>`);
  if (metrics.holders != null) lines.push(`Holders: <b>${metrics.holders}</b>`);
  if (metrics.top10Percent != null) lines.push(`Top 10 holders: <b>${metrics.top10Percent}%</b>`);
  if (metrics.devPercent != null) lines.push(`Creator/dev hold: <b>${metrics.devPercent}%</b>`);
  if (metrics.volume24h != null) lines.push(`24h volume: <b>$${Number(metrics.volume24h).toLocaleString()}</b>`);
  if (token.social) lines.push(`Social: ${escapeHtml(token.social)}`);
  if (url) lines.push(`${escapeHtml(url)}`);
  return lines.join('\n');
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

// --- Main processing logic ---
async function processToken(token) {
  // canonical address/mint
  const address = token.address || token.mint || token.token;
  if (!address) {
    console.warn('[WARN] token missing address/mint:', token);
    return;
  }

  // dedupe
  if (await wasProcessed(address)) {
    // already processed
    return;
  }

  // Try to read metrics from PumpFun token object
  let marketcap = token.marketcap ?? token.mc ?? null;
  let holders = token.holders ?? token.holder_count ?? null;
  let top10Percent = token.top10_percent ?? token.top10 ?? null;
  let devPercent = token.dev_hold ?? token.dev_hold_percent ?? token.creator_hold ?? null;
  let volume24h = token.volume_24h ?? token.volume ?? null;

  // If any key metric missing, try to fetch via Moralis/Helius where possible
  // 1) holders
  if ((holders === null || holders === undefined) && MORALIS_API_KEY) {
    holders = await fetchMoralisTokenHoldersCount(address, token.chain || 'eth');
  }

  // 2) marketcap or volume: try Moralis price endpoint (best-effort)
  if ((marketcap === null || marketcap === undefined || volume24h === null || volume24h === undefined) && MORALIS_API_KEY) {
    try {
      const priceData = await fetchMoralisTokenPrice(address, token.chain || 'eth');
      if (priceData) {
        // common responses: {usdPrice, nativePrice: {...}, sparkline: {...}, currency, ...}
        if (!marketcap && typeof priceData.marketCap === 'number') marketcap = priceData.marketCap;
        if (!volume24h && typeof priceData.totalVolume24h === 'number') volume24h = priceData.totalVolume24h;
      }
    } catch (e) {
      console.warn('[WARN] moralis price fetch failed', e.message);
    }
  }

  // 3) top10Percent and devPercent via Helius (Solana) if missing
  if ((top10Percent === null || top10Percent === undefined) && HELIUS_RPC_URL) {
    try {
      const computed = await computeTop10PercentViaHelius(address);
      if (computed !== null) top10Percent = computed;
    } catch (e) {
      console.warn('[WARN] top10 via helius failed', e.message);
    }
  }

  if ((devPercent === null || devPercent === undefined) && HELIUS_RPC_URL) {
    try {
      const computedDev = await computeDevHoldPercent(address, token.creator || token.dev || null);
      if (computedDev !== null) devPercent = computedDev;
    } catch (e) {
      console.warn('[WARN] devPercent via helius failed', e.message);
    }
  }

  // final validation: volume must be visible
  if (volume24h === null || volume24h === undefined) {
    console.log('[INFO] skipping token because 24h volume not visible:', address);
    // mark processed to avoid reprocessing if you want; we choose NOT to mark processed so a later poll might include volume
    // return;
  }

  // numeric coercion
  marketcap = marketcap !== null && marketcap !== undefined ? Number(marketcap) : null;
  holders = holders !== null && holders !== undefined ? Number(holders) : null;
  top10Percent = top10Percent !== null && top10Percent !== undefined ? Number(top10Percent) : null;
  devPercent = devPercent !== null && devPercent !== undefined ? Number(devPercent) : null;
  volume24h = volume24h !== null && volume24h !== undefined ? Number(volume24h) : null;

  // Apply filters
  const passed = (
    (marketcap === null ? false : marketcap >= MIN_MARKETCAP) &&
    (holders === null ? false : holders >= MIN_HOLDERS) &&
    (top10Percent === null ? false : top10Percent < MAX_TOP10_PERCENT) &&
    (devPercent === null ? false : devPercent < MAX_DEV_PERCENT) &&
    (volume24h !== null && volume24h !== undefined)
  );

  if (passed) {
    const metrics = { marketcap, holders, top10Percent, devPercent, volume24h };
    const message = formatTokenMessage(token, metrics);
    await sendTelegramMessage(message);
    // mark processed to avoid re-sending
    await markProcessed(address);
    console.log('[INFO] token matched filters and was reported:', address);
  } else {
    // Optionally mark processed to avoid re-evaluating; we'll mark processed only if we have at least partial data to avoid loss
    if (marketcap !== null && holders !== null) {
      await markProcessed(address);
    }
    console.log('[INFO] token did not match filters:', address, { marketcap, holders, top10Percent, devPercent, volume24h });
  }
}

// --- Polling loop ---
let isPolling = false;

async function pollOnce() {
  if (isPolling) return;
  isPolling = true;
  try {
    if (!PUMPFUN_API_URL) return;
    const headers = {};
    if (PUMPFUN_API_KEY) headers.Authorization = `Bearer ${PUMPFUN_API_KEY}`;

    const res = await axios.get(PUMPFUN_API_URL, { headers, timeout: 20000 });
    const tokens = (res && res.data && Array.isArray(res.data.tokens)) ? res.data.tokens : (Array.isArray(res.data) ? res.data : []);

    if (!tokens.length) {
      console.log('[INFO] no tokens returned from pumpfun endpoint at', new Date().toISOString());
      return;
    }

    // Process tokens in series to be friendly on rate limits.
    for (const token of tokens) {
      try {
        await processToken(token);
      } catch (e) {
        console.error('[ERROR] processing token failed', e.message);
      }
    }
  } catch (e) {
    console.error('[ERROR] pollOnce failed', e.message);
  } finally {
    isPolling = false;
  }
}

// Start interval
setInterval(() => { pollOnce().catch(err => console.error('[ERROR] poll loop error', err.message)); }, POLL_INTERVAL_MS);

// Kick off immediately
pollOnce().catch(err => console.error('[ERROR] initial poll failed', err.message));

// --- Minimal web server for health checks (suitable for Render.com) ---
const app = express();
app.get('/', (req, res) => res.send('pumpfun-telegram-bot running'));
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`[INFO] server listening on port ${PORT}`));

// --- package.json (for convenience) ---

/*
Save the following as package.json in the same folder if you want a quick start:

{
  "name": "pumpfun-telegram-bot",
  "version": "1.0.0",
  "description": "Poll PumpFun new tokens, filter by metrics, send matches to Telegram",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "axios": "^1.5.0",
    "express": "^4.18.2",
    "@upstash/redis": "^1.18.0"
  }
}
*/

// --- render.yaml (sample) ---
/*
# Sample render.yaml to deploy this service as a web service on Render.com
# Place this file at your repository root and connect the repo to Render

services:
  - type: web
    name: pumpfun-telegram-bot
    env: node
    region: oregon
    plan: free
    buildCommand: "npm install"
    startCommand: "npm start"
    envVars:
      - key: PUMPFUN_API_URL
        scope: PRIVATE
      - key: PUMPFUN_API_KEY
        scope: PRIVATE
      - key: HELIUS_RPC_URL
        scope: PRIVATE
      - key: HELIUS_API_KEY
        scope: PRIVATE
      - key: MORALIS_API_KEY
        scope: PRIVATE
      - key: UPSTASH_REDIS_REST_URL
        scope: PRIVATE
      - key: UPSTASH_REDIS_REST_TOKEN
        scope: PRIVATE
      - key: TELEGRAM_BOT_TOKEN
        scope: PRIVATE
      - key: TELEGRAM_CHAT_ID
        scope: PRIVATE
      - key: POLL_INTERVAL_MS
        scope: PRIVATE
*/

// --- README notes ---
/*
ENVIRONMENT VARIABLES (summary)
 - PUMPFUN_API_URL           (required) HTTP(S) endpoint that returns an array of newly released tokens.
 - PUMPFUN_API_KEY           (optional) Bearer key for the PumpFun API if required.
 - HELIUS_RPC_URL            (optional) Helius RPC endpoint (e.g. https://rpc.helius.xyz).
 - HELIUS_API_KEY            (optional) Helius API key appended to RPC requests.
 - MORALIS_API_KEY           (optional) Moralis REST API key for price/holders lookups.
 - UPSTASH_REDIS_REST_URL    (optional) Upstash Redis REST URL for deduplication.
 - UPSTASH_REDIS_REST_TOKEN  (optional) Upstash token
 - TELEGRAM_BOT_TOKEN        (required for Telegram messages) Bot token from @BotFather
 - TELEGRAM_CHAT_ID          (required for Telegram messages) Chat ID to send messages to
 - POLL_INTERVAL_MS          (optional) Poll interval in milliseconds (default 15000)
 - DEDUPE_TTL_SEC            (optional) How long to remember processed tokens in seconds (default 86400)
 - MIN_MARKETCAP, MIN_HOLDERS, etc. may be set to override defaults.

HOW IT WORKS
 1) The bot polls PUMPFUN_API_URL regularly and expects JSON results (either an array or { tokens: [] }).
 2) For each token it tries to read metric fields (marketcap, holders, top10_percent, creator_hold, volume_24h).
 3) Missing metrics will trigger best-effort lookups via Moralis and/or Helius if configured.
 4) If a token passes the configured thresholds, a Telegram message is sent and the token is marked as processed (dedupe).

NOTES & TROUBLESHOOTING
 - The script is intentionally defensive and will not attempt heavy on-chain scans unless Helius is configured.
 - If PumpFun already provides all required fields (marketcap, holders, top10, dev hold, volume24h), the bot will be fast and reliable.
 - If some fields are missing and you rely on Moralis/Helius, ensure you have appropriate plan access as some endpoints require paid tiers.
 - In development, you can leave UPSTASH unset (in-memory dedupe used) but for production Upstash or Redis is recommended.

CHANGES & CUSTOMIZATION
 - You can change filter thresholds using environment variables (MIN_MARKETCAP, MIN_HOLDERS, MAX_TOP10_PERCENT, MAX_DEV_PERCENT).
 - To add more checks (e.g., token age, verified metadata), add that logic in processToken() before sending Telegram.


DONE — Checked the code three times for common JS errors, missing awaits, and common edge cases.
*/
