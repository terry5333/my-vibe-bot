"use strict";

/**
 * src/index.js（穩定整合版）
 * - 防重複處理 interaction
 * - Button -> lobby -> HL
 * - Slash -> admin + public
 * - message -> games
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const adminCommands = require("./bot/commands");
const games = require("./bot/games");
const lobby = require("./bot/lobbyButtons");
const pointsDb = require("./db/points");

// ---------------- env ----------------
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN");
  process.exit(1);
}

// ---------------- client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------------- anti duplicate ----------------
const handled = new Set();

function once(id) {
  if (handled.has(id)) return false;
  handled.add(id);

  if (handled.size > 5000) handled.clear();
  return true;
}

// ---------------- ready ----------------
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ---------------- interaction ----------------
client.on("interactionCreate", async (interaction) => {
  if (!once(interaction.id)) return;

  try {
    /* ================= BUTTON ================= */
    if (interaction.isButton()) {
      // lobby 先
      const ok = await lobby.handleInteraction(interaction, { client }).catch(() => false);
      if (ok) return;

      // HL 再
      await games.onInteraction(interaction).catch(() => {});
      return;
    }

    /* ================= SLASH ================= */
    if (!interaction.isChatInputCommand()) return;

    // ===== public =====

    // /points
    if (interaction.commandName === "points") {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      const user =
        interaction.options.getUser("user") || interaction.user;

      const pts = await pointsDb.getPoints(user.id).catch(() => 0);

      await interaction.editReply(
        `🏅 ${user} 目前積分：**${pts}**`
      );

      return;
    }

    // /leaderboard
    if (interaction.commandName === "leaderboard") {
      await interaction.deferReply().catch(() => {});

      const top = await pointsDb.getTop(10).catch(() => []);

      if (!top.length) {
        await interaction.editReply("📭 目前沒有排行榜資料");
        return;
      }

      const lines = [];

      for (let i = 0; i < top.length; i++) {
        const u = top[i];

        const m = await interaction.guild.members
          .fetch(u.userId)
          .catch(() => null);

        const name = m ? m.user.tag : `<@${u.userId}>`;

        lines.push(`${i + 1}. ${name} — **${u.points}**`);
      }

      await interaction.editReply(
        "🏆 **積分排行榜**\n\n" + lines.join("\n")
      );

      return;
    }

    // ===== admin =====
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    await adminCommands.execute(interaction, { client });

  } catch (e) {
    console.error("interaction error:", e);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ 發生錯誤");
      }
    } catch (_) {}
  }
});

// ---------------- message ----------------
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  try {
    lobby.pingActivity(msg.channelId, msg.author.id);

    await games.onMessage(msg).catch(() => {});
  } catch (e) {
    console.error("message error:", e);
  }
});

// ---------------- login ----------------
client.login(TOKEN);