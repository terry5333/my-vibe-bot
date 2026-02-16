"use strict";

/**
 * src/bot/commands.js
 * ✅ 不用 setDefaultMemberPermissions（避免版本不支援）
 * ✅ 權限改成執行時檢查：需要 ManageGuild 或 Administrator
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require("discord.js");

const pointsDb = require("../db/points.js");
const gamesMod = require("./games.js"); // { games, onMessage }

function isAdmin(interaction) {
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return (
    perms.has(PermissionFlagsBits.Administrator) ||
    perms.has(PermissionFlagsBits.ManageGuild)
  );
}

async function reply(interaction, content, ephemeral = true) {
  // ✅ 防止 40060：永遠只用「一次回覆」
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(
      typeof content === "string" ? { content } : content
    );
  }
  if (typeof content === "string") {
    return interaction.reply({ content, ephemeral });
  }
  return interaction.reply(content);
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

/* -------------------- 指令執行（interactionCreate 會呼叫）-------------------- */
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
          "• /hl start | stop | status（按鈕式）",
          "• /guess set | start | stop | status（在頻道直接輸入數字）",
          "",
          "🏆 積分：",
          "• /points 查看自己的分數",
          "• /rank 查看排行榜",
        ].join("\n")
      )
      .setFooter({ text: "提示：counting / guess 都是直接在頻道打數字" });

    return interaction.reply({ embeds: [e] });
  }

  if (commandName === "points") {
    const p = pointsDb?.getPoints ? await pointsDb.getPoints(interaction.user.id) : 0;
    return reply(interaction, `💰 <@${interaction.user.id}> 目前積分：**${p}**`, false);
  }

  if (commandName === "rank") {
    const top = interaction.options.getInteger("top") || 10;
    const rows = pointsDb?.getLeaderboard ? await pointsDb.getLeaderboard(top) : [];
    if (!rows.length) return reply(interaction, "（目前沒有排行榜資料）", true);

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}>：**${r.points}** 分`);
    const e = new EmbedBuilder().setTitle(`🏆 排行榜 Top ${top}`).setDescription(lines.join("\n"));
    return interaction.reply({ embeds: [e] });
  }

  if (commandName === "counting") {
    if (!games?.countingStart) return reply(interaction, "❌ games 模組未載入（counting 無法使用）");

    const sub = interaction.options.getSubcommand(false);
    if (!sub) return reply(interaction, "請選擇子指令：/counting start | stop | status", true);

    const channelId = interaction.channelId;

    if (sub === "start") {
      const start = interaction.options.getInteger("start") || 1;
      games.countingStart(channelId, start);
      return reply(
        interaction,
        `✅ counting 已開始！請大家在本頻道依序輸入數字，從 **${start}** 開始。\n規則：同一人連打兩次或打錯就結束。`,
        false
      );
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return reply(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。");
      games.countingStop(channelId);
      return reply(interaction, "🛑 counting 已結束。", false);
    }

    if (sub === "status") {
      const s = games.countingStatus(channelId);
      if (!s?.active) return reply(interaction, "ℹ️ 本頻道沒有進行中的 counting。", true);
      return reply(interaction, `ℹ️ counting 進行中：下一個應該輸入 **${s.expected}**`, true);
    }
  }

  if (commandName === "hl") {
    if (!games?.hlStart) return reply(interaction, "❌ games 模組未載入（hl 無法使用）");

    const sub = interaction.options.getSubcommand(false);
    if (!sub) return reply(interaction, "請選擇子指令：/hl start | stop | status", true);

    const channelId = interaction.channelId;

    if (sub === "start") {
      const max = interaction.options.getInteger("max") || 100;
      const msg = await games.hlStart(interaction, channelId, max);
      return reply(interaction, msg, true);
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return reply(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。");
      games.hlStop(channelId);
      return reply(interaction, "🛑 HL 已結束。", false);
    }

    if (sub === "status") {
      const s = games.hlStatus(channelId);
      if (!s?.active) return reply(interaction, "ℹ️ 本頻道沒有進行中的 HL。", true);
      return reply(interaction, `ℹ️ HL 進行中（1 ~ ${s.max}）`, true);
    }
  }

  if (commandName === "guess") {
    if (!games?.guessStart) return reply(interaction, "❌ games 模組未載入（guess 無法使用）");

    const sub = interaction.options.getSubcommand(false);
    if (!sub) return reply(interaction, "請選擇子指令：/guess set | start | stop | status", true);

    const channelId = interaction.channelId;

    if (sub === "set") {
      if (!isAdmin(interaction)) return reply(interaction, "❌ 只有管理員可以 /guess set。");
      const secret = interaction.options.getInteger("secret");
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;

      games.guessSet(channelId, { min, max, secret });
      return reply(
        interaction,
        `✅ 終極密碼已設定！範圍 **${min} ~ ${max}**。\n請大家直接在本頻道輸入數字猜（猜中 +10 分）。`,
        false
      );
    }

    if (sub === "start") {
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;
      games.guessStart(channelId, { min, max });
      return reply(
        interaction,
        `✅ 終極密碼開始！範圍 **${min} ~ ${max}**。\n請大家直接在本頻道輸入數字猜（猜中 +10 分）。`,
        false
      );
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return reply(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。");
      games.guessStop(channelId);
      return reply(interaction, "🛑 終極密碼已結束。", false);
    }

    if (sub === "status") {
      const s = games.guessStatus(channelId);
      if (!s?.active) return reply(interaction, "ℹ️ 本頻道沒有進行中的終極密碼。", true);
      return reply(interaction, `ℹ️ 終極密碼範圍：**${s.min} ~ ${s.max}**`, true);
    }
  }

  return reply(interaction, `❌ 未處理的指令：/${commandName}`, true);
}

/* ✅ 給 index.js 使用 */
function makeCommandHandlers(ctx = {}) {
  return {
    info: (i) => execute(i, ctx),
    points: (i) => execute(i, ctx),
    rank: (i) => execute(i, ctx),
    counting: (i) => execute(i, ctx),
    hl: (i) => execute(i, ctx),
    guess: (i) => execute(i, ctx),
  };
}

module.exports = {
  commandData,
  execute,
  makeCommandHandlers,
};