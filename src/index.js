"use strict";

/**
 * src/index.js
 * - 單一 interactionCreate handler（避免指令/回覆重複）
 * - 統一 deferReply({ flags: Ephemeral }) 避免 10062 Unknown interaction
 * - 真正「要開始」的訊息請在 commands.js 用 channel.send + deleteReply()
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands"); // 你那份 commands.js（commandData + execute）
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
    GatewayIntentBits.MessageContent, // counting/guess 需要讀取頻道數字
  ],
  partials: [Partials.Channel],
});

// ---- firebase (optional) ----
// 你的 firebase 可能是 module.exports = fn 或 module.exports = { initFirebase }
// 所以用安全方式處理，避免 "initFirebase is not a function"
try {
  const fb = require("./db/firebase");
  const init =
    (typeof fb === "function" && fb) ||
    (fb && typeof fb.initFirebase === "function" && fb.initFirebase);

  if (typeof init === "function") init();
} catch (_) {
  // 沒有 firebase 檔或不需要就忽略
}

// ---- ready ----
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  // 註冊 slash commands（建議用 GUILD + 清 GLOBAL）
  try {
    await registerCommands(client);
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ 確保只註冊一次 interactionCreate
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // 先 ACK（ephemeral flags），避免超時 Unknown interaction
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // 執行指令
    await commands.execute(interaction, { client });

  } catch (err) {
    console.error("[interactionCreate] error:", err);

    // 只能用 editReply 或 reply（避免 40060 already acknowledged）
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

// counting / guess：直接在頻道輸入數字要靠 messageCreate
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