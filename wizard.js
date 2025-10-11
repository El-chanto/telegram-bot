// wizard.js
const { Scenes } = require("telegraf");
const axios = require("axios");
const { depositAddresses, addressValidators } = require("./config");

// Binance pair lookup map
const BINANCE_PAIR = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  USDT: "USDTUSDT", // handled specially below
  TRX: "TRXUSDT",
  LTC: "LTCUSDT",
  XRP: "XRPUSDT",
  TON: "TONUSDT", // Binance symbol for Toncoin; adjust if your environment differs
  SOL: "SOLUSDT",
  DOGE: "DOGEUSDT",
};

// Simple in-memory short cache to reduce API calls
const priceCache = {}; // { pair: { price: number, ts: epoch_ms } }
const CACHE_TTL = 30 * 1000; // 30 seconds

async function fetchPriceWithRetry(symbol, attempts = 3) {
  if (!symbol) throw new Error("Missing symbol");

  // Special-case stablecoin: USDT ~ 1 USD
  if (symbol === "USDT") {
    return 1;
  }

  const pair = BINANCE_PAIR[symbol];
  if (!pair) throw new Error(`Missing Binance pair mapping for ${symbol}`);

  const now = Date.now();
  const cached = priceCache[pair];
  if (cached && now - cached.ts < CACHE_TTL) {
    console.log(`Using cached price for ${pair}: ${cached.price}`);
    return cached.price;
  }

  const url = `https://api.binance.com/api/v3/ticker/price`;
  const params = { symbol: pair };
  const headers = { "User-Agent": "EscrowBot/1.0", Accept: "application/json" };

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const { data } = await axios.get(url, { params, timeout: 5000, headers });
      console.log("Binance raw response:", JSON.stringify(data));
      if (!data || typeof data.price === "undefined") {
        throw new Error(`Invalid response shape for ${pair}`);
      }
      const price = parseFloat(data.price);
      if (!price || isNaN(price) || price <= 0) {
        throw new Error(`Invalid price value from Binance for ${pair}: ${data.price}`);
      }
      priceCache[pair] = { price, ts: Date.now() };
      return price;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const msg = err.response?.data || err.message || err;
      console.error(`Binance attempt ${i + 1} failed for ${pair}:`, status || "", msg);
      if (status === 429) break;
      const backoff = 200 * Math.pow(2, i);
      await new Promise((res) => setTimeout(res, backoff));
    }
  }
  throw lastErr;
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
        `*${Object.keys(BINANCE_PAIR).join(" • ")}*\n\n` +
        `💰 Enter the coin currency you wish to trade.`,
      { parse_mode: "Markdown" },
    );
    return ctx.wizard.next();
  },

  // Step 3/9: USD amount prompt
  async (ctx) => {
    const currency = ctx.message.text.trim().toUpperCase();
    if (!BINANCE_PAIR[currency]) {
      return ctx.reply(
        `*❌ Unsupported coin*\n\n` +
          `💱  Please choose one of the supported coins \n` +
          `💰 Supported: ${Object.keys(BINANCE_PAIR).join(" • ")}\n\n` +
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
      const price = await fetchPriceWithRetry(e.currency, 3);
      if (!price || typeof price !== "number" || price <= 0) {
        console.error("Invalid price returned:", price);
        return ctx.reply(
          `*❌ Failed to fetch price*\n\n` + `⏳ Please try again later`,
          { parse_mode: "Markdown" },
        );
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
      console.error("Price fetch error final:", err.response?.status, err.response?.data || err.message || err);
      return ctx.reply(
        `*❌ Failed to fetch price*\n\n` + `⏳ Please try again later`,
        { parse_mode: "Markdown" },
      );
    }
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
