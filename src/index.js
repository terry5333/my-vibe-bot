"use strict";

/**
 * src/index.js
 * ✅ interaction 防重複（同一進程）
 * ✅ Buttons/Modals/Select：先交給 lobbyButtons，只有沒處理才交給 games(HL)
 * ✅ messageCreate：交給 games，並通知 lobbyButtons 更新活躍
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands");
const gamesMod = require("./bot/games");
const lobbyButtons = require("./bot/lobbyButtons");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ Missing env: DISCORD_TOKEN");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---- anti-duplicate interaction guard ----
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

client.on("interactionCreate", async (interaction) => {
  try {
    if (!markHandled(interaction.id)) return;

    // Buttons/Modals/Selects -> lobbyButtons first
    if (interaction.isButton() || interaction.isModalSubmit() || interaction.isAnySelectMenu()) {
      const handled = await lobbyButtons.handleInteraction(interaction, { client });
      if (handled) return;

      // HL buttons only (games.js)
      if (interaction.isButton() && typeof gamesMod?.onInteraction === "function") {
        await gamesMod.onInteraction(interaction, { client });
      }
      return;
    }

    // Slash commands
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
        await interaction.reply({ content: "❌ 指令執行出錯，請稍後再試。", flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // 更新活躍（如果你之後要做 AFK 關房會用到）
    lobbyButtons.pingActivity(message.channelId, message.author.id);

    if (typeof gamesMod?.onMessage === "function") {
      await gamesMod.onMessage(message, { client });
    }
  } catch (err) {
    console.error("[messageCreate] error:", err);
  }
});

client.login(DISCORD_TOKEN);