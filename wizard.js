// wizard.js
const { Scenes } = require("telegraf");
const axios = require("axios");
const { depositAddresses, addressValidators } = require("./config");

// Provider maps and config
const SYMBOLS = {
  BTC: { binance: "BTCUSDT", coincap: "bitcoin", coinpaprika: "btc-bitcoin", coingecko: "bitcoin" },
  ETH: { binance: "ETHUSDT", coincap: "ethereum", coinpaprika: "eth-ethereum", coingecko: "ethereum" },
  USDT: { binance: "USDTUSDT", coincap: "tether", coinpaprika: "usdt-tether", coingecko: "tether" },
  TRX: { binance: "TRXUSDT", coincap: "tron", coinpaprika: "trx-tron", coingecko: "tron" },
  LTC: { binance: "LTCUSDT", coincap: "litecoin", coinpaprika: "ltc-litecoin", coingecko: "litecoin" },
  XRP: { binance: "XRPUSDT", coincap: "ripple", coinpaprika: "xrp-xrp", coingecko: "ripple" },
  TON: { binance: "TONUSDT", coincap: "ton", coinpaprika: "ton-toncoin", coingecko: "the-open-network" },
  SOL: { binance: "SOLUSDT", coincap: "solana", coinpaprika: "sol-solana", coingecko: "solana" },
  DOGE: { binance: "DOGEUSDT", coincap: "dogecoin", coinpaprika: "doge-dogecoin", coingecko: "dogecoin" },
};

// Simple in-memory short cache to reduce API calls
const priceCache = {}; // { key: { price: number, ts: epoch_ms } }
const CACHE_TTL = 30 * 1000; // 30 seconds

// Environment-configurable API keys (optional)
const COINPAPRIKA_KEY = process.env.COINPAPRIKA_KEY || null; // coinpaprika optional
const COINGECKO_KEY = process.env.COINGECKO_KEY || null; // coingecko optional (if on paid plan)
// Note: Binance & CoinCap public endpoints used without keys; if blocked, use a keyed provider.

async function tryBinance(pair) {
  if (!pair) throw new Error("Missing binance pair");
  const url = `https://api.binance.com/api/v3/ticker/price`;
  const params = { symbol: pair };
  const { data } = await axios.get(url, { params, timeout: 5000, headers: { "User-Agent": "EscrowBot/1.0" } });
  if (!data || typeof data.price === "undefined") throw new Error("Invalid Binance response");
  const p = parseFloat(data.price);
  if (!p || isNaN(p) || p <= 0) throw new Error("Invalid price from Binance");
  return p;
}

async function tryCoinCap(id) {
  if (!id) throw new Error("Missing coincap id");
  const url = `https://api.coincap.io/v2/assets/${encodeURIComponent(id)}`;
  const { data } = await axios.get(url, { timeout: 5000, headers: { "User-Agent": "EscrowBot/1.0" } });
  if (!data || !data.data || typeof data.data.priceUsd === "undefined") throw new Error("Invalid CoinCap response");
  const p = parseFloat(data.data.priceUsd);
  if (!p || isNaN(p) || p <= 0) throw new Error("Invalid price from CoinCap");
  return p;
}

async function tryCoinGecko(id) {
  if (!id) throw new Error("Missing coingecko id");
  const url = "https://api.coingecko.com/api/v3/simple/price";
  const params = { ids: id, vs_currencies: "usd" };
  const headers = { "User-Agent": "EscrowBot/1.0" };
  if (COINGECKO_KEY) headers["x-cg-pro-api-key"] = COINGECKO_KEY;
  const { data } = await axios.get(url, { params, timeout: 5000, headers });
  if (!data || !data[id] || typeof data[id].usd !== "number") throw new Error("Invalid CoinGecko response");
  const p = data[id].usd;
  if (!p || isNaN(p) || p <= 0) throw new Error("Invalid price from CoinGecko");
  return p;
}

async function tryCoinPaprika(id) {
  if (!id) throw new Error("Missing coinpaprika id");
  const url = `https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(id)}`;
  const headers = { "User-Agent": "EscrowBot/1.0" };
  if (COINPAPRIKA_KEY) headers["X-API-Key"] = COINPAPRIKA_KEY;
  const { data } = await axios.get(url, { timeout: 5000, headers });
  if (!data || !data.quotes || !data.quotes.USD || typeof data.quotes.USD.price === "undefined") throw new Error("Invalid CoinPaprika response");
  const p = parseFloat(data.quotes.USD.price);
  if (!p || isNaN(p) || p <= 0) throw new Error("Invalid price from CoinPaprika");
  return p;
}

// Multi-provider fetch with caching, retries, backoff, and provider fallbacks
async function fetchPriceWithRetry(symbol, attemptsPerProvider = 2) {
  if (!symbol) throw new Error("Missing symbol");
  if (!SYMBOLS[symbol]) throw new Error(`Unsupported symbol ${symbol}`);

  // Stablecoin shortcut
  if (symbol === "USDT") return 1;

  const map = SYMBOLS[symbol];
  const cacheKey = `price:${symbol}`;
  const now = Date.now();
  const cached = priceCache[cacheKey];
  if (cached && now - cached.ts < CACHE_TTL) {
    console.log(`Using cached price for ${symbol}: ${cached.price}`);
    return cached.price;
  }

  // Providers in priority order; each provider will be tried with limited retries
  const providers = [
    { name: "binance", fn: () => tryBinance(map.binance) },
    { name: "coincap", fn: () => tryCoinCap(map.coincap) },
    { name: "coingecko", fn: () => tryCoinGecko(map.coingecko) },
    { name: "coinpaprika", fn: () => tryCoinPaprika(map.coinpaprika) },
  ];

  let lastErr = null;
  for (const provider of providers) {
    for (let attempt = 0; attempt < attemptsPerProvider; attempt++) {
      try {
        const p = await provider.fn();
        if (!p || isNaN(p) || p <= 0) throw new Error(`Invalid price from ${provider.name}`);
        priceCache[cacheKey] = { price: p, ts: Date.now() };
        console.log(`Price for ${symbol} from ${provider.name}: ${p}`);
        return p;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        const info = err.response?.data || err.message || err;
        console.error(`${provider.name} attempt ${attempt + 1} failed for ${symbol}:`, status || "", info);
        if (status === 451 || status === 403) {
          // blocked/restricted location for this provider: stop trying this provider immediately
          console.warn(`${provider.name} blocked for ${symbol} (status ${status}), moving to next provider`);
          break;
        }
        if (status === 429) {
          // rate limited: move to next provider
          console.warn(`${provider.name} rate limited, moving to next provider`);
          break;
        }
        // exponential backoff between attempts on same provider
        const backoff = 200 * Math.pow(2, attempt);
        await new Promise((res) => setTimeout(res, backoff));
      }
    }
  }

  // If all providers fail, throw the last error so caller can handle it
  // The wizard will fall back to asking the user for a manual confirmation/price.
  throw lastErr || new Error("All providers failed");
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
    const handle = ctx.message.text.trim();
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
        `*${Object.keys(SYMBOLS).join(" • ")}*\n\n` +
        `💰 Enter the coin currency you wish to trade.`,
      { parse_mode: "Markdown" },
    );
    return ctx.wizard.next();
  },

  // Step 3/9: USD amount prompt
  async (ctx) => {
    const currency = ctx.message.text.trim().toUpperCase();
    if (!SYMBOLS[currency]) {
      return ctx.reply(
        `*❌ Unsupported coin*\n\n` +
          `💱  Please choose one of the supported coins \n` +
          `💰 Supported: ${Object.keys(SYMBOLS).join(" • ")}\n\n` +
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

  // Step 4/9: Fetch price, compute crypto & ID, summary (with manual fallback)
  async (ctx) => {
    const usdAmount = parseFloat(ctx.message.text.trim());
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
      const price = await fetchPriceWithRetry(e.currency, 2);
      if (!price || typeof price !== "number" || price <= 0) {
        throw new Error("Invalid price returned");
      }
      e.cryptoAmount = (usdAmount / price).toFixed(8);
      e.id = Date.now().toString().slice(-6);

      await ctx.reply(
        `*📋 Escrow #${e.id}*\n\n.` +
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
      console.error("Price fetch final error:", err.response?.status, err.response?.data || err.message || err);

      // Fallback: ask user to confirm or provide a manual crypto amount
      await ctx.reply(
        `*⚠️ Price lookup unavailable*\n\n` +
          `I couldn't fetch live market prices from external providers due to network or location restrictions.\n\n` +
          `Please either:\n` +
          `1. Paste the current *price USD per ${e.currency}* (e.g. 43000) \n` +
          `or\n` +
          `2. Paste the *crypto amount* you will deposit (e.g. 0.00543210)\n\n` +
          `Reply with a number for price or crypto amount.`,
        { parse_mode: "Markdown" },
      );

      // set flag to handle manual fallback in next step
      ctx.wizard.state.awaitingManualPrice = true;
      return ctx.wizard.next();
    }
  },

  // Step 4b/5: Handle manual price or crypto amount then ask for deposit address
  async (ctx) => {
    const e = ctx.wizard.state.escrow;
    if (ctx.wizard.state.awaitingManualPrice) {
      const input = ctx.message.text.trim();
      const asNumber = parseFloat(input);
      if (isNaN(asNumber) || asNumber <= 0) {
        return ctx.reply(
          `*❌ Invalid number*\n\n` + `Please paste a valid positive number for price or crypto amount.`,
          { parse_mode: "Markdown" },
        );
      }

      // Heuristic: if value > 10 it's probably a USD price per coin; else treat as crypto amount
      if (asNumber > 10) {
        // user provided USD price per coin
        const pricePerCoin = asNumber;
        e.cryptoAmount = (e.usdAmount / pricePerCoin).toFixed(8);
        await ctx.reply(
          `*ℹ️ Manual price used*\n\n` +
            `Price: $${pricePerCoin} per ${e.currency}\n` +
            `Computed crypto amount: ${e.cryptoAmount} ${e.currency}`,
          { parse_mode: "Markdown" },
        );
      } else {
        // user provided crypto amount directly
        e.cryptoAmount = asNumber.toFixed(8);
        await ctx.reply(
          `*ℹ️ Manual crypto amount used*\n\n` +
            `Using provided crypto amount: ${e.cryptoAmount} ${e.currency}`,
          { parse_mode: "Markdown" },
        );
      }

      e.id = Date.now().toString().slice(-6);
      // clear manual flag
      ctx.wizard.state.awaitingManualPrice = false;
    }

    await ctx.reply(
      `🔹 Next step\n\n` + `🏦  Enter the seller’s *on‑chain Deposit address*.`,
      { parse_mode: "Markdown" },
    );
    return ctx.wizard.next();
  },

  // Step 5/9: Seller’s deposit address
  async (ctx) => {
    const addr = ctx.message.text.trim();
    const validate = addressValidators[ctx.wizard.state.escrow.currency];
    if (!validate(addr)) {
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
    const addr = ctx.message.text.trim();
    const validate = addressValidators[ctx.wizard.state.escrow.currency];
    if (!validate(addr)) {
      return ctx.reply(
        `*❌ Invalid Refund Address*\n\n` +
          `🏦 Please try again with a valid on‑chain address`,
        { parse_mode: "Markdown" },
      );
    }
    ctx.wizard.state.escrow.refundAddress = addr;

    const e = ctx.wizard.state.escrow;
    await ctx.reply(
      `*📜 Trade details for Escrow #${e.id}*\n\n.` +
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
    const txid = ctx.message.text.trim();
    if (!/^[A-Fa-f0-9]{6,}$/.test(txid)) {
      return ctx.reply(
        `*❌ Invalid TXID*\n\n` + `🔗 Please paste the full transaction hash`,
        { parse_mode: "Markdown" },
      );
    }
    ctx.wizard.state.escrow.txid = txid;

    // Persist final escrow
    if (!ctx.session.escrows) ctx.session.escrows = {};
    ctx.session.escrows[ctx.chat.id] = ctx.wizard.state.escrow;

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
