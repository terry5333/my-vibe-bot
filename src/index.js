"use strict";

/**
 * src/index.js
 * ✅ 只保留 1 個 interactionCreate handler（避免回覆兩次）
 * ✅ 处理：slash / button / modal
 * ✅ ready/clientReady 相容（避免 ready 觸發兩次）
 */

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const adminCommands = require("./bot/commands_admin");
const { ensureLobbyPosts, handleLobbyInteraction } = require("./bot/lobbyButtons");
const { handleCountingMessage, tryCleanupExpiredPunishments } = require("./bot/warnings");

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
    GatewayIntentBits.MessageContent, // counting 需要讀訊息
    GatewayIntentBits.GuildMembers, // 需要加/移除身份組
    GatewayIntentBits.DirectMessages, // DM 提醒（需要 partials）
  ],
  partials: [Partials.Channel],
});

// ---- firebase (可選) 超保守相容：function / {initFirebase} / {default} ----
try {
  const fb = require("./db/firebase");
  const initFirebase = fb?.initFirebase || fb?.default || fb;
  if (typeof initFirebase === "function") initFirebase();
} catch (_) {}

let readyOnce = false;
async function onReady() {
  if (readyOnce) return;
  readyOnce = true;

  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }

  // ✅ 發送大廳按鈕 & 規則查詢按鈕（只會補上，不會一直狂洗）
  try {
    await ensureLobbyPosts(client);
  } catch (e) {
    console.error("[Lobby] ensure posts failed:", e);
  }
}

client.once(Events.ClientReady ?? "clientReady", onReady);
client.once("ready", onReady);

// ✅ 唯一 interactionCreate（所有互動都走這裡）
client.on(Events.InteractionCreate ?? "interactionCreate", async (interaction) => {
  try {
    // 1) Slash commands
    if (interaction.isChatInputCommand()) {
      await adminCommands.execute(interaction, { client });
      return;
    }

    // 2) Lobby buttons / Room buttons / Modals
    if (interaction.isButton() || interaction.isModalSubmit()) {
      await handleLobbyInteraction(interaction, { client });
      return;
    }
  } catch (err) {
    console.error("[interactionCreate] error:", err);
    // 按鈕/Modal 可能沒 defer，這裡盡量不炸
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("❌ 發生錯誤，請再試一次。");
        } else {
          await interaction.reply({ content: "❌ 發生錯誤，請再試一次。", ephemeral: true });
        }
      }
    } catch (_) {}
  }
});

// counting：只允許數字 + 非數字刪除 + 2次文字 -> ⚠️賤人 3天 / 再犯 -> 永久
client.on(Events.MessageCreate ?? "messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    await tryCleanupExpiredPunishments(message.guild);
    await handleCountingMessage(message, { client });
  } catch (err) {
    console.error("[messageCreate] error:", err);
  }
});

client.login(DISCORD_TOKEN);