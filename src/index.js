"use strict";

/**
 * src/index.js
 * A 方案：index.js 統一 deferReply()，commands 只能 editReply / followUp
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands"); // 你貼的那份 commands.js (commandData + execute)
const gamesMod = require("./bot/games");    // games.js：module.exports = { games, onMessage }
const initFirebase = require("./db/firebase"); // 你原本的 Firebase 初始化（如果沒有就刪掉）

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

// ---- bootstrap ----
initFirebase?.(); // 有就跑，沒有就忽略

client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  // 註冊 slash commands（你目前 log 顯示 guild 註冊成功）
  try {
    await registerCommands(client);
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ 確保「只」有一個 interactionCreate handler
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // 1) 先 ACK：統一 defer（避免 3 秒超時 Unknown interaction 10062）
    //    用 flags 取代 ephemeral（避免你 log 的 deprecated warning）
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // 2) 執行指令（commands.js 裡只能 editReply/followUp）
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