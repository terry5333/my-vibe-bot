"use strict";

const { getTop10Cache, getPoints } = require("../db/points");
const {
  initConfigListeners,
  onGuessCommand,
  onHLCommand,
  onCountingCommand,
  onSetupRoleCommand,
  onWeeklyCommand,
  onMessageCreate,
  onButton,
  syncUser,
} = require("./games");

function isAdminMember(interaction) {
  return (
    interaction.inGuild() &&
    (interaction.memberPermissions?.has?.("Administrator") ||
      interaction.memberPermissions?.has?.("ManageGuild"))
  );
}

function bindEvents(client) {
  client.once("ready", async () => {
    await initConfigListeners().catch(() => {});
  });

  client.on("messageCreate", async (message) => {
    await onMessageCreate(client, message);
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const name = interaction.commandName;

        if (name === "points") {
          await interaction.deferReply({ ephemeral: true });
          await syncUser(interaction.user);
          const pts = await getPoints(interaction.user.id);
          return interaction.editReply(`💰 你目前積分：**${pts}**`);
        }

        if (name === "rank") {
          const top = getTop10Cache();
          if (!top.top.length) return interaction.reply("🏆 排行榜目前沒有資料～先玩遊戲拿分吧！");
          const lines = top.top.map((x, i) => `**#${i + 1}** <@${x.userId}> — **${x.points}**`);
          const ageSec = Math.floor((Date.now() - top.updatedAt) / 1000);
          return interaction.reply(`🏆 排行榜（快取秒回）\n${lines.join("\n")}\n\n_快取更新：${ageSec}s 前_`);
        }

        if (name === "guess") return onGuessCommand(client, interaction);
        if (name === "hl") return onHLCommand(client, interaction);
        if (name === "counting") return onCountingCommand(client, interaction);
        if (name === "setup-role") return onSetupRoleCommand(interaction);
        if (name === "weekly") return onWeeklyCommand(client, interaction);
      }

      if (interaction.isButton()) {
        return onButton(client, interaction);
      }
    } catch (e) {
      try {
        if (interaction.isRepliable()) {
          if (interaction.deferred || interaction.replied) await interaction.editReply("❌ 發生錯誤，請稍後再試。");
          else await interaction.reply({ content: "❌ 發生錯誤，請稍後再試。", ephemeral: true });
        }
      } catch {}
    }
  });
}

module.exports = { bindEvents };
