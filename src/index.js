"use strict";

/**
 * src/index.js
 * 統一策略：
 * - interactionCreate 一律先 deferReply(EPHEMERAL) 避免 10062
 * - commands.js：
 *    - 遊戲 start/stop -> channel.send() 然後 deleteReply()（你看到就是「直接開始」）
 *    - 查詢類 points/rank/info/status -> editReply()（私訊式顯示）
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");
const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands");
const gamesMod = require("./bot/games");

// Firebase：避免你遇到 initFirebase is not a function
let initFirebase;
try {
  const fb = require("./db/firebase");
  initFirebase = typeof fb === "function" ? fb : fb?.initFirebase;
} catch (_) {
  initFirebase = null;
}

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
    GatewayIntentBits.MessageContent, // counting/guess 需要讀取訊息
  ],
  partials: [Partials.Channel],
});

// ---- bootstrap ----
if (typeof initFirebase === "function") {
  initFirebase();
  console.log("[Firebase] Initialized");
}

// ready
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommands(client);
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ 只保留一個 interactionCreate
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // ✅ 永遠先 ACK（私密），避免 3 秒超時 Unknown interaction 10062
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    await commands.execute(interaction, { client });
  } catch (err) {
    console.error("[interactionCreate] error:", err);

    // 只能用不會二次 reply 的方式回
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ 指令執行出錯，請稍後再試。");
      } else {
        await interaction.reply({ content: "❌ 指令執行出錯，請稍後再試。", flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }
});

// counting / guess：直接在頻道輸入數字
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