"use strict";

const { getPoints } = require("../db/points");
const {
  ensureLeaderboardWarm,
  getLeaderboardCache,
  startGuess,
  handleGuessMessage,
  startCounting,
  handleCountingMessage,
  startHL,
  handleHLButton,
  stopChannelGame,
  upsertProfile,
} = require("./games");

function bindDiscordEvents(client, webRuntime) {
  client.on("interactionCreate", async (interaction) => {
    try {
      // Buttons
      if (interaction.isButton()) {
        if (interaction.customId.startsWith("hl_")) {
          return await handleHLButton(interaction);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      // ✅ 所有指令都先 defer，避免交互失敗
      const name = interaction.commandName;

      if (name === "rank") {
        await interaction.deferReply({ ephemeral: false });
        await ensureLeaderboardWarm();

        const cache = getLeaderboardCache();
        if (!cache.items.length) return interaction.editReply("目前沒有排行榜資料。");

        const lines = cache.items.slice(0, 10).map((x, i) => `#${i + 1} <@${x.userId}>：**${x.points}**`);
        return interaction.editReply(`📊 排行榜 Top 10\n${lines.join("\n")}`);
      }

      if (name === "points") {
        await interaction.deferReply({ ephemeral: true });
        const p = await getPoints(interaction.user.id);
        await upsertProfile(interaction.user);
        return interaction.editReply(`⭐ 你的目前積分：**${p}**`);
      }

      if (name === "guess") {
        return await startGuess(interaction, webRuntime);
      }

      if (name === "counting") {
        return await startCounting(interaction, webRuntime);
      }

      if (name === "hl") {
        return await startHL(interaction, webRuntime);
      }

      if (name === "stop") {
        return await stopChannelGame(interaction, webRuntime);
      }
    } catch (e) {
      console.error("interaction error:", e);
      if (interaction.deferred || interaction.replied) {
        interaction.editReply("❌ 發生錯誤").catch(() => {});
      } else {
        interaction.reply({ content: "❌ 發生錯誤", ephemeral: true }).catch(() => {});
      }
    }
  });

  client.on("messageCreate", async (msg) => {
    try {
      if (!msg.guild) return;
      if (msg.author.bot) return;

      // ✅ 文字遊戲監聽（guess + counting）
      await handleGuessMessage(msg);
      await handleCountingMessage(msg);
    } catch (e) {
      console.error("messageCreate error:", e);
    }
  });
}

module.exports = { bindDiscordEvents };
