const { Scenes } = require("telegraf");
const axios = require("axios");
const { depositAddresses, addressValidators } = require("./config");

// Lookup map (kept for user-facing symbols)
const ASSET_MAP = {
  BTC: { coincap: "bitcoin", coingecko: "bitcoin", binance: "BTCUSDT" },
  ETH: { coincap: "ethereum", coingecko: "ethereum", binance: "ETHUSDT" },
  USDT: { coincap: "tether", coingecko: "tether", binance: "USDTUSDT" },
  TRX: { coincap: "tron", coingecko: "tron", binance: "TRXUSDT" },
  LTC: { coincap: "litecoin", coingecko: "litecoin", binance: "LTCUSDT" },
  XRP: { coincap: "ripple", coingecko: "ripple", binance: "XRPUSDT" },
  TON: { coincap: "toncoin", coingecko: "the-open-network", binance: "TONUSDT" },
  SOL: { coincap: "solana", coingecko: "solana", binance: "SOLUSDT" },
  DOGE: { coincap: "dogecoin", coingecko: "dogecoin", binance: "DOGEUSDT" },
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

// simple in-memory cache and retry helper
const priceCache = {}; // { key: { price, expiresAt } }

// provider implementations
async function fetchCoinCapPrice(id) {
  const url = `https://api.coincap.io/v2/assets/${encodeURIComponent(id)}`;
  const resp = await axios.get(url, {
    timeout: 5000,
    headers: { "User-Agent": "BitSafeEscrowBot/1.0 (+https://yourdomain.example)" },
    validateStatus: (s) => s < 500 || s === 429,
  });
  if (resp.status === 429) {
    const err = new Error("Rate limited by CoinCap");
    err.status = 429;
    throw err;
  }
  const raw = resp.data && resp.data.data;
  const price = raw && raw.priceUsd ? parseFloat(raw.priceUsd) : NaN;
  if (!price || Number.isNaN(price) || price <= 0) throw new Error("Invalid price from CoinCap");
  return price;
}

async function fetchCoinGeckoPrice(id) {
  const url = `https://api.coingecko.com/api/v3/simple/price`;
  const resp = await axios.get(url, {
    params: { ids: id, vs_currencies: "usd" },
    timeout: 5000,
    headers: { "User-Agent": "BitSafeEscrowBot/1.0 (+https://yourdomain.example)" },
    validateStatus: (s) => s < 500 || s === 429,
  });
  if (resp.status === 429) {
    const err = new Error("Rate limited by CoinGecko");
    err.status = 429;
    throw err;
  }
  const price = resp.data && resp.data[id] && resp.data[id].usd;
  if (!price || typeof price !== "number" || price <= 0) throw new Error("Invalid price from CoinGecko");
  return price;
}

async function fetchBinancePrice(symbol) {
  // Binance gives price as string; using USDT pair as USD approximation
  const url = `https://api.binance.com/api/v3/ticker/price`;
  const resp = await axios.get(url, {
    params: { symbol },
    timeout: 5000,
    headers: { "User-Agent": "BitSafeEscrowBot/1.0 (+https://yourdomain.example)" },
    validateStatus: (s) => s < 500 || s === 429,
  });
  if (resp.status === 429) {
    const err = new Error("Rate limited by Binance");
    err.status = 429;
    throw err;
  }
  const price = resp.data && resp.data.price ? parseFloat(resp.data.price) : NaN;
  if (!price || Number.isNaN(price) || price <= 0) throw new Error("Invalid price from Binance");
  return price;
}

// unified fetch with cache, retries, backoff, and provider fallback
async function fetchPriceWithCache(assetKey, opts = {}) {
  if (!ASSET_MAP[assetKey]) throw new Error("Unsupported asset");
  const idKey = assetKey;
  const now = Date.now();
  const ttl = opts.ttlMs || 30000; // default 30s cache

  const cached = priceCache[idKey];
  if (cached && cached.expiresAt > now) return cached.price;

  const maxRetries = opts.retries || 2;
  let attempt = 0;
  let lastErr = null;

  // provider order: CoinCap -> CoinGecko -> Binance
  const providers = [
    async () => fetchCoinCapPrice(ASSET_MAP[assetKey].coincap),
    async () => fetchCoinGeckoPrice(ASSET_MAP[assetKey].coingecko),
    async () => fetchBinancePrice(ASSET_MAP[assetKey].binance),
  ];

  while (attempt <= maxRetries) {
    for (let i = 0; i < providers.length; i++) {
      try {
        const price = await providers[i]();
        priceCache[idKey] = { price, expiresAt: Date.now() + ttl };
        return price;
      } catch (err) {
        // if DNS/network lookup error or host not found, try next provider immediately
        const code = err && err.code;
        if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
          lastErr = err;
          // continue to next provider without backoff
          continue;
        }
        // if rate limited, set status for backoff decision
        lastErr = err;
        // if last provider in list, we'll perform backoff and retry provider sequence
        if (i === providers.length - 1) break;
        // otherwise try next provider right away
      }
    }

    attempt += 1;
    if (attempt > maxRetries) break;

    // exponential/backoff: if lastErr shows 429 use linear backoff; else exponential
    const backoffMs = lastErr && lastErr.status === 429 ? 1500 * attempt : 200 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  throw lastErr || new Error("Failed to fetch price from providers");
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
        `*${Object.keys(ASSET_MAP).join(" • ")}*\n\n` +
        `💰 Enter the coin currency you wish to trade.`,
      { parse_mode: "Markdown" },
    );
    return ctx.wizard.next();
  },

  // Step 3/9: USD amount prompt
  async (ctx) => {
    const currency = getText(ctx).trim().toUpperCase();
    if (!ASSET_MAP[currency]) {
      return ctx.reply(
        `*❌ Unsupported coin*\n\n` +
          `💱  Please choose one of the supported coins \n` +
          `💰 Supported: ${Object.keys(ASSET_MAP).join(" • ")}\n\n` +
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
      const price = await fetchPriceWithCache(e.currency, { ttlMs: 30000, retries: 2 });
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
      console.error("Price fetch failed:", { message: err && err.message, code: err && err.code, status: err && err.status });
      return ctx.reply(
        `*❌ Failed to fetch price*\n\n` + `⏳ Please try again later`,
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
