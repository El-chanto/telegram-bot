// wizard.js
const { Scenes } = require("telegraf");
const axios = require("axios");
const { depositAddresses, addressValidators } = require("./config");

// Provider maps and config
const SYMBOLS = {
  BTC: { binance: "BTCUSDT", coincap: "bitcoin", coinpaprika: "btc-bitcoin", coingecko: "bitcoin" },
  ETH: { binance: "ETHUSDT", coincap: "ethereum", coinpaprika: "eth-ethereum", coingecko: "ethereum" },
  USDT_TRC20: { binance: "USDTUSDT", coincap: "tether", coinpaprika: "usdt-tether", coingecko: "tether" },
  USDT_ERC20: { binance: "USDTUSDT", coincap: "tether", coinpaprika: "usdt-tether", coingecko: "tether" },
  TRX: { binance: "TRXUSDT", coincap: "tron", coinpaprika: "trx-tron", coingecko: "tron" },
  LTC: { binance: "LTCUSDT", coincap: "litecoin", coinpaprika: "ltc-litecoin", coingecko: "litecoin" },
  XRP: { binance: "XRPUSDT", coincap: "ripple", coinpaprika: "xrp-xrp", coingecko: "ripple" },
  TON: { binance: "TONUSDT", coincap: "ton", coinpaprika: "ton-toncoin", coingecko: "the-open-network" },
  SOL: { binance: "SOLUSDT", coincap: "solana", coinpaprika: "sol-solana", coingecko: "solana" },
  DOGE: { binance: "DOGEUSDT", coincap: "dogecoin", coinpaprika: "doge-dogecoin", coingecko: "dogecoin" },
};

// Dynamic Network Mapping
const NETWORK_NAMES = {
  BTC: "Bitcoin Network",
  ETH: "Ethereum (ERC-20)",
  USDT_TRC20: "TRON (TRC-20)",
  USDT_ERC20: "Ethereum (ERC-20)",
  TRX: "TRON Mainnet",
  LTC: "Litecoin",
  XRP: "Ripple (XRP)",
  TON: "TON Network",
  SOL: "Solana",
  DOGE: "Dogecoin",
};

const priceCache = {};
const CACHE_TTL = 30 * 1000;
const COINPAPRIKA_KEY = process.env.COINPAPRIKA_KEY || null;
const COINGECKO_KEY = process.env.COINGECKO_KEY || null;

// --- API Provider Functions ---
async function tryBinance(pair) {
  const url = `https://api.binance.com/api/v3/ticker/price`;
  const { data } = await axios.get(url, { params: { symbol: pair }, timeout: 5000 });
  return parseFloat(data.price);
}

async function tryCoinCap(id) {
  const url = `https://api.coincap.io/v2/assets/${id}`;
  const { data } = await axios.get(url, { timeout: 5000 });
  return parseFloat(data.data.priceUsd);
}

async function tryCoinGecko(id) {
  const url = "https://api.coingecko.com/api/v3/simple/price";
  const params = { ids: id, vs_currencies: "usd" };
  const headers = COINGECKO_KEY ? { "x-cg-pro-api-key": COINGECKO_KEY } : {};
  const { data } = await axios.get(url, { params, timeout: 5000, headers });
  return data[id].usd;
}

async function tryCoinPaprika(id) {
  const url = `https://api.coinpaprika.com/v1/tickers/${id}`;
  const headers = COINPAPRIKA_KEY ? { "X-API-Key": COINPAPRIKA_KEY } : {};
  const { data } = await axios.get(url, { timeout: 5000, headers });
  return parseFloat(data.quotes.USD.price);
}

async function fetchPriceWithRetry(symbol, attemptsPerProvider = 2) {
  if (symbol === "USDT") return 1;
  const map = SYMBOLS[symbol];
  const cacheKey = `price:${symbol}`;
  if (priceCache[cacheKey] && Date.now() - priceCache[cacheKey].ts < CACHE_TTL) return priceCache[cacheKey].price;

  const providers = [
    { name: "binance", fn: () => tryBinance(map.binance) },
    { name: "coincap", fn: () => tryCoinCap(map.coincap) },
    { name: "coingecko", fn: () => tryCoinGecko(map.coingecko) },
    { name: "coinpaprika", fn: () => tryCoinPaprika(map.coinpaprika) },
  ];

  for (const provider of providers) {
    for (let i = 0; i < attemptsPerProvider; i++) {
      try {
        const p = await provider.fn();
        if (p > 0) {
          priceCache[cacheKey] = { price: p, ts: Date.now() };
          return p;
        }
      } catch (err) {
        console.error(`${provider.name} failed:`, err.message);
        if (err.response?.status === 429 || err.response?.status === 451) break;
        await new Promise(r => setTimeout(r, 200 * Math.pow(2, i)));
      }
    }
  }
  throw new Error("All price providers failed");
}

// --- WIZARD SCENE ---
const createEscrowWizard = new Scenes.WizardScene(
  "create-escrow",

  // STEP 0: Seller Handle
  async (ctx) => {
    await ctx.reply(`*🔹 Step 1/9*\n\n🏷️ Enter the *seller’s Telegram username* (e.g. @johndoe)`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // STEP 1: Currency Selection
  async (ctx) => {
    const handle = ctx.message.text.trim();
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(handle)) return ctx.reply(`*❌ Invalid Handle. Try again:*`, { parse_mode: "Markdown" });
    ctx.wizard.state.escrow = { sellerHandle: handle };
    await ctx.reply(`*🔹 Step 2/9*\n\n💰 Select Currency:\n*${Object.keys(SYMBOLS).join(" • ")}*`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // STEP 2: USD Amount
  async (ctx) => {
    const currency = ctx.message.text.trim().toUpperCase();
    if (!SYMBOLS[currency]) return ctx.reply(`*❌ Unsupported coin. Try again:*`, { parse_mode: "Markdown" });
    ctx.wizard.state.escrow.currency = currency;
    await ctx.reply(`🔹 Step 3/9\n\n💵 Enter the amount in USD:`);
    return ctx.wizard.next();
  },

  // STEP 3: Logic Hub (Price Fetching)
  async (ctx) => {
    const usdAmount = parseFloat(ctx.message.text.trim());
    if (isNaN(usdAmount) || usdAmount <= 0) return ctx.reply(`*❌ Invalid amount.*`);

    const e = ctx.wizard.state.escrow;
    e.usdAmount = usdAmount;

    try {
      const price = await fetchPriceWithRetry(e.currency, 2);
      e.cryptoAmount = (usdAmount / price).toFixed(8);
      e.id = Date.now().toString().slice(-6);

      await ctx.reply(
        `✅ <b>Market Price Found</b>\n` +
        `💱 1 ${e.currency} = $${price.toLocaleString()}\n` +
        `💰 Deposit Total: <b>${e.cryptoAmount}</b>`, 
        { parse_mode: "HTML" }
      );

      await ctx.reply(`🔹 Step 4/9\n\n🏦 Enter the *seller’s* Deposit address:`, { parse_mode: "Markdown" });
      return ctx.wizard.selectStep(5); // Jump past manual fallback
    } catch (err) {
      await ctx.reply(`*⚠️ Market lookup failed.*\n\nPlease paste the *crypto amount* you will deposit manually:`, { parse_mode: "Markdown" });
      ctx.wizard.state.awaitingManualPrice = true;
      return ctx.wizard.next();
    }
  },

  // STEP 4: Manual Fallback
  async (ctx) => {
    const e = ctx.wizard.state.escrow;
    const input = parseFloat(ctx.message.text.trim());
    if (isNaN(input)) return ctx.reply("Invalid number. Please try again.");

    e.cryptoAmount = (input > 10) ? (e.usdAmount / input).toFixed(8) : input.toFixed(8);
    e.id = Date.now().toString().slice(-6);
    ctx.wizard.state.awaitingManualPrice = false;

    await ctx.reply(`🔹 Step 4/9\n\n🏦 Enter the *seller’s* Deposit address:`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // STEP 5: Seller Address
  async (ctx) => {
    const addr = ctx.message.text.trim();
    const e = ctx.wizard.state.escrow;
    const validate = addressValidators[e.currency];
    
    if (!validate || !validate(addr)) return ctx.reply(`*❌ Invalid Address* for this network. Try again:`, { parse_mode: "Markdown" });
    
    e.depositAddress = addr;
    await ctx.reply(`✅ *Seller address saved.*`, { parse_mode: "Markdown" });
    await ctx.reply(`*🔹 Step 5/9*\n\n🏦 Now, enter the *buyer’s* Refund address:`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // STEP 6: Summary & Instructions
  async (ctx) => {
    const addr = ctx.message.text.trim();
    const e = ctx.wizard.state.escrow;
    const validate = addressValidators[e.currency];
    
    if (!validate || !validate(addr)) return ctx.reply(`*❌ Invalid Refund Address*. Try again:`, { parse_mode: "Markdown" });
    
    e.refundAddress = addr;
    const cleanName = e.currency.split('_')[0];
    const systemAddr = depositAddresses[e.currency];
    const network = NETWORK_NAMES[e.currency] || "Mainnet";

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
      `⚠️ <b>Network:</b> ${network}\n\n` +
      `📥 Once done, paste the <b>TXID</b> below.`,
      { parse_mode: "HTML" }
    );
    return ctx.wizard.next();
  },

  // STEP 7: TXID Entry
  async (ctx) => {
    const txid = ctx.message.text.trim();
    if (txid.length < 8) return ctx.reply(`*❌ Invalid TXID format.*`);
    
    ctx.wizard.state.escrow.txid = txid;
    if (!ctx.session.escrows) ctx.session.escrows = {};
    ctx.session.escrows[ctx.chat.id] = ctx.wizard.state.escrow;

    await ctx.reply("🎉 Funds detected! Generating final confirmation…");
    return ctx.wizard.next();
  },Ray

  // STEP 8: Final Confirmation
  async (ctx) => {
    const e = ctx.wizard.state.escrow;
    await ctx.reply(
      `<b>🛡️ Escrow #${e.id} Complete!</b>\n\n` +
      `👤 Seller: ${e.sellerHandle}\n` +
      `💱 Coin: ${e.currency}\n` +
      `🏦 Deposit: <code>${e.depositAddress}</code>\n` +
      `🔗 TXID: <code>${e.txid}</code>`,
      { parse_mode: "HTML" }
    );
    return ctx.scene.leave();
  }
);

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
