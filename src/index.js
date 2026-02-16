"use strict";

/**
 * src/index.js
 * ✅ index.js 統一 deferReply（ephemeral）
 * ✅ commands.js 只能 editReply / followUp（不能再 interaction.reply）
 * ✅ 開始類指令會在 commands.js 用 channel.send + deleteReply 做到「不顯示回覆」
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands");
const gamesMod = require("./bot/games");

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
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---- Firebase init (相容 function / {initFirebase} 兩種輸出) ----
try {
  const fbMod = require("./db/firebase");
  const initFirebase = typeof fbMod === "function" ? fbMod : fbMod?.initFirebase;
  if (typeof initFirebase === "function") initFirebase();
} catch (_) {
  // 沒 firebase 就忽略
}

client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommands(client);
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ 全專案只能有這一個 interactionCreate
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // 先 ACK（避免 3 秒超時 Unknown interaction 10062）
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    await commands.execute(interaction, { client });
  } catch (err) {
    console.error("[interactionCreate] error:", err);

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

// counting / guess 需要讀取「頻道直接輸入數字」
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