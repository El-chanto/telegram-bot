// wizard.js
const { Scenes } = require("telegraf");
const axios = require("axios");
const { depositAddresses, addressValidators } = require("./config");

// Provider maps and config
const SYMBOLS = {
  BTC: { binance: "BTCUSDT", coincap: "bitcoin", coinpaprika: "btc-bitcoin", coingecko: "bitcoin" },
  ETH: { binance: "ETHUSDT", coincap: "ethereum", coinpaprika: "eth-ethereum", coingecko: "ethereum" },
  // Distinguish USDT by Network
  USDT_TRC20: { binance: "USDTUSDT", coincap: "tether", coinpaprika: "usdt-tether", coingecko: "tether" },
  USDT_ERC20: { binance: "USDTUSDT", coincap: "tether", coinpaprika: "usdt-tether", coingecko: "tether" },
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

// ... [Keep all imports, SYMBOLS, and fetch functions exactly as they are] ...

// ... (Keep all your SYMBOLS, provider functions, and fetchPriceWithRetry as they are) ...

const createEscrowWizard = new Scenes.WizardScene(
  "create-escrow",

  // STEP 0 (Index 0): Seller Handle
  async (ctx) => {
    await ctx.reply(`*🔹 Step 1/9*\n\n🏷️ Enter the *seller’s Telegram username* (e.g. @johndoe)`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // STEP 1 (Index 1): Coin Symbol
  async (ctx) => {
    const handle = ctx.message.text.trim();
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(handle)) {
      return ctx.reply(`*❌ Invalid Handle. Try again:*`, { parse_mode: "Markdown" });
    }
    ctx.wizard.state.escrow = { sellerHandle: handle };
    await ctx.reply(`*🔹 Step 2/9*\n\n💰 Enter the coin currency:\n*${Object.keys(SYMBOLS).join(" • ")}*`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // STEP 2 (Index 2): USD Amount
  async (ctx) => {
    const currency = ctx.message.text.trim().toUpperCase();
    if (!SYMBOLS[currency]) {
      return ctx.reply(`*❌ Unsupported coin. Try again:*`, { parse_mode: "Markdown" });
    }
    ctx.wizard.state.escrow.currency = currency;
    await ctx.reply(`🔹 Step 3/9\n\n💵 Enter the amount in USD:`);
    return ctx.wizard.next();
  },

  // STEP 3 (Index 3): Price Fetching Logic
  async (ctx) => {
    const usdAmount = parseFloat(ctx.message.text.trim());
    if (isNaN(usdAmount) || usdAmount <= 0) return ctx.reply(`*❌ Invalid USD amount*`, { parse_mode: "Markdown" });

    const e = ctx.wizard.state.escrow;
    e.usdAmount = usdAmount;

    try {
      const price = await fetchPriceWithRetry(e.currency, 2);
      e.cryptoAmount = (usdAmount / price).toFixed(8);
      e.id = Date.now().toString().slice(-6);

      // We found the price, tell the user and jump to Seller Address Prompt (Step Index 5)
      await ctx.reply(
        `✅ *Price Found*\n` +
        `💱 1 ${e.currency.replace('_', '\\_')} = $${price.toLocaleString()}\n` +
        `💰 Total: *${e.cryptoAmount}*`,
        { parse_mode: "Markdown" }
      );

      await ctx.reply(`🔹 Step 4/9\n\n🏦 Enter the *seller’s* Deposit address:`, { parse_mode: "Markdown" });
      
      // JUMP past the manual fallback step
      return ctx.wizard.selectStep(5); 
    } catch (err) {
      // No price found, triggers Step 4 (Index 4)
      await ctx.reply(`*⚠️ Price lookup failed*\n\nPlease enter the *crypto amount* manually:`, { parse_mode: "Markdown" });
      ctx.wizard.state.awaitingManualPrice = true;
      return ctx.wizard.next();
    }
  },

  // STEP 4 (Index 4): Manual Fallback (Only runs if Step 3 fails)
  async (ctx) => {
    const e = ctx.wizard.state.escrow;
    const input = parseFloat(ctx.message.text.trim());
    if (isNaN(input)) return ctx.reply("Please enter a valid number.");

    e.cryptoAmount = (input > 10) ? (e.usdAmount / input).toFixed(8) : input.toFixed(8);
    e.id = Date.now().toString().slice(-6);
    ctx.wizard.state.awaitingManualPrice = false;

    await ctx.reply(`🔹 Step 4/9\n\n🏦 Enter the *seller’s* Deposit address:`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // STEP 5 (Index 5): Seller Address Handler
  async (ctx) => {
    const addr = ctx.message.text.trim();
    const e = ctx.wizard.state.escrow;
    const validate = addressValidators[e.currency];
    
    if (!validate || !validate(addr)) {
      return ctx.reply(`*❌ Invalid Address* for ${e.currency.replace('_', '\\_')}. Try again:`, { parse_mode: "Markdown" });
    }
    
    e.depositAddress = addr;
    await ctx.reply(`✅ *Seller address saved.*`);
    await ctx.reply(`*🔹 Step 5/9*\n\n🏦 Enter the *buyer’s* Refund address:`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // STEP 6 (Index 6): Buyer Address & Summary (CRITICAL HTML FIX)
  async (ctx) => {
    const addr = ctx.message.text.trim();
    const e = ctx.wizard.state.escrow;
    const validate = addressValidators[e.currency];
    
    if (!validate || !validate(addr)) {
      return ctx.reply(`*❌ Invalid Refund Address*. Try again:`, { parse_mode: "Markdown" });
    }
    
    e.refundAddress = addr;
    await ctx.reply(`✅ *Refund address saved.*`);

    const cleanName = e.currency.split('_')[0];
    const systemAddr = depositAddresses[e.currency];

    // Using HTML to prevent the USDT_TRC20 underscore crash
    await ctx.reply(
      `<b>📜 Trade details for Escrow #${e.id}</b>\n\n` +
      `👤 Seller: ${e.sellerHandle}\n` +
      `💱 Coin: ${e.currency}\n` +
      `💵 Trade Size: $${e.usdAmount} → ${e.cryptoAmount} ${cleanName}\n` +
      `🏦 Seller Receive: <code>${e.depositAddress}</code>\n` +
      `🏦 Buyer Refund: <code>${e.refundAddress}</code>`,
      { parse_mode: "HTML" }
    );

    await ctx.reply(
      `🔹 <b>Step 7/9</b>\n\n` +
      `📤 Please deposit <b>${e.cryptoAmount} ${cleanName}</b> to:\n\n` +
      `<code>${systemAddr}</code>\n\n` +
      `⚠️ <b>Network:</b> ${e.currency.includes('TRC20') ? 'TRON (TRC-20)' : 'Ethereum (ERC-20)'}\n\n` +
      `📥 Once done, paste the <b>TXID</b> below.`,
      { parse_mode: "HTML" }
    );
    return ctx.wizard.next();
  },

  // STEP 7 (Index 7): TXID Entry
  async (ctx) => {
    const txid = ctx.message.text.trim();
    if (txid.length < 8) return ctx.reply(`*❌ Invalid TXID*`, { parse_mode: "Markdown" });
    
    ctx.wizard.state.escrow.txid = txid;
    if (!ctx.session.escrows) ctx.session.escrows = {};
    ctx.session.escrows[ctx.chat.id] = ctx.wizard.state.escrow;

    await ctx.reply("🎉 Funds detected! Generating final confirmation…");
    return ctx.wizard.next();
  },

  // STEP 8 (Index 8): Final Success
  async (ctx) => {
    const e = ctx.wizard.state.escrow;
    await ctx.reply(
      `<b>🛡️ Escrow #${e.id} Complete!</b>\n\n` +
      `👤 Seller: ${e.sellerHandle}\n` +
      `🔗 TXID: <code>${e.txid}</code>`,
      { parse_mode: "HTML" }
    );
    return ctx.scene.leave();
  }
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
