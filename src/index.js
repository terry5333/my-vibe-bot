"use strict";

/**
 * src/index.js (A 方案)
 * ✅ 只在這裡註冊 interactionCreate / messageCreate
 * ✅ 防止同一個 interaction 被處理兩次（同進程保險）
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");

// 你的指令執行器（你原本那份）
const commands = require("./bot/commands");

// 遊戲（counting/guess/hl）
const gamesMod = require("./bot/games");

// Firebase（可選：不一定有）
let initFirebaseFn = null;
try {
  const fb = require("./db/firebase");
  initFirebaseFn = typeof fb === "function" ? fb : fb?.initFirebase;
} catch (_) {}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ Missing env: DISCORD_TOKEN");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // counting/guess 需要讀訊息
  ],
  partials: [Partials.Channel],
});

// ✅ 可選初始化 Firebase
if (typeof initFirebaseFn === "function") {
  try {
    initFirebaseFn();
    console.log("[Firebase] Initialized");
  } catch (e) {
    console.warn("[Firebase] init failed (ignore):", e?.message || e);
  }
}

// ✅ 防止同一個 interaction 在同一進程被跑兩次
const handledInteractions = new Set();
function markHandled(interactionId) {
  if (handledInteractions.has(interactionId)) return false;
  handledInteractions.add(interactionId);
  // 1 分鐘後清掉，避免 Set 無限增長
  setTimeout(() => handledInteractions.delete(interactionId), 60_000).unref?.();
  return true;
}

client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  console.log("PID =", process.pid);

  try {
    await registerCommands(client);
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }

  console.log("interactionCreate listeners =", client.listenerCount("interactionCreate"));
});

// ✅ 唯一的 interactionCreate
client.on("interactionCreate", async (interaction) => {
  try {
    // 1) HL 按鈕（Button interaction）
    if (interaction.isButton()) {
      // 同進程保險：避免按鈕互動也被處理兩次
      if (!markHandled(interaction.id)) return;

      if (typeof gamesMod?.onInteraction === "function") {
        await gamesMod.onInteraction(interaction, { client });
      }
      return;
    }

    // 2) Slash Command
    if (!interaction.isChatInputCommand()) return;

    // 同進程保險：避免 slash 被處理兩次
    if (!markHandled(interaction.id)) return;

    // 避免 3 秒超時（不設 ephemeral，避免「僅你可見」那種標籤）
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply(); // public thinking
    }

    // 你 commands.js 內部請用 editReply / followUp
    await commands.execute(interaction, { client });