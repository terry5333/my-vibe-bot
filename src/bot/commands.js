"use strict";

/**
 * src/bot/commands.js
 * ✅ 配合 A 方案：index.js 統一 deferReply()
 *    → 這裡「不要再 interaction.reply()」
 *    → 只用 editReply / followUp
 * ✅ 不用 setDefaultMemberPermissions（避免版本不支援）
 * ✅ 權限改成執行時檢查：需要 ManageGuild 或 Administrator
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

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

/**
 * ✅ 統一回覆工具
 * - index 已 deferReply(flags: Ephemeral)，所以：
 *   - 想回覆「同一則」：editReply()
 *   - 想額外再說一句：followUp()
 * - 若想要「公開訊息」：用 followUp({ flags: 0 })
 */
async function reply(interaction, payload, { ephemeral = true, followUp = false } = {}) {
  const data = typeof payload === "string" ? { content: payload } : payload;

  const hasAck = interaction.deferred || interaction.replied;

  // index 先 defer 了，通常都走這裡
  if (hasAck) {
    // followUp 模式：可選擇公開或私密
    if (followUp) {
      return interaction.followUp({
        ...data,
        flags: ephemeral ? MessageFlags.Ephemeral : 0,
      });
    }

    // editReply：會沿用 deferReply 當下的 ephemeral（通常是私密）
    // 若你要求公開，editReply 做不到「轉公開」，因此用 followUp 公開補一則
    if (ephemeral === false) {
      // 先把原本的 ephemeral 回覆改成簡短提示（避免空白）
      try {
        await interaction.editReply({ content: "✅ 已處理（公開訊息已發送）" });
      } catch (_) {}
      return interaction.followUp({ ...data, flags: 0 });
    }

    return interaction.editReply(data);
  }

  // 保底（理論上不會走到，因為 index 會 defer）
  return interaction.reply({
    ...data,
    flags: ephemeral ? MessageFlags.Ephemeral : 0,
  });
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
async function execute(interaction, { client, webRuntime } = {}) {
  const { commandName } = interaction;

  // 確保 games 模組存在
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

    return reply(interaction, { embeds: [e] }, { ephemeral: true });
  }

  if (commandName === "points") {
    const p = pointsDb?.getPoints ? await pointsDb.getPoints(interaction.user.id) : 0;
    return reply(
      interaction,
      `💰 <@${interaction.user.id}> 目前積分：**${p}**`,
      { ephemeral: false } // 想公開
    );
  }

  if (commandName === "rank") {
    const top = interaction.options.getInteger("top") || 10;
    const rows = pointsDb?.getLeaderboard ? await pointsDb.getLeaderboard(top) : [];
    if (!rows.length) return reply(interaction, "（目前沒有排行榜資料）", { ephemeral: true });

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}>：**${r.points}** 分`);
    const e = new EmbedBuilder().setTitle(`🏆 排行榜 Top ${top}`).setDescription(lines.join("\n"));
    return reply(interaction, { embeds: [e] }, { ephemeral: false }); // 公開
  }

  if (commandName === "counting") {
    if (!games?.countingStart) return reply(interaction, "❌ games 模組未載入（counting 無法使用）", { ephemeral: true });

    // ✅ 防呆：沒子指令就不噴錯
    const sub = interaction.options.getSubcommand(false);
    if (!sub) return reply(interaction, "❌ 請指定子指令：start / stop / status", { ephemeral: true });

    const channelId = interaction.channelId;

    if (sub === "start") {
      const start = interaction.options.getInteger("start") || 1;
      games.countingStart(channelId, start);
      return reply(
        interaction,
        `✅ counting 已開始！請大家在本頻道依序輸入數字，從 **${start}** 開始。\n規則：同一人連打兩次或打錯就結束。`,
        { ephemeral: false }
      );
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return reply(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。", { ephemeral: true });
      games.countingStop(channelId);
      return reply(interaction, "🛑 counting 已結束。", { ephemeral: false });
    }

    if (sub === "status") {
      const s = games.countingStatus(channelId);
      if (!s?.active) return reply(interaction, "ℹ️ 本頻道沒有進行中的 counting。", { ephemeral: true });
      return reply(interaction, `ℹ️ counting 進行中：下一個應該輸入 **${s.expected}**`, { ephemeral: true });
    }
  }

  if (commandName === "hl") {
    if (!games?.hlStart) return reply(interaction, "❌ games 模組未載入（hl 無法使用）", { ephemeral: true });

    const sub = interaction.options.getSubcommand(false);
    if (!sub) return reply(interaction, "❌ 請指定子指令：start / stop / status", { ephemeral: true });

    const channelId = interaction.channelId;

    if (sub === "start") {
      const max = interaction.options.getInteger("max") || 100;

      // hlStart 可能會自己送訊息，所以這裡只回一句（避免空白）
      const msg = await games.hlStart(interaction, channelId, max);
      return reply(interaction, msg || "✅ HL 已開始！", { ephemeral: true });
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return reply(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。", { ephemeral: true });
      games.hlStop(channelId);
      return reply(interaction, "🛑 HL 已結束。", { ephemeral: false });
    }

    if (sub === "status") {
      const s = games.hlStatus(channelId);
      if (!s?.active) return reply(interaction, "ℹ️ 本頻道沒有進行中的 HL。", { ephemeral: true });
      return reply(interaction, `ℹ️ HL 進行中（1 ~ ${s.max}）`, { ephemeral: true });
    }
  }

  if (commandName === "guess") {
    if (!games?.guessStart) return reply(interaction, "❌ games 模組未載入（guess 無法使用）", { ephemeral: true });

    const sub = interaction.options.getSubcommand(false);
    if (!sub) return reply(interaction, "❌ 請指定子指令：set / start / stop / status", { ephemeral: true });

    const channelId = interaction.channelId;

    if (sub === "set") {
      if (!isAdmin(interaction)) return reply(interaction, "❌ 只有管理員可以 /guess set。", { ephemeral: true });

      const secret = interaction.options.getInteger("secret");
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;

      games.guessSet(channelId, { min, max, secret });
      return reply(
        interaction,
        `✅ 終極密碼已設定！範圍 **${min} ~ ${max}**。\n請大家直接在本頻道輸入數字猜（猜中 +10 分）。`,
        { ephemeral: false }
      );
    }

    if (sub === "start") {
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;
      games.guessStart(channelId, { min, max });
      return reply(
        interaction,
        `✅ 終極密碼開始！範圍 **${min} ~ ${max}**。\n請大家直接在本頻道輸入數字猜（猜中 +10 分）。`,
        { ephemeral: false }
      );
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) return reply(interaction, "❌ 需要管理員權限（Manage Server）才能 stop。", { ephemeral: true });
      games.guessStop(channelId);
      return reply(interaction, "🛑 終極密碼已結束。", { ephemeral: false });
    }

    if (sub === "status") {
      const s = games.guessStatus(channelId);
      if (!s?.active) return reply(interaction, "ℹ️ 本頻道沒有進行中的終極密碼。", { ephemeral: true });
      return reply(interaction, `ℹ️ 終極密碼範圍：**${s.min} ~ ${s.max}**`, { ephemeral: true });
    }
  }

  return reply(interaction, `❌ 未處理的指令：/${commandName}`, { ephemeral: true });
}

module.exports = {
  commandData, // 給 registerCommands() 用
  // 相容舊的 events.js 取法
  getCommand: (name) => ({ execute: (i, ctx) => execute(i, ctx) }),
  execute,
};