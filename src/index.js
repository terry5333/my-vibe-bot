"use strict";

/**
 * ✅ 單一 interactionCreate / messageCreate
 * ✅ 全互動防重複（同進程）
 * ✅ Buttons/Selects/Modals -> lobbyButtons
 * ✅ HL buttons -> games.onInteraction
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands");
const games = require("./bot/games");
const lobbyButtons = require("./bot/lobbyButtons");
const system = require("./bot/system");

// ---- env ----
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ Missing env: DISCORD_TOKEN");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// ---- anti-duplicate guard ----
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

  // 啟動：載入狀態＋恢復 AFK 計時
  await system.boot(client).catch((e) => console.error("[system.boot] error:", e));
});

// ✅ interactionCreate（只留這一個）
client.on("interactionCreate", async (interaction) => {
  try {
    if (!markHandled(interaction.id)) return;

    // Buttons/Selects/Modals
    if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
      const handled = await lobbyButtons.handleInteraction(interaction, { client });
      if (handled) return;

      if (interaction.isButton()) {
        await games.onInteraction(interaction, { client });
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

// ✅ messageCreate
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // 房間活動（AFK）
    system.pingActivity(message.channelId, message.author.id);

    await games.onMessage(message, { client });
  } catch (err) {
    console.error("[messageCreate] error:", err);
  }
});

client.login(DISCORD_TOKEN);