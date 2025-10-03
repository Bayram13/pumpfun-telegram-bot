const express = require("express");
const fetch = require("node-fetch");
const { Redis } = require("@upstash/redis");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Redis (Upstash) setup
let redis = null;
if (process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
  });
} else {
  console.log("[INFO] Upstash not configured - using in-memory dedupe. Persisted dedupe recommended in production.");
  redis = {
    cache: new Set(),
    async get(key) { return this.cache.has(key) ? 1 : null; },
    async set(key, val, opts) { this.cache.add(key); },
  };
}

// Telegram message sender
async function sendTelegramMessage(msg) {
  try {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: msg,
      }),
    });
  } catch (err) {
    console.error("[ERROR] Telegram send failed", err.message);
  }
}

// Poll Pumpfun API
async function pollOnce() {
  try {
    const resp = await fetch(process.env.PUMPFUN_API_URL, {
      headers: process.env.PUMPFUN_API_KEY ? { Authorization: `Bearer ${process.env.PUMPFUN_API_KEY}` } : {},
    });
    const tokens = await resp.json();

    for (const token of tokens) {
      const key = `seen:${token.address}`;
      const seen = await redis.get(key);
      if (seen) continue;
      await redis.set(key, 1, { ex: 3600 });

      // Apply filters
      if (token.marketcap < 15000) continue;
      if (token.holders < 30) continue;
      if (token.top10_holders_pct > 20) continue;
      if (token.dev_hold_pct > 3) continue;
      if (!token.volume_24h || token.volume_24h <= 0) continue;

      // Passed conditions -> send to Telegram
      const msg = `🔥 Yeni Token:

CA: ${token.address}
MC: $${token.marketcap}
Holders: ${token.holders}
Top 10 Holders: ${token.top10_holders_pct}%
Dev Hold: ${token.dev_hold_pct}%
Volume 24h: $${token.volume_24h}`;
      await sendTelegramMessage(msg);
    }
  } catch (err) {
    console.error("[ERROR] pollOnce failed", err.message);
  }
}

setInterval(pollOnce, 15000);

app.get("/", (req, res) => res.send("Pumpfun Telegram Bot running"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`[INFO] server listening on port ${PORT}`);
});
