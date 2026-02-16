"use strict";

/**
 * src/index.js
 * ✅ 只保留 1 個 interactionCreate handler（避免重複回覆）
 * ✅ slash commands 一律 deferReply（避免 Unknown interaction 10062）
 * ✅ 用 flags 取代 ephemeral（避免 deprecated warning）
 */

const { Client, GatewayIntentBits, Partials, MessageFlags, Events } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const adminCommands = require("./bot/commands_admin"); // 這包先只放 install/points/rank/info
const gamesMod = require("./bot/games"); // 你原本的 counting/guess/hl message handler 之後會改成按鈕+房間

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
    GatewayIntentBits.MessageContent, // counting 需要讀數字
  ],
  partials: [Partials.Channel],
});

// ---- firebase (可選) ----
// 你之前炸掉是因為你 require 回來不是 function
// 這裡做「超保守」相容：module.exports = function / {initFirebase} / {default}
try {
  const fb = require("./db/firebase");
  const initFirebase = fb?.initFirebase || fb?.default || fb;
  if (typeof initFirebase === "function") initFirebase();
} catch (_) {
  // 沒有 firebase 也沒關係，不要讓它炸
}

let readyOnce = false;

// v14: "ready"；v15+: "clientReady"
// 我們兩個都掛，但用 readyOnce 防止跑兩次
client.once(Events.ClientReady ?? "clientReady", async () => {
  if (readyOnce) return;
  readyOnce = true;

  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

client.once("ready", async () => {
  // 保底相容
  if (readyOnce) return;
  readyOnce = true;

  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ 唯一 interactionCreate handler（重點：避免回覆兩次）
client.on(Events.InteractionCreate ?? "interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // 先 ACK，避免 3 秒超時 Unknown interaction (10062)
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // 執行管理指令（install/points/rank/info）
    await adminCommands.execute(interaction, { client });
  } catch (err) {
    console.error("[interactionCreate] error:", err);

    // 只能 editReply（避免 40060 already acknowledged）
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ 指令執行出錯，請稍後再試。");
      }
    } catch (_) {}
  }
});

// counting/guess (你說 counting 大廳要只能數字，後面會做)
// 先保留你原本 games 的 onMessage
client.on(Events.MessageCreate ?? "messageCreate", async (message) => {
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