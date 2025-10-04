// === FILE: index.js ===
// PumpFun / Helius token scanner
// - Receives Helius webhook(s) about newly minted tokens
// - Uses Moralis to fetch on-chain token metadata, holders and price data
// - Uses Upstash Redis to dedupe/cache processed tokens
// - Sends matching tokens to a Telegram bot when they pass filter rules

const express = require('express');
const axios = require('axios');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// we need rawBody for optional webhook signature validation
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// Env checks
const {
  PORT = 3000,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  MORALIS_API_KEY,
  MORALIS_API_BASE = 'https://deep-index.moralis.io/api/v2',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  HELIUS_WEBHOOK_SECRET,
  COINGECKO_FALLBACK = 'true'
} = process.env;

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.warn('Warning: Upstash Redis URL or token not set. Caching/deduplication will fail. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in env.');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const moralisClient = axios.create({
  baseURL: MORALIS_API_BASE,
  headers: {
    'X-API-Key': MORALIS_API_KEY,
    'accept': 'application/json'
  },
  timeout: 20_000
});

async function safeGet(url, opts = {}) {
  try {
    return await moralisClient.get(url, opts);
  } catch (err) {
    // return null so caller can try fallback
    console.warn('Moralis request failed:', url, err && err.message ? err.message : err);
    return null;
  }
}

// Helper: Telegram message sender
async function sendTelegramMarkdown(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing)');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    console.warn('Failed to send Telegram message:', err && err.message ? err.message : err);
  }
}

// Basic Helius webhook verification (optional) - uses HMAC-SHA256 of raw body
function verifyHeliusSignature(req) {
  if (!HELIUS_WEBHOOK_SECRET) return true; // not configured -> skip verification
  const sig = req.headers['x-helius-signature'] || req.headers['x-signature'] || req.headers['signature'];
  if (!sig) return false;
  try {
    const h = crypto.createHmac('sha256', HELIUS_WEBHOOK_SECRET);
    h.update(req.rawBody || '');
    const expected = h.digest('hex');
    return sig === expected;
  } catch (err) {
    return false;
  }
}

// Extract tokens from incoming Helius event payload. Helius payload formats vary depending on stream type,
// so we try multiple heuristics. The returned array contains objects: { chain, address, creator (optional) }
function extractTokensFromHelius(payload) {
  const out = [];
  // If pumpfun provided the token in a flat field
  if (!payload) return out;

  // Common variants
  if (payload.mint) out.push({ chain: payload.chain || 'solana', address: payload.mint, creator: payload.mintAuthority || payload.creator });
  if (payload.tokenAddress) out.push({ chain: payload.chain || 'ethereum', address: payload.tokenAddress, creator: payload.creator });

  // If 'tokens' array sent
  if (Array.isArray(payload.tokens)) {
    for (const t of payload.tokens) {
      if (t.address || t.mint) out.push({ chain: t.chain || payload.chain || 'unknown', address: t.address || t.mint, creator: t.creator || t.mintAuthority });
    }
  }

  // If raw transaction(s) provided, try to find initializeMint or create token instructions (best-effort)
  if (Array.isArray(payload.transactions)) {
    for (const tx of payload.transactions) {
      // Helius transaction objects sometimes have 'tokenTransfers' or 'tokenChanges'
      if (tx.tokenTransfers) {
        for (const tt of tx.tokenTransfers) {
          if (tt.tokenAddress) out.push({ chain: tx.chain || payload.chain || 'unknown', address: tt.tokenAddress, creator: tt.from });
        }
      }
      if (tx.tokenData) {
        for (const d of tx.tokenData) {
          if (d.mint) out.push({ chain: tx.chain || payload.chain || 'unknown', address: d.mint, creator: d.mintAuthority });
        }
      }
    }
  }

  // Deduplicate by address
  const map = new Map();
  for (const t of out) {
    if (!t.address) continue;
    const key = `${(t.chain||'').toLowerCase()}:${t.address.toLowerCase()}`;
    if (!map.has(key)) map.set(key, { chain: t.chain || 'unknown', address: t.address, creator: t.creator });
  }
  return Array.from(map.values());
}

// Fetch token metadata (totalSupply, decimals, symbol, name). We try a few Moralis endpoints (best-effort).
async function fetchTokenMetadata(chain, address) {
  if (!MORALIS_API_KEY) {
    console.warn('MORALIS_API_KEY not set - cannot fetch metadata');
    return null;
  }
  const a = address.toLowerCase();
  // Try common Moralis endpoints, in order
  const candidates = [
    `/erc20/${a}/metadata?chain=${encodeURIComponent(chain)}`,
    `/erc20/${a}?chain=${encodeURIComponent(chain)}`,
    `/token/${a}/metadata?chain=${encodeURIComponent(chain)}`
  ];

  for (const path of candidates) {
    const r = await safeGet(path);
    if (r && r.data) {
      // Heuristically map fields
      const d = r.data;
      const totalSupply = d.totalSupply || d.supply || d.total_supply || d.total_token_supply || d.total;
      const decimals = typeof d.decimals === 'number' ? d.decimals : (d.decimal || d.tokenDecimals || d.token_decimal || 18);
      const symbol = d.symbol || d.ticker || d.token_symbol;
      const name = d.name || d.token_name;
      if (totalSupply) {
        return { totalSupply: String(totalSupply), decimals: Number(decimals || 18), symbol, name };
      }
      // If not supply but other useful fields, still return partial
      return { totalSupply: null, decimals: Number(decimals || 18), symbol, name };
    }
  }
  return null;
}

// Fetch top holders (returns array of { address, balance } and optionally total count)
async function fetchTokenHolders(chain, address, limit = 200) {
  if (!MORALIS_API_KEY) {
    console.warn('MORALIS_API_KEY not set - cannot fetch holders');
    return null;
  }
  const a = address.toLowerCase();
  // Try common endpoints
  const candidates = [
    `/erc20/${a}/holders?chain=${encodeURIComponent(chain)}&limit=${limit}`,
    `/token/${a}/holders?chain=${encodeURIComponent(chain)}&limit=${limit}`
  ];

  for (const path of candidates) {
    const r = await safeGet(path);
    if (r && r.data) {
      // Some endpoints return { total, result: [..] }
      if (Array.isArray(r.data)) return r.data.map(x => ({ address: x.address || x.holder_of || x.owner, balance: x.balance || x.token_balance || x.amount }));
      if (Array.isArray(r.data.result)) return { total: r.data.total || r.data.result.length, holders: r.data.result.map(x => ({ address: x.address || x.holder_of || x.owner, balance: x.balance || x.token_balance || x.amount })) };
      // fallback if object with holders
      if (Array.isArray(r.data.holders)) return r.data.holders.map(x => ({ address: x.address, balance: x.balance }));
    }
  }

  // If Moralis didn't expose holders, return null (caller can decide fallback)
  return null;
}

// Fetch market data (price, marketCap, 24h volume). We try Moralis price endpoint, then CoinGecko fallback if enabled.
async function fetchTokenMarketData(chain, address) {
  // Try Moralis price endpoint
  if (MORALIS_API_KEY) {
    try {
      const path = `/erc20/${address.toLowerCase()}/price?chain=${encodeURIComponent(chain)}`;
      const r = await safeGet(path);
      if (r && r.data) {
        const data = r.data;
        // Heuristic mapping
        const price = data.usdPrice || data.price || data.usd_price || (data?.market_data?.current_price?.usd);
        const volume24h = data.volume24h || data['24hVolume'] || (data?.market_data?.total_volume?.usd);
        const marketCap = data.marketCap || data.market_cap || (price && data.totalSupply ? price * (Number(data.totalSupply) / Math.pow(10, data.decimals || 0)) : null) || (data?.market_data?.market_cap?.usd);
        return { price: price ? Number(price) : null, marketCap: marketCap ? Number(marketCap) : null, volume24h: volume24h ? Number(volume24h) : null };
      }
    } catch (err) {
      console.warn('Moralis price call failed:', err && err.message ? err.message : err);
    }
  }

  // CoinGecko fallback (works for many EVM chains)
  if (COINGECKO_FALLBACK === 'true') {
    try {
      // Map chain to CoinGecko platform id
      const map = { ethereum: 'ethereum', bsc: 'binance-smart-chain', 'binance-smart-chain': 'binance-smart-chain', polygon: 'polygon-pos', arbitrum: 'arbitrum-one' };
      const platform = map[chain?.toLowerCase()] || map[chain] || null;
      if (platform) {
        const cgUrl = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address.toLowerCase()}`;
        const r2 = await axios.get(cgUrl, { timeout: 20000 });
        if (r2 && r2.data && r2.data.market_data) {
          const md = r2.data.market_data;
          return { price: md.current_price?.usd || null, marketCap: md.market_cap?.usd || null, volume24h: md.total_volume?.usd || null };
        }
      }
    } catch (err) {
      console.warn('CoinGecko fallback failed:', err && err.message ? err.message : err);
    }
  }

  return { price: null, marketCap: null, volume24h: null };
}

function percentBigInt(numer, denom) {
  try {
    const n = BigInt(numer || '0');
    const d = BigInt(denom || '0');
    if (d === 0n) return 0;
    // keep two decimal places: compute scaled = floor(n * 10000 / d) -> result/100 is percent with 2 decimals
    const scaled = (n * 10000n) / d; // percent * 100
    return Number(scaled) / 100; // e.g., 1234 -> 12.34
  } catch (err) {
    return 0;
  }
}

async function processTokenEvent({ chain, address, creator }) {
  try {
    if (!address) return;
    const a = String(address).toLowerCase();
    const c = String(chain || 'unknown').toLowerCase();
    const key = `processed:${c}:${a}`;

    // Dedupe: skip if already processed in last 24h
    try {
      const already = await redis.get(key);
      if (already) {
        console.log('Already processed', c, a);
        return;
      }
    } catch (err) {
      console.warn('Redis get failed (continuing):', err && err.message ? err.message : err);
    }

    const meta = await fetchTokenMetadata(c, a);
    if (!meta) {
      console.log('No metadata for', a, 'chain', c);
      // mark short-lived so we don't keep retrying too frequently
      try { await redis.set(key, '1', { ex: 60 * 20 }); } catch (e) {}
      return;
    }

    // holders: attempt to get top holders list
    let holdersRaw = await fetchTokenHolders(c, a, 200);
    let holdersList = [];
    let holdersCount = 0;
    if (holdersRaw) {
      if (Array.isArray(holdersRaw)) {
        holdersList = holdersRaw.map(x => ({ address: x.address, balance: x.balance }));
        holdersCount = holdersList.length;
      } else if (holdersRaw.holders) {
        holdersList = holdersRaw.holders.slice(0, 200);
        holdersCount = holdersRaw.total || holdersRaw.holders.length;
      }
    }

    // If Moralis didn't provide holders, we cannot compute top10/dev percentages. Skip if requirement strict.
    if (!holdersRaw) {
      console.log('Holders info missing for', a, '- skipping');
      try { await redis.set(key, '1', { ex: 60 * 60 }); } catch (e) {}
      return;
    }

    // Top 10 percent
    // Convert balances strings to BigInt (expects raw token unit, not normalized)
    const topHolders = holdersList.slice(0, 10).map(h => ({ address: h.address, balance: BigInt(h.balance || '0') }));
    const topSum = topHolders.reduce((acc, h) => acc + (h.balance || 0n), 0n);

    const totalSupplyStr = meta.totalSupply || null;
    let totalSupplyBig = 0n;
    if (totalSupplyStr) {
      try {
        totalSupplyBig = BigInt(String(totalSupplyStr));
      } catch (err) {
        // If totalSupply can't parse, attempt to sanitize
        const digits = String(totalSupplyStr).replace(/[^0-9]/g, '') || '0';
        totalSupplyBig = BigInt(digits);
      }
    }

    if (totalSupplyBig === 0n) {
      console.log('Total supply missing or zero for', a, '- skipping');
      try { await redis.set(key, '1', { ex: 60 * 60 }); } catch (e) {}
      return;
    }

    const top10Percent = percentBigInt(topSum, totalSupplyBig);

    // Dev/creator hold percent: detect developer address
    let devPercent = 0;
    if (creator) {
      // Find creator balance in holders list if present
      const found = holdersList.find(h => (h.address || '').toLowerCase() === (creator || '').toLowerCase());
      if (found) {
        try {
          const devBal = BigInt(found.balance || '0');
          devPercent = percentBigInt(devBal, totalSupplyBig);
        } catch (err) { devPercent = 0; }
      } else {
        // fallback: if creator not in holders list, we can try to fetch its balance from Moralis (not implemented here)
        devPercent = 0;
      }
    } else {
      // if no creator provided, use top holder as probable dev
      const probableDev = holdersList[0];
      if (probableDev) {
        try {
          const devBal = BigInt(probableDev.balance || '0');
          devPercent = percentBigInt(devBal, totalSupplyBig);
        } catch (err) { devPercent = 0; }
      }
    }

    // holdersCount: prefer explicit total if present
    if (!holdersCount) holdersCount = holdersList.length || 0;

    // Market data
    const market = await fetchTokenMarketData(c, a);
    const marketCap = market.marketCap || null;
    const vol24h = market.volume24h || null;

    // Apply filters (user requirements)
    const minMarketCap = 15000; // USD
    const minHolders = 30;
    const maxTop10Percent = 20; // percent
    const maxDevPercent = 3; // percent

    const passed = (
      (marketCap && marketCap >= minMarketCap) &&
      (holdersCount && holdersCount >= minHolders) &&
      (top10Percent < maxTop10Percent) &&
      (devPercent < maxDevPercent) &&
      (vol24h && vol24h > 0)
    );

    if (!passed) {
      console.log(`Token ${a} did not pass filters. marketCap=${marketCap} holders=${holdersCount} top10%=${top10Percent} dev%=${devPercent} vol24h=${vol24h}`);
      // mark processed briefly so we don't spam rechecks
      try { await redis.set(key, '1', { ex: 60 * 60 * 6 }); } catch (e) {}
      return;
    }

    // Build message
    const lines = [];
    lines.push(`*New token passing filters*`);
    if (meta.name || meta.symbol) lines.push(`*${meta.name || ''}* (${meta.symbol || ''})`);
    lines.push(`Address: \`${a}\``);
    lines.push(`Chain: \`${c}\``);
    lines.push(`Market Cap: ${marketCap ? `$${Number(marketCap).toLocaleString()}` : 'N/A'}`);
    lines.push(`24h Volume: ${vol24h ? `$${Number(vol24h).toLocaleString()}` : 'N/A'}`);
    lines.push(`Holders: ${holdersCount}`);
    lines.push(`Top 10 holders share: ${top10Percent}%`);
    lines.push(`Dev/creator share: ${devPercent}%`);
    lines.push(`Explorer: https://www.google.com/search?q=${encodeURIComponent(a)}`); // placeholder; user should replace with chain-specific explorer link

    const text = lines.join('\n');
    await sendTelegramMarkdown(text);

    // Mark processed for 24 hours
    try { await redis.set(key, '1', { ex: 60 * 60 * 24 }); } catch (e) {}

    console.log('Token passed and message sent for', a);

  } catch (err) {
    console.error('processTokenEvent error:', err && err.stack ? err.stack : err);
  }
}

// Webhook endpoint for Helius
app.post('/webhook/helius', async (req, res) => {
  try {
    if (!verifyHeliusSignature(req)) {
      console.warn('Invalid Helius signature');
      return res.status(401).send('Invalid signature');
    }

    const payload = req.body;
    const tokens = extractTokensFromHelius(payload);
    if (!tokens.length) {
      // nothing to do
      return res.status(200).send('no tokens found');
    }

    // Process tokens in background (but we must respond immediately). We still execute actions synchronously here,
    // but we will not block too long: we will process each token but not wait too long.
    for (const t of tokens) {
      // fire-and-forget but await not used to keep webhook fast.
      processTokenEvent(t).catch(err => console.error('processTokenEvent error (catch):', err));
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook handler error:', err && err.stack ? err.stack : err);
    return res.status(500).send('server error');
  }
});

// Simple healthcheck
app.get('/health', (_req, res) => res.status(200).send('ok'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// === END FILE ===


/*
=== FILE: package.json ===
{
  "name": "pumpfun-helius-scanner",
  "version": "1.0.0",
  "description": "Token scanner that listens to Helius webhook and forwards tokens that match rules to Telegram",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "axios": "^1.4.0",
    "express": "^4.18.2",
    "@upstash/redis": "^1.20.0",
    "dotenv": "^16.0.0"
  }
}
=== END FILE ===
*/


/*
=== FILE: render.yaml ===
services:
  - type: web
    name: pumpfun-helius-scanner
    env: node
    plan: free
    region: oregon
    buildCommand: "npm install"
    startCommand: "npm start"
    envVars:
      - key: UPSTASH_REDIS_REST_URL
        sync: false
      - key: UPSTASH_REDIS_REST_TOKEN
        sync: false
      - key: MORALIS_API_KEY
        sync: false
      - key: MORALIS_API_BASE
        value: "https://deep-index.moralis.io/api/v2"
        sync: false
      - key: TELEGRAM_BOT_TOKEN
        sync: false
      - key: TELEGRAM_CHAT_ID
        sync: false
      - key: HELIUS_WEBHOOK_SECRET
        sync: false
      - key: COINGECKO_FALLBACK
        value: "true"
        sync: false

# Note: On Render you'll add the actual secret values through the dashboard. This file is a template.
=== END FILE ===
*/


/*
=== FILE: .env.example ===
PORT=3000
UPSTASH_REDIS_REST_URL=https://us1-prd-xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_token_here
MORALIS_API_KEY=your_moralis_api_key_here
MORALIS_API_BASE=https://deep-index.moralis.io/api/v2
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
TELEGRAM_CHAT_ID=987654321
HELIUS_WEBHOOK_SECRET=optional_secret_for_signature_verification
COINGECKO_FALLBACK=true
=== END FILE ===
*/


/*
=== FILE: README.md ===
# PumpFun / Helius Token Scanner

A small Node.js web service that listens for Helius webhooks (new token mints / token events), fetches token data via Moralis, caches/deduplicates via Upstash Redis and sends tokens that match your rules to a Telegram bot.

## Features
- Filters tokens by market cap, number of holders, top-10 holder concentration, developer share and 24h volume
- Uses Helius webhook as the source of new tokens
- Uses Moralis to fetch on-chain data (holders, supply) and price (best-effort)
- Upstash Redis for deduplication and short-term caching
- Sends alerts to Telegram

## Deployment
1. Create a new Web Service on Render.com and push this project. Use `npm start` as your start command.
2. Add environment variables in Render (or your host): see `.env.example` for required keys.
3. Configure a Helius webhook to POST to `https://<your-service>/webhook/helius`.
   - If you set `HELIUS_WEBHOOK_SECRET`, configure Helius (or your webhook sender) to HMAC-SHA256 the raw JSON body using that secret and send it in header `x-helius-signature`.

## Filters (adjustable in code)
- Minimum marketcap: $15,000
- Minimum holders: 30
- Top 10 holders share: < 20%
- Developer/creator share: < 3%
- 24h volume must be visible (non-zero)

## Notes and how to adapt
- Moralis endpoints may change or differ across plans. If you get 404s or different shapes, inspect the Moralis docs and adjust `fetchTokenMetadata`, `fetchTokenHolders` and `fetchTokenMarketData` helper functions accordingly.
- CoinGecko is used as a fallback for market data for many EVM chains. Set `COINGECKO_FALLBACK=false` to disable it.
- The code tries multiple heuristics for extracting token addresses from Helius payloads. If your Helius stream uses a different event shape, extend `extractTokensFromHelius`.
- Explorer link in the Telegram message is a placeholder (Google search). Replace it with a chain-specific explorer URL generator if you want direct links.

## To-do / improvements you might want
- Add robust rate-limiting / queueing for high-volume streams
- Improve Moralis fallback logic or use Chain-specific APIs (Helius RPC for Solana token info)
- Add unit tests and Dockerfile

## Quick start (local)
1. Copy `.env.example` -> `.env` and fill secrets.
2. `npm install`
3. `npm start`


Enjoy! If you want, I can also:
- Add a Dockerfile
- Swap the Moralis calls to Helius RPC for Solana-specific data
- Add a small web UI to show the last N alerted tokens

=== END FILE ===
*/
