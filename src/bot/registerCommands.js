"use strict";

/**
 * src/bot/commands.js
 * - 查詢類：私密回覆（editReply）
 * - 遊戲 start/stop：直接送到頻道 + 刪掉互動回覆（看起來就是「直接開始」）
 * - HL：預設 1~13、由 games.hlStart 送出底牌訊息
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
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

async function ephem(interaction, payload) {
  const data = typeof payload === "string" ? { content: payload } : payload;
  if (interaction.deferred || interaction.replied) return interaction.editReply(data);
  return interaction.reply({ ...data, flags: MessageFlags.Ephemeral });
}

async function pub(interaction, payload) {
  const data = typeof payload === "string" ? { content: payload } : payload;
  if (interaction.channel) await interaction.channel.send(data);
  try {
    if (interaction.deferred || interaction.replied) await interaction.deleteReply();
  } catch (_) {}
}

/* -------------------- 指令宣告 -------------------- */
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
    .setDescription("HL（牌組 Higher / Lower）")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("開始一局 HL（預設 1~13）")
        .addIntegerOption((o) =>
          o.setName("max").setDescription("最大值（預設 13）").setRequired(false)
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
        .addIntegerOption((o) => o.setName("secret").setDescription("密碼數字").setRequired(true))
        .addIntegerOption((o) => o.setName("min").setDescription("最小值（預設 1）").setRequired(false))
        .addIntegerOption((o) => o.setName("max").setDescription("最大值（預設 100）").setRequired(false))
    )
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("開始終極密碼（自動隨機）")
        .addIntegerOption((o) => o.setName("min").setDescription("最小值（預設 1）").setRequired(false))
        .addIntegerOption((o) => o.setName("max").setDescription("最大值（預設 100）").setRequired(false))
    )
    .addSubcommand((s) => s.setName("stop").setDescription("結束終極密碼"))
    .addSubcommand((s) => s.setName("status").setDescription("查看終極密碼狀態")),
].map((c) => c.toJSON());

/* -------------------- 執行 -------------------- */
async function execute(interaction, { client } = {}) {
  const { commandName } = interaction;
  const games = gamesMod?.games;

  if (commandName === "info") {
    const e = new EmbedBuilder()
      .setTitle("📌 指令列表")
      .setDescription(
        [
          "🎮 遊戲：",
          "• /counting start | stop | status（在頻道直接輸入數字）",
          "• /hl start | stop | status（牌組 Higher/Lower，會先亮底牌）",
          "• /guess set | start | stop | status（在頻道直接輸入數字）",
          "",
          "🏆 積分：",
          "• /points 查看自己的分數",
          "• /rank 查看排行榜",
        ].join("\n")
      );
    return ephem(interaction, { embeds: [e] });
  }

  if (commandName === "points") {
    const p = pointsDb?.getPoints ? await pointsDb.getPoints(interaction.user.id) : 0;
    return ephem(interaction, `💰 <@${interaction.user.id}> 目前積分：**${p}**`);
  }

  if (commandName === "rank") {
    const top = interaction.options.getInteger("top") || 10;
    const rows = pointsDb?.getLeaderboard ? await pointsDb.getLeaderboard(top) : [];
    if (!rows.length) return ephem(interaction, "（目前沒有排行榜資料）");
    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}>：**${r.points}** 分`);
    const e = new EmbedBuilder().setTitle(`🏆 排行榜 Top ${top}`).setDescription(lines.join("\n"));
    return ephem(interaction, { embeds: [e] });
  }

  if (commandName === "counting") {
    if (!games?.countingStart) return ephem(interaction, "❌ games 模組未載入（counting 無法使用）");
    const sub = interaction.options.getSubcommand(false);
    if (!sub) return ephem(interaction, "❌ 請選擇子指令：start / stop / status");
    const channelId = interaction.channelId;

    if (sub === "start") {
      const start = interaction.options.getInteger("start") || 1;
      games.countingStart(channelId, start);
      return pub(interaction, `✅ counting 已開始！從 **${start}** 開始，大家直接在頻道輸入數字。`);
    }
    if (sub === "stop") {
      if (!isAdmin(interaction)) return ephem(interaction, "❌ 需要管理員權限才能 stop。");
      games.countingStop(channelId);
      return pub(interaction, "🛑 counting 已結束。");
    }
    if (sub === "status") {
      const s = games.countingStatus(channelId);
      if (!s?.active) return ephem(interaction, "ℹ️ 本頻道沒有進行中的 counting。");
      return ephem(interaction, `ℹ️ counting 進行中：下一個應該輸入 **${s.expected}**`);
    }
  }

  if (commandName === "hl") {
    if (!games?.hlStart) return ephem(interaction, "❌ games 模組未載入（hl 無法使用）");
    const sub = interaction.options.getSubcommand(false);
    if (!sub) return ephem(interaction, "❌ 請選擇子指令：start / stop / status");
    const channelId = interaction.channelId;

    if (sub === "start") {
      const max = Math.min(13, interaction.options.getInteger("max") || 13); // ✅ 預設 13
      await games.hlStart(interaction, channelId, max); // ✅ games 會送底牌到頻道
      try { await interaction.deleteReply(); } catch (_) {}
      return;
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return ephem(interaction, "❌ 需要管理員權限才能 stop。");
      games.hlStop(channelId);
      return pub(interaction, "🛑 HL 已結束。");
    }

    if (sub === "status") {
      const s = games.hlStatus(channelId);
      if (!s?.active) return ephem(interaction, "ℹ️ 本頻道沒有進行中的 HL。");
      return ephem(interaction, `ℹ️ HL 進行中（1 ~ ${s.max}），底牌：**${s.currentText}**，剩餘：${s.remaining} 張`);
    }
  }

  if (commandName === "guess") {
    if (!games?.guessStart) return ephem(interaction, "❌ games 模組未載入（guess 無法使用）");
    const sub = interaction.options.getSubcommand(false);
    if (!sub) return ephem(interaction, "❌ 請選擇子指令：set / start / stop / status");
    const channelId = interaction.channelId;

    if (sub === "set") {
      if (!isAdmin(interaction)) return ephem(interaction, "❌ 只有管理員可以 /guess set。");
      const secret = interaction.options.getInteger("secret");
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;
      games.guessSet(channelId, { min, max, secret });
      return pub(interaction, `✅ 終極密碼已設定！範圍 **${min} ~ ${max}**，大家直接在頻道輸入數字猜。`);
    }

    if (sub === "start") {
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;
      games.guessStart(channelId, { min, max });
      return pub(interaction, `✅ 終極密碼開始！範圍 **${min} ~ ${max}**，大家直接在頻道輸入數字猜。`);
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return ephem(interaction, "❌ 需要管理員權限才能 stop。");
      games.guessStop(channelId);
      return pub(interaction, "🛑 終極密碼已結束。");
    }

    if (sub === "status") {
      const s = games.guessStatus(channelId);
      if (!s?.active) return ephem(interaction, "ℹ️ 本頻道沒有進行中的終極密碼。");
      return ephem(interaction, `ℹ️ 終極密碼範圍：**${s.min} ~ ${s.max}**`);
    }
  }

  return ephem(interaction, `❌ 未處理的指令：/${commandName}`);
}

module.exports = { commandData, execute };