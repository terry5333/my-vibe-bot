"use strict";

/**
 * src/bot/commands.js
 * ✅ /rps + /bj
 * ✅ 用 flags 取代 ephemeral（避免 deprecated warning）
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const pointsDb = require("../db/points.js");
const gamesMod = require("./games.js");

function isAdmin(interaction) {
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return (
    perms.has(PermissionFlagsBits.Administrator) ||
    perms.has(PermissionFlagsBits.ManageGuild)
  );
}

async function safeDefer(interaction, ephemeral = true) {
  if (interaction.deferred || interaction.replied) return;
  // 用 flags 避免 deprecated
  await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : 0 });
}

async function safeReply(interaction, content, { ephemeral = true, embeds, components } = {}) {
  const payload = {
    content,
    embeds,
    components,
    flags: ephemeral ? MessageFlags.Ephemeral : 0,
  };

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  return interaction.reply(payload);
}

/* -------------------- 指令宣告（用來註冊）-------------------- */
const commandData = [
  new SlashCommandBuilder().setName("info").setDescription("顯示機器人資訊與指令列表"),

  new SlashCommandBuilder().setName("points").setDescription("查看自己的積分"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("查看排行榜")
    .addIntegerOption((o) =>
      o.setName("top").setDescription("顯示前幾名（預設 10）").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("counting")
    .setDescription("數字接龍（在頻道直接輸入數字）")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("開始一局 counting")
        .addIntegerOption((o) =>
          o.setName("start").setDescription("起始數字（預設 1）").setRequired(false)
        )
    )
    .addSubcommand((s) => s.setName("stop").setDescription("強制結束 counting"))
    .addSubcommand((s) => s.setName("status").setDescription("查看 counting 狀態")),

  new SlashCommandBuilder()
    .setName("hl")
    .setDescription("HL（按鈕式）")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("開始一局 HL")
        .addIntegerOption((o) =>
          o.setName("max").setDescription("最大值（預設 100）").setRequired(false)
        )
    )
    .addSubcommand((s) => s.setName("stop").setDescription("結束 HL"))
    .addSubcommand((s) => s.setName("status").setDescription("查看 HL 狀態")),

  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("終極密碼（在頻道直接輸入數字）")
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("直接在伺服器設定密碼數字（管理員）")
        .addIntegerOption((o) =>
          o.setName("secret").setDescription("密碼數字").setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("min").setDescription("最小值（預設 1）").setRequired(false)
        )
        .addIntegerOption((o) =>
          o.setName("max").setDescription("最大值（預設 100）").setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("開始終極密碼（自動隨機）")
        .addIntegerOption((o) =>
          o.setName("min").setDescription("最小值（預設 1）").setRequired(false)
        )
        .addIntegerOption((o) =>
          o.setName("max").setDescription("最大值（預設 100）").setRequired(false)
        )
    )
    .addSubcommand((s) => s.setName("stop").setDescription("結束終極密碼"))
    .addSubcommand((s) => s.setName("status").setDescription("查看終極密碼狀態")),

  // ✅ 新增：猜拳
  new SlashCommandBuilder()
    .setName("rps")
    .setDescription("猜拳（按鈕）")
    .addUserOption((o) =>
      o.setName("opponent").setDescription("指定對手（不填則自己玩）").setRequired(false)
    ),

  // ✅ 新增：21點
  new SlashCommandBuilder()
    .setName("bj")
    .setDescription("21點 BlackJack（按鈕）")
    .addUserOption((o) =>
      o.setName("opponent").setDescription("指定對手（不填則自己玩）").setRequired(false)
    ),
].map((c) => c.toJSON());

/* -------------------- 指令執行 -------------------- */
async function execute(interaction, { client } = {}) {
  const { commandName } = interaction;
  const games = gamesMod?.games;

  if (commandName === "info") {
    await safeDefer(interaction, true);

    const e = new EmbedBuilder()
      .setTitle("📌 指令列表")
      .setDescription(
        [
          "🎮 遊戲：",
          "• /counting start | stop | status（在頻道直接輸入數字）",
          "• /hl start | stop | status（按鈕式）",
          "• /guess set | start | stop | status（在頻道直接輸入數字）",
          "• /rps（猜拳按鈕）",
          "• /bj（21點按鈕）",
          "",
          "🏆 積分：",
          "• /points 查看自己的分數",
          "• /rank 查看排行榜",
        ].join("\n")
      );

    return safeReply(interaction, null, { ephemeral: true, embeds: [e] });
  }

  if (commandName === "points") {
    await safeDefer(interaction, true);
    const p = pointsDb?.getPoints ? await pointsDb.getPoints(interaction.user.id) : 0;
    return safeReply(interaction, `💰 <@${interaction.user.id}> 目前積分：**${p}**`, { ephemeral: true });
  }

  if (commandName === "rank") {
    await safeDefer(interaction, true);

    const top = interaction.options.getInteger("top") || 10;
    const rows = pointsDb?.getLeaderboard ? await pointsDb.getLeaderboard(top) : [];

    if (!rows.length) return safeReply(interaction, "（目前沒有排行榜資料）", { ephemeral: true });

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}>：**${r.points}** 分`);
    const e = new EmbedBuilder().setTitle(`🏆 排行榜 Top ${top}`).setDescription(lines.join("\n"));
    return safeReply(interaction, null, { ephemeral: true, embeds: [e] });
  }

  // -------- RPS（公開開始，不要「已公開消息」+另一則）--------
  if (commandName === "rps") {
    if (!games?.rpsStart) return safeReply(interaction, "❌ games 模組未載入（rps 無法使用）", { ephemeral: true });

    await safeDefer(interaction, false);

    const opponent = interaction.options.getUser("opponent") || null;
    const { content, components } = games.rpsStart({
      channelId: interaction.channelId,
      messageAuthorId: interaction.user.id,
      opponentId: opponent?.id || null,
    });

    return safeReply(interaction, content, { ephemeral: false, components });
  }

  // -------- BJ（公開開始）--------
  if (commandName === "bj") {
    if (!games?.bjStart) return safeReply(interaction, "❌ games 模組未載入（bj 無法使用）", { ephemeral: true });

    await safeDefer(interaction, false);

    const opponent = interaction.options.getUser("opponent") || null;
    const { content, components } = games.bjStart({
      channelId: interaction.channelId,
      messageAuthorId: interaction.user.id,
      opponentId: opponent?.id || null,
    });

    return safeReply(interaction, content, { ephemeral: false, components });
  }

  // 你原本 counting/hl/guess 的邏輯照舊（略）
  // 如果你要我把它們也一起完整整合進來，我可以再給你 “全整合版 commands.js”

  return safeReply(interaction, `❌ 未處理的指令：/${commandName}`, { ephemeral: true });
}

module.exports = {
  commandData,
  execute,
  getCommand: (name) => ({ execute: (i, ctx) => execute(i, ctx) }),
};