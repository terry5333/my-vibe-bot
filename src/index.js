"use strict";

/**
 * src/index.js
 * A 方案：index.js 統一 deferReply()，commands 只能 editReply / followUp
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands"); // commands.js (commandData + execute)
const gamesMod = require("./bot/games");    // games.js：module.exports = { games, onMessage }

// ---- env ----
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ Missing env: DISCORD_TOKEN");
  process.exit(1);
}

// ---- client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 需要讀取頻道輸入數字（counting/guess）
  ],
  partials: [Partials.Channel],
});

// ---- bootstrap (Firebase) ----
// ✅ 兼容三種 export：
// 1) module.exports = initFirebase
// 2) module.exports = { initFirebase }
// 3) exports.default = initFirebase
let initFirebaseFn = null;
try {
  const fb = require("./db/firebase"); // 你原本的路徑
  initFirebaseFn =
    (typeof fb === "function" && fb) ||
    (typeof fb?.initFirebase === "function" && fb.initFirebase) ||
    (typeof fb?.default === "function" && fb.default) ||
    null;
} catch (_) {
  initFirebaseFn = null;
}

if (initFirebaseFn) {
  try {
    initFirebaseFn();
  } catch (e) {
    console.error("[Firebase] init failed:", e);
  }
} else {
  console.warn("[Firebase] initFirebase not found or not a function (skipped)");
}

// ---- ready ----
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommands(client);
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ 確保「只」有一個 interactionCreate handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // 1) 先 ACK：統一 defer（避免 3 秒超時 Unknown interaction 10062）
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // 2) 執行指令（commands.js 裡「不能再 reply()」，只能 editReply/followUp）
    await commands.execute(interaction, { client });

  } catch (err) {
    console.error("[interactionCreate] error:", err);

    // 這裡也要用「不會二次 reply」的方式回覆
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ 指令執行出錯，請稍後再試。");
      } else {
        await interaction.reply({
          content: "❌ 指令執行出錯，請稍後再試。",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {}
  }
});

// counting / guess 要「直接在頻道輸入數字」：messageCreate
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    if (typeof gamesMod?.onMessage === "function") {
      await gamesMod.onMessage(message, { client });
    }
  } catch (err) {
    console.error("[messageCreate] error:", err);
  }
});

client.login(DISCORD_TOKEN);