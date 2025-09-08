// index.js
require("dotenv").config();
const { Telegraf, Scenes } = require("telegraf");
const LocalSession = require("telegraf-session-local");
const createEscrowWizard = require("./wizard.js");
const keepAlive = require("./keep_alive");

// Start keep-alive server
keepAlive();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// 1) Persist sessions
bot.use(new LocalSession({ database: "session_db.json" }).middleware());

// 2) Mount the wizard scene
const stage = new Scenes.Stage([createEscrowWizard]);
bot.use(stage.middleware());

// 3) /start — greeting (now includes /cancel)
bot.start((ctx) => {
  const name = ctx.from.first_name || "there";
  return ctx.reply(
    `🤖 Hello, ${name}! ` +
      `Welcome to *BitSafeEscrow Bot*.\n\n` +
      `This bot helps you securely trade crypto with strangers.\n` +
      `🎯 Ready to trade?\n\n` +
      `🏁  /newescrow    — Start a new escrow\n` +
      `🔍  /status       — View your escrow details\n` +
      `🔓  /release      — Finalize an existing escrow\n` +
      `↩️  /refund       — Request a refund\n` +
      `🛑  /cancel       — Abort the current operation\n\n` +
      `▶️  To get started, Send /newescrow .`,
    { parse_mode: "Markdown" },
  );
});

// 4) /newescrow — reset any in-flight wizard and begin Step 1
bot.command("newescrow", async (ctx) => {
  if (ctx.scene.current) {
    await ctx.scene.leave();
  }
  return ctx.scene.enter("create-escrow");
});

// 5) /status — show escrow details or prompt to start
bot.command("status", (ctx) => {
  const e = (ctx.session.escrows || {})[ctx.chat.id];
  if (!e) {
    return ctx.reply(
      `❌ No Active Escrow\n\n` +
        `🔍 You don’t have any active escrow orders.\n` +
        `▶️ Create one now with /newescrow`,
    );
  }
  return ctx.reply(
    `🔒 Escrow #${e.id} Details:\n` +
      `• Seller Handle: ${e.sellerHandle}\n` +
      `• Coin: ${e.currency}\n` +
      `• Trade Size: $${e.usdAmount} → ${e.cryptoAmount} ${e.currency}\n` +
      `• Seller Deposit Addr: ${e.depositAddress}\n` +
      `• Buyer Refund Addr: ${e.refundAddress}\n` +
      `• TXID: ${e.txid || "–"}`,
  );
});

// 6) /release — stub that checks for an escrow first
bot.command("release", (ctx) => {
  const e = (ctx.session.escrows || {})[ctx.chat.id];
  if (!e) {
    return ctx.reply(
      `❌ No Active Escrow\n\n` +
        `🔍 You don’t have any active escrow orders.\n` +
        `▶️ Create one now with /newescrow`,
    );
  }
  // TODO: implement real release logic
  return ctx.reply("🔓 Release flow is coming soon.");
});

// 7) /refund — stub that checks for an escrow first
bot.command("refund", (ctx) => {
  const e = (ctx.session.escrows || {})[ctx.chat.id];
  if (!e) {
    return ctx.reply(
      `❌ No Active Escrow\n\n` +
        `🔍 You don’t have any active escrow orders.\n` +
        `▶️ Create one now with /newescrow`,
    );
  }
  // TODO: implement real refund logic
  return ctx.reply("↩️ Refund flow is coming soon.");
});

// 8) /cancel — abort any active scene and clear session
bot.command("cancel", async (ctx) => {
  if (ctx.scene.current) {
    await ctx.scene.leave();
  }
  // Optionally clear partial escrow data:
  if (ctx.session.escrows && ctx.session.escrows[ctx.chat.id]) {
    delete ctx.session.escrows[ctx.chat.id];
  }
  return ctx.reply(
    `🛑 Operation Canceled \n` +
      `🗑️ All escrow data has been cleared.\n\n` +
      `🎯 Ready to trade?\n\n` +
      `🏁  /newescrow    — Start a new escrow\n` +
      `🔍  /status       — View your escrow details\n` +
      `🔓  /release      — Finalize an existing escrow\n` +
      `↩️  /refund       — Request a refund\n` +
      `🛑  /cancel       — Abort the current operation\n\n` +
      `🔄 Start over with /newescrow`,
  );
});

bot.launch();
