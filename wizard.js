const { Scenes } = require("telegraf");
const axios = require("axios");
const { depositAddresses, addressValidators } = require("./config");

// CoinCap lookup map (asset ids used by CoinCap)
const CC_ID = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  TRX: "tron",
  LTC: "litecoin",
  XRP: "ripple",
  TON: "toncoin",
  SOL: "solana",
  DOGE: "dogecoin",
};

// Optional fallback: CoinGecko ids (used only if COINCAP fails)
const CG_ID = {
  bitcoin: "bitcoin",
  ethereum: "ethereum",
  tether: "tether",
  tron: "tron",
  litecoin: "litecoin",
  ripple: "ripple",
  toncoin: "toncoin",
  solana: "solana",
  dogecoin: "dogecoin",
};

// helper: get text safely from different update types
function getText(ctx) {
  if (ctx.message && ctx.message.text) return ctx.message.text;
  if (ctx.update && ctx.update.callback_query && ctx.update.callback_query.data)
    return ctx.update.callback_query.data;
  return "";
}

// helper: canonical escrow key per chat or fallback to user
function escrowKey(ctx) {
  return String((ctx.chat && ctx.chat.id) || (ctx.from && ctx.from.id) || "unknown");
}

// simple in-memory cache and retry helper for CoinCap
const priceCache = {}; // { key: { price, expiresAt } }

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function jitteredBackoff(baseMs, attempt) {
  const jitter = Math.floor(Math.random() * baseMs);
  return baseMs * Math.pow(2, attempt) + jitter;
}

/**
 * fetchPriceWithCache
 *  - primary: CoinCap single-asset endpoint
 *  - fallback: CoinGecko simple price endpoint (enabled when fallback param true)
 *  - robust retries, backoff with jitter, special handling for DNS ENOTFOUND
 *
 * opts:
 *  - ttlMs: cache TTL (ms)
 *  - retries: number of retry attempts (default 3)
 *  - fallback: boolean to enable fallback provider (default true)
 */
async function fetchPriceWithCache(id, opts = {}) {
  const key = id;
  const now = Date.now();
  const ttl = opts.ttlMs || 30000; // default 30s cache

  const cached = priceCache[key];
  if (cached && cached.expiresAt > now) return cached.price;

  const maxRetries = typeof opts.retries === "number" ? opts.retries : 3;
  const useFallback = typeof opts.fallback === "boolean" ? opts.fallback : true;

  let attempt = 0;
  let lastErr = null;

  const axiosBaseConfig = {
    timeout: 7000,
    headers: { "User-Agent": "BitSafeEscrowBot/1.0 (+https://telegram-bot-zqku.onrender.com)" },
    validateStatus: (s) => s < 500 || s === 429,
  };

  // Try primary provider (CoinCap)
  while (attempt <= maxRetries) {
    try {
      const url = `https://api.coincap.io/v2/assets/${encodeURIComponent(id)}`;
      const resp = await axios.get(url, axiosBaseConfig);

      if (resp.status === 429) {
        const err = new Error("Rate limited by CoinCap");
        err.status = 429;
        throw err;
      }

      const raw = resp.data && resp.data.data;
      const price = raw && raw.priceUsd ? parseFloat(raw.priceUsd) : NaN;
      if (!price || Number.isNaN(price) || price <= 0) {
        const err = new Error("Invalid price returned from CoinCap");
        err.status = resp.status;
        throw err;
      }

      priceCache[key] = { price, expiresAt: Date.now() + ttl };
      return price;
    } catch (err) {
      lastErr = err;
      // Immediate special handling for DNS unresolved errors: don't aggressively retry many times
      if (err && (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN")) {
        // attempt a couple of quick retries with small jitter then break to fallback
        attempt += 1;
        if (attempt > 2) break;
        const backoffMs = jitteredBackoff(300, attempt);
        await sleep(backoffMs);
        continue;
      }

      attempt += 1;
      if (attempt > maxRetries) break;

      // If rate-limited, apply smaller deterministic backoff; otherwise exponential jitter
      const backoffMs = err && err.status === 429 ? 1500 * attempt : jitteredBackoff(200, attempt);
      await sleep(backoffMs);
    }
  }

  // If enabled, try fallback provider (CoinGecko)
  if (useFallback) {
    try {
      // Map CoinCap id to CoinGecko id if possible
      const cgId = CG_ID[id] || id;
      // CoinGecko simple price endpoint returns prices in USD
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
        cgId,
      )}&vs_currencies=usd`;
      const resp = await axios.get(url, axiosBaseConfig);

      if (resp.status >= 400) {
        const err = new Error("CoinGecko returned error");
        err.status = resp.status;
        throw err;
      }

      const price = resp.data && resp.data[cgId] && resp.data[cgId].usd
        ? parseFloat(resp.data[cgId].usd)
        : NaN;

      if (!price || Number.isNaN(price) || price <= 0) {
        const err = new Error("Invalid price returned from CoinGecko");
        throw err;
      }

      priceCache[key] = { price, expiresAt: Date.now() + ttl };
      return price;
    } catch (err) {
      lastErr = err;
      // augment with a tag to indicate fallback also failed
      lastErr.fallbackFailed = true;
    }
  }

  // Throw best error available with useful properties for logging/handling
  const finalErr = lastErr instanceof Error ? lastErr : new Error("Failed to fetch price");
  throw finalErr;
}

const createEscrowWizard = new Scenes.WizardScene(
  "create-escrow",

  // Step 1/9: Seller’s Telegram handle
  async (ctx) => {
    await ctx.reply(
      `*🔹 Step 1/9*\n\n` +
        `🏷️  Enter the *seller’s Telegram username*. \n` +
        `• Must start with @ (e.g. @johndoe)`,
      { parse_mode: "Markdown" },
    );
    return ctx.wizard.next();
  },

  // Step 2/9: Coin symbol
  async (ctx) => {
    const handle = getText(ctx).trim();
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(handle)) {
      return ctx.reply(
        `*❌ Invalid Handle*\n\n` +
          `🚫 Handle must start with @\n` +
          `🔤 Only letters, numbers, or underscores allowed\n\n` +
          `🔁 Please try again.`,
        { parse_mode: "Markdown" },
      );
    }
    ctx.wizard.state.escrow = { sellerHandle: handle };

    await ctx.reply(
      `*🔹 Step 2/9*\n\n` +
        `🏷️ Listed Currencies:\n` +
        `*${Object.keys(CC_ID).join(" • ")}*\n\n` +
        `💰 Enter the coin currency you wish to trade.`,
      { parse_mode: "Markdown" },
    );
    return ctx.wizard.next();
  },

  // Step 3/9: USD amount prompt
  async (ctx) => {
    const currency = getText(ctx).trim().toUpperCase();
    if (!CC_ID[currency]) {
      return ctx.reply(
        `*❌ Unsupported coin*\n\n` +
          `💱  Please choose one of the supported coins \n` +
          `💰 Supported: ${Object.keys(CC_ID).join(" • ")}\n\n` +
          `🔁 Please try again.`,
        { parse_mode: "Markdown" },
      );
    }
    ctx.wizard.state.escrow.currency = currency;

    await ctx.reply(
      `🔹 Step 3/9\n\n` +
        `💵  Enter the amount in USD you wish to trade. \n` +
        `• (e.g 250)`,
    );
    return ctx.wizard.next();
  },

  // Step 4/9: Fetch price, compute crypto & ID, summary
  async (ctx) => {
    const usdAmount = parseFloat(getText(ctx).trim());
    if (isNaN(usdAmount) || usdAmount <= 0) {
      return ctx.reply(
        `*❌ Invalid USD amount*\n\n` +
          `ℹ️  Please enter a positive number in USD. \n` +
          `• (e.g 250)`,
        { parse_mode: "Markdown" },
      );
    }

    const e = ctx.wizard.state.escrow;
    e.usdAmount = usdAmount;

    try {
      // Use CoinCap asset id map
      const assetId = CC_ID[e.currency];
      const price = await fetchPriceWithCache(assetId, { ttlMs: 30000, retries: 3, fallback: true });
      e.cryptoAmount = (usdAmount / price).toFixed(8);
      e.id = Date.now().toString().slice(-6);

      await ctx.reply(
        `*📋 Escrow #${e.id}*\n\n` +
          `👤 Seller: ${e.sellerHandle}\n` +
          `💱 Coin: ${e.currency}\n` +
          `💵 Trade Size: $${e.usdAmount} → ${e.cryptoAmount} ${e.currency}`,
        { parse_mode: "Markdown" },
      );

      await ctx.reply(
        `🔹 Step 4/9\n\n` +
          `🏦  Enter the seller’s *on‑chain Deposit address*.`,
        { parse_mode: "Markdown" },
      );
      return ctx.wizard.next();
    } catch (err) {
      // Log detailed error for operators
      console.error("Price fetch failed:", {
        message: err && err.message,
        code: err && err.code,
        status: err && err.status,
        fallbackFailed: err && err.fallbackFailed,
      });

      // Surface a concise user-facing message
      // Distinguish DNS/network problems vs provider errors
      if (err && (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN")) {
        return ctx.reply(
          `*❌ Network error*\n\n` +
            `⛔ Unable to reach the price provider right now. Please check your network or try again in a few minutes.`,
          { parse_mode: "Markdown" },
        );
      }
      if (err && err.status === 429) {
        return ctx.reply(
          `*❌ Rate limited*\n\n` + `⏳ The price service is busy. Please wait and try again shortly.`,
          { parse_mode: "Markdown" },
        );
      }

      return ctx.reply(
        `*❌ Failed to fetch price*\n\n` + `⏳ Please try again later.`,
        { parse_mode: "Markdown" },
      );
    }
  },

  // Step 5/9: Seller’s deposit address
  async (ctx) => {
    const addr = getText(ctx).trim();
    const validate = addressValidators[ctx.wizard.state.escrow.currency];
    if (typeof validate !== "function" || !validate(addr)) {
      return ctx.reply(
        `*❌ Invalid Deposit Address*\n\n` +
          `🏦 Please try again with a valid on‑chain address`,
        { parse_mode: "Markdown" },
      );
    }
    ctx.wizard.state.escrow.depositAddress = addr;

    await ctx.reply(
      `*🔹 Step 5/9*\n\n` + `🏦  Enter the buyer’s *Refund address*. \n`,
      { parse_mode: "Markdown" },
    );
    return ctx.wizard.next();
  },

  // Step 6/9: Buyer’s refund address + interim summary
  async (ctx) => {
    const addr = getText(ctx).trim();
    const validate = addressValidators[ctx.wizard.state.escrow.currency];
    if (typeof validate !== "function" || !validate(addr)) {
      return ctx.reply(
        `*❌ Invalid Refund Address*\n\n` +
          `🏦 Please try again with a valid on‑chain address`,
        { parse_mode: "Markdown" },
      );
    }
    ctx.wizard.state.escrow.refundAddress = addr;

    const e = ctx.wizard.state.escrow;
    await ctx.reply(
      `*📜 Trade details for Escrow #${e.id}*\n\n` +
        `👤 Seller: ${e.sellerHandle}\n` +
        `💱 Coin: ${e.currency}\n` +
        `💵 Trade Size: $${e.usdAmount} → ${e.cryptoAmount} ${e.currency}\n` +
        `🏦 Deposit Address: ${e.depositAddress}\n` +
        `🏦 Refund Address: ${e.refundAddress}\n`,
      { parse_mode: "Markdown" },
    );

    const systemAddr = depositAddresses[e.currency];
    await ctx.reply(
      `🔹 Step 7/9\n\n` +
        `📤 Please deposit *${e.cryptoAmount} ${e.currency}* to:\n\n` +
        `🏦 ${systemAddr}`,
      { parse_mode: "Markdown" },
    );
    await ctx.reply(`📥 Once done, paste the *transaction ID (TXID)* below.`, {
      parse_mode: "Markdown",
    });
    return ctx.wizard.next();
  },

  // Step 7/9: TXID entry
  async (ctx) => {
    const txid = getText(ctx).trim();
    if (!txid || txid.length < 6) {
      return ctx.reply(
        `*❌ Invalid TXID*\n\n` + `🔗 Please paste the full transaction hash`,
        { parse_mode: "Markdown" },
      );
    }
    ctx.wizard.state.escrow.txid = txid;

    // Persist final escrow
    ctx.session = ctx.session || {};
    ctx.session.escrows = ctx.session.escrows || {};
    ctx.session.escrows[escrowKey(ctx)] = ctx.wizard.state.escrow;

    await ctx.reply("🎉 Funds detected! Generating final confirmation…");
    return ctx.wizard.next();
  },

  // Step 8/9: Final confirmation summary
  async (ctx) => {
    const e = ctx.wizard.state.escrow;
    await ctx.reply(
      `*🛡️ Escrow #${e.id} Complete!*\n\n` +
        `👤 Seller: ${e.sellerHandle}\n` +
        `💱 Coin: ${e.currency}\n` +
        `💵 Trade Size: $${e.usdAmount} → ${e.cryptoAmount} ${e.currency}\n` +
        `🏦 Deposit Addr: ${e.depositAddress}\n` +
        `🏦 Refund Addr: ${e.refundAddress}\n` +
        `🔗 TXID: ${e.txid}`,
      { parse_mode: "Markdown" },
    );
    return ctx.scene.leave();
  },
);

// scene-level cancel handler
createEscrowWizard.command("cancel", async (ctx) => {
  // remove any persisted escrow for this chat
  if (ctx.session && ctx.session.escrows) {
    delete ctx.session.escrows[escrowKey(ctx)];
  }
  await ctx.reply(
    `*🛑 Operation Canceled* \n` +
      `🗑️ All escrow data has been cleared.\n\n` +
      `🎯 Ready to trade?\n\n` +
      `🏁  /newescrow    — Start a new escrow\n` +
      `🔍  /status       — View your escrow details\n` +
      `🔓  /release      — Finalize an existing escrow\n` +
      `↩️  /refund       — Request a refund\n` +
      `🛑  /cancel       — Abort the current operation\n\n` +
      `🔄 Start over with */newescrow*`,
    { parse_mode: "Markdown" },
  );
  return ctx.scene.leave();
});

module.exports = createEscrowWizard;
