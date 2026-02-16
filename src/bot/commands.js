"use strict";

/**
 * src/bot/commands.js
 * - index.js 會先 deferReply({ flags: Ephemeral })
 * - 這裡「不要再 interaction.reply()」
 * - start 類指令：直接 channel.send() 開始，然後 interaction.deleteReply() 清掉 ACK
 */

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");

const pointsDb = require("../db/points.js");
const gamesMod = require("./games.js"); // module.exports = { games, onMessage }

function isAdmin(interaction) {
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return (
    perms.has(PermissionFlagsBits.Administrator) ||
    perms.has(PermissionFlagsBits.ManageGuild)
  );
}

// ✅ index.js 已 deferReply，這裡統一用 editReply（避免 40060）
async function ack(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(content);
  }
  // 保底（理論上不會走到）
  return interaction.reply({ content });
}

// ✅ start 類：在頻道送訊息，然後刪掉 defer 的回覆（你要的「直接開始」）
async function startInChannel(interaction, message) {
  if (interaction.channel) {
    await interaction.channel.send(message);
  }
  // 把「思考中/ephemeral」那個回覆刪掉，使用者就不會看到任何提示
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.deleteReply();
    }
  } catch (_) {}
}

/* -------------------- 指令宣告（用來註冊）-------------------- */
const commandData = [
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("顯示機器人資訊與指令列表"),

  new SlashCommandBuilder()
    .setName("points")
    .setDescription("查看自己的積分"),

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
].map((c) => c.toJSON());

/* -------------------- 指令執行 -------------------- */
async function execute(interaction, { client, webRuntime } = {}) {
  const { commandName } = interaction;
  const games = gamesMod?.games;

  if (commandName === "info") {
    const e = new EmbedBuilder()
      .setTitle("📌 指令列表")
      .setDescription(
        [
          "🎮 遊戲：",
          "• /counting start | stop | status（在頻道直接輸入數字）",
          "• /hl start | stop | status（按鈕式）",
          "• /guess set | start | stop | status（在頻道直接輸入數字）",
          "",
          "🏆 積分：",
          "• /points 查看自己的分數",
          "• /rank 查看排行榜",
        ].join("\n")
      )
      .setFooter({ text: "提示：counting / guess 都是直接在頻道打數字" });

    // 這個可以留在 ephemeral（editReply）
    return interaction.editReply({ embeds: [e] });
  }

  if (commandName === "points") {
    const p = pointsDb?.getPoints ? await pointsDb.getPoints(interaction.user.id) : 0;
    return ack(interaction, `💰 <@${interaction.user.id}> 目前積分：**${p}**`);
  }

  if (commandName === "rank") {
    const top = interaction.options.getInteger("top") || 10;
    const rows = pointsDb?.getLeaderboard ? await pointsDb.getLeaderboard(top) : [];
    if (!rows.length) return ack(interaction, "（目前沒有排行榜資料）");

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}>：**${r.points}** 分`);
    const e = new EmbedBuilder().setTitle(`🏆 排行榜 Top ${top}`).setDescription(lines.join("\n"));
    return interaction.editReply({ embeds: [e] });
  }

  if (commandName === "counting") {
    if (!games?.countingStart) return ack(interaction, "❌ games 模組未載入（counting 無法使用）");

    const sub = interaction.options.getSubcommand(false);
    const channelId = interaction.channelId;

    if (!sub) {
      return ack(interaction, "用法：/counting start | stop | status");
    }

    if (sub === "start") {
      const start = interaction.options.getInteger("start") || 1;
      games.countingStart(channelId, start);

      // ✅ 直接開始：在頻道公告 + 刪掉 interaction 回覆
      return startInChannel(
        interaction,
        `✅ **counting 已開始！**\n請大家在本頻道依序輸入數字，從 **${start}** 開始。\n規則：同一人連打兩次或打錯就結束。`
      );
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return ack(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。");
      games.countingStop(channelId);
      // stop 可以選擇公告在頻道，或只回覆你（我用頻道公告比較直覺）
      return startInChannel(interaction, "🛑 **counting 已結束。**");
    }

    if (sub === "status") {
      const s = games.countingStatus(channelId);
      if (!s?.active) return ack(interaction, "ℹ️ 本頻道沒有進行中的 counting。");
      return ack(interaction, `ℹ️ counting 進行中：下一個應該輸入 **${s.expected}**`);
    }
  }

  if (commandName === "hl") {
    if (!games?.hlStart) return ack(interaction, "❌ games 模組未載入（hl 無法使用）");

    const sub = interaction.options.getSubcommand(false);
    const channelId = interaction.channelId;

    if (!sub) {
      return ack(interaction, "用法：/hl start | stop | status");
    }

    if (sub === "start") {
      const max = interaction.options.getInteger("max") || 100;

      // hlStart 你原本說「會自己送訊息」：那就不要再回覆任何東西
      await games.hlStart(interaction, channelId, max);

      // ✅ 刪掉 interaction 的回覆（使用者不會看到任何「已公開/ephemeral」）
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.deleteReply();
        }
      } catch (_) {}
      return;
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return ack(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。");
      games.hlStop(channelId);
      return startInChannel(interaction, "🛑 **HL 已結束。**");
    }

    if (sub === "status") {
      const s = games.hlStatus(channelId);
      if (!s?.active) return ack(interaction, "ℹ️ 本頻道沒有進行中的 HL。");
      return ack(interaction, `ℹ️ HL 進行中（1 ~ ${s.max}）`);
    }
  }

  if (commandName === "guess") {
    if (!games?.guessStart) return ack(interaction, "❌ games 模組未載入（guess 無法使用）");

    const sub = interaction.options.getSubcommand(false);
    const channelId = interaction.channelId;

    if (!sub) {
      return ack(interaction, "用法：/guess set | start | stop | status");
    }

    if (sub === "set") {
      if (!isAdmin(interaction)) return ack(interaction, "❌ 只有管理員可以 /guess set。");
      const secret = interaction.options.getInteger("secret");
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;

      games.guessSet(channelId, { min, max, secret });

      // ✅ 直接開始提示在頻道 + 刪掉 interaction 回覆
      return startInChannel(
        interaction,
        `✅ **終極密碼已設定並開始！**\n範圍 **${min} ~ ${max}**。\n請大家直接在本頻道輸入數字猜（猜中 +10 分）。`
      );
    }

    if (sub === "start") {
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;
      games.guessStart(channelId, { min, max });

      // ✅ 直接開始提示在頻道 + 刪掉 interaction 回覆
      return startInChannel(
        interaction,
        `✅ **終極密碼開始！**\n範圍 **${min} ~ ${max}**。\n請大家直接在本頻道輸入數字猜（猜中 +10 分）。`
      );
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return ack(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。");
      games.guessStop(channelId);
      return startInChannel(interaction, "🛑 **終極密碼已結束。**");
    }

    if (sub === "status") {
      const s = games.guessStatus(channelId);
      if (!s?.active) return ack(interaction, "ℹ️ 本頻道沒有進行中的終極密碼。");
      return ack(interaction, `ℹ️ 終極密碼範圍：**${s.min} ~ ${s.max}**`);
    }
  }

  return ack(interaction, `❌ 未處理的指令：/${commandName}`);
}

module.exports = {
  commandData, // 給 registerCommands 用
  getCommand: (name) => ({ execute: (i, ctx) => execute(i, ctx) }),
  execute,
};