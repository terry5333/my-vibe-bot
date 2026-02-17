"use strict";

/**
 * src/index.js
 * ✅ 只掛一次事件（避免同一互動跑兩次）
 * ✅ Slash：統一 deferReply（ephemeral）
 * ✅ Button：先 deferUpdate（避免超時），再交給 lobbyButtons / games
 * ✅ messageCreate：給 games（counting/guess 用聊天室輸入）
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

// ✅ interactionCreate（只留這一個）
client.on("interactionCreate", async (interaction) => {
  try {
    // ===== Buttons =====
    if (interaction.isButton()) {
      if (!markHandled(interaction.id)) return;

      // ✅ 先 ACK（避免 3 秒超時 / Unknown interaction）
      // - 如果 lobbyButtons 之後要回 ephemeral，請在 lobbyButtons 裡用 reply/editReply（不要靠 update）
      if (!interaction.deferred && !interaction.replied) {
        try {
          await interaction.deferUpdate();
        } catch (_) {
          // 有時候已被 ack 會丟錯，吞掉即可
        }
      }

      // 1) 先給大廳按鈕處理
      const handled = await lobbyButtons.handleButton(interaction, { client });
      if (handled) return;

      // 2) 沒處理到再給 games（例如 HL 的 hi/lo/stop）
      if (typeof gamesMod?.onInteraction === "function") {
        await gamesMod.onInteraction(interaction, { client });
      }
      return;
    }

    // ===== Slash commands =====
    if (!interaction.isChatInputCommand()) return;
    if (!markHandled(interaction.id)) return;

    // ✅ 統一 ACK（避免 Unknown interaction）
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    await commands.execute(interaction, { client });
  } catch (err) {
    console.error("[interactionCreate] error:", err);

    // ⚠️ Error 回覆也不能二次 reply
    try {
      if (interaction.deferred || interaction.replied) {
        // Button 已 deferUpdate 的話 editReply 可能不存在 → 用 followUp (ephemeral)
        if (interaction.isButton()) {
          await interaction.followUp({
            content: "❌ 操作失敗，請稍後再試。",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.editReply("❌ 指令執行出錯，請稍後再試。");
        }
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

    if (typeof gamesMod?.onMessage === "function") {
      await gamesMod.onMessage(message, { client });
    }
  } catch (err) {
    console.error("[messageCreate] error:", err);
  }
});

client.login(DISCORD_TOKEN);