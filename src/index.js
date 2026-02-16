"use strict";

/**
 * src/index.js
 * ✅ 單一 interactionCreate：處理 slash + button
 * ✅ 不自動 defer（由 commands 決定要公開 or 私訊），避免「已公開消息」+ 公開訊息兩段
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands");
const gamesMod = require("./bot/games");

// Firebase 你原本如果是「物件」不是 function，就不要直接呼叫
let initFirebase = null;
try {
  initFirebase = require("./db/firebase");
} catch (_) {}

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

// ---- bootstrap ----
if (typeof initFirebase === "function") {
  initFirebase();
} else if (initFirebase && typeof initFirebase.init === "function") {
  initFirebase.init();
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

// ✅ 只留一個 interactionCreate
client.on("interactionCreate", async (interaction) => {
  try {
    // 1) slash command
    if (interaction.isChatInputCommand()) {
      await commands.execute(interaction, { client });
      return;
    }

    // 2) buttons (RPS / BJ)
    if (interaction.isButton()) {
      if (typeof gamesMod?.onInteraction === "function") {
        await gamesMod.onInteraction(interaction, { client });
      }
      return;
    }
  } catch (err) {
    console.error("[interactionCreate] error:", err);
    // 不要在這裡硬 reply（很容易 40060），讓各自模組處理即可
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: "❌ 發生錯誤", ephemeral: true });
      }
    } catch (_) {}
  }
});

// counting/guess：直接在頻道輸入
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