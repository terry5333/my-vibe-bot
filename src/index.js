"use strict";

/**
 * src/index.js
 * ✅ 只掛一次事件（避免同一個互動跑兩次）
 * ✅ ChatInputCommand：統一 deferReply（commands 只用 editReply / followUp）
 * ✅ Button / Modal：先給 lobbyButtons 處理；沒處理到再給 games.js（HL 按鈕）
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands");
const gamesMod = require("./bot/games");
const lobbyButtons = require("./bot/lobbyButtons");

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

// ---- anti-duplicate interaction guard (同一進程防重複) ----
const handledInteractionIds = new Set();
function markHandled(id) {
  if (handledInteractionIds.has(id)) return false;
  handledInteractionIds.add(id);
  if (handledInteractionIds.size > 5000) handledInteractionIds.clear();
  return true;
}

client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ interactionCreate（只留這一個）
client.on("interactionCreate", async (interaction) => {
  try {
    // 所有互動都先防「同一進程重複」
    if (!markHandled(interaction.id)) return;

    // ===== Buttons / Modals / Selects 都先給 lobbyButtons =====
    if (interaction.isButton() || interaction.isModalSubmit() || interaction.isAnySelectMenu()) {
      const handled = await lobbyButtons.handleInteraction(interaction, { client });
      if (handled) return;

      // HL 的 hi/lo/stop 等按鈕交給 games.js
      if (interaction.isButton() && typeof gamesMod?.onInteraction === "function") {
        await gamesMod.onInteraction(interaction, { client });
      }
      return;
    }

    // ===== Slash commands =====
    if (!interaction.isChatInputCommand()) return;

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

// ===== messageCreate（給 counting/guess 用「聊天室打數字」）=====
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // 房間/大廳活動都算「有行動」
    lobbyButtons.pingActivity(message.channelId, message.author.id);

    if (typeof gamesMod?.onMessage === "function") {
      await gamesMod.onMessage(message, { client });
    }
  } catch (err) {
    console.error("[messageCreate] error:", err);
  }
});

client.login(DISCORD_TOKEN);