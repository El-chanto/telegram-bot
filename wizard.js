const { Scenes } = require("telegraf");
const axios = require("axios");
const { depositAddresses, addressValidators } = require("./config");

// CoinGecko lookup map
const CG_ID = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  TRX: "tron",
  LTC: "litecoin",
  XRP: "ripple",
  TON: "the-open-network",
  SOL: "solana",
  DOGE: "dogecoin",
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

// simple in-memory cache and retry helper for CoinGecko
const priceCache = {}; // { key: { price, expiresAt } }

async function fetchPriceWithCache(id, opts = {}) {
  const key = id;
  const now = Date.now();
  const ttl = opts.ttlMs || 60000; // default 60s cache (increase to reduce 429s)

  const cached = priceCache[key];
  if (cached && cached.expiresAt > now) return cached.price;

  const maxRetries = typeof opts.retries === "number" ? opts.retries : 2;
  let attempt = 0;
  let lastErr;
  while (attempt <= maxRetries) {
    try {
      const resp = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
        params: { ids: id, vs_currencies: "usd" },
        timeout: 5000,
        headers: { "User-Agent": "BitSafeEscrowBot/1.0 (+https://yourdomain.example)" },
        validateStatus: (s) => s < 500 || s === 429,
      });

      if (resp.status === 429) {
        lastErr = new Error("Rate limited by CoinGecko");
        lastErr.status = 429;
        throw lastErr;
      }

      const price = resp.data && resp.data[id] && resp.data[id].usd;
      if (!price || typeof price !== "number" || price <= 0) {
        lastErr = new Error("Invalid price returned");
        throw lastErr;
      }

      priceCache[key] = { price, expiresAt: Date.now() + ttl };
      return price;
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt > maxRetries) break;
      const backoffMs = err && err.status === 429 ? 3000 * attempt : 200 * Math.pow(2, attempt);
      await new Promise((res) => setTimeout(res, backoffMs));
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
        `*${Object.keys(CG_ID).join(" • ")}*\n\n` +
        `💰 Enter the coin currency you wish to trade.`,
      { parse_mode: "Markdown" },
    );
    return ctx.wizard.next();
  },

  // Step 3/9: USD amount prompt
  async (ctx) => {
    const currency = getText(ctx).trim().toUpperCase();
    if (!CG_ID[currency]) {
      return ctx.reply(
        `*❌ Unsupported coin*\n\n` +
          `💱  Please choose one of the supported coins \n` +
          `💰 Supported: ${Object.keys(CG_ID).join(" • ")}\n\n` +
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
      const price = await fetchPriceWithCache(CG_ID[e.currency], { ttlMs: 60000, retries: 2 });
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
      console.error("CoinGecko fetch failed:", { message: err.message, status: err.status });
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

    console.log("Persisted escrow for", escrowKey(ctx), ctx.wizard.state.escrow);

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
