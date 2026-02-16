"use strict";

/**
 * src/bot/commands.js
 * - 注意：index.js 已經 deferReply(ephemeral)
 * - 這裡不要再 interaction.reply()
 * - 要在頻道「直接開始」→ 用 interaction.channel.send()
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
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

// 只用 editReply / followUp（但我們通常不留 reply）
async function edit(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(content);
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
async function execute(interaction, { client } = {}) {
  const { commandName } = interaction;
  const games = gamesMod?.games;

  // /info：你如果不想有任何回覆，就改成直接丟頻道 embed
  if (commandName === "info") {
    const e = new EmbedBuilder()
      .setTitle("📌 指令列表")
      .setDescription(
        [
          "🎮 遊戲：",
          "• /counting start | stop | status（在頻道直接輸入數字）",
          "• /hl start | stop | status（按鈕式，預設 1~13）",
          "• /guess set | start | stop | status（在頻道直接輸入數字）",
          "",
          "🏆 積分：",
          "• /points 查看自己的分數",
          "• /rank 查看排行榜",
        ].join("\n")
      )
      .setFooter({ text: "提示：counting / guess 都是直接在頻道打數字" });

    await interaction.channel.send({ embeds: [e] });
    return { keepReply: false };
  }

  if (commandName === "points") {
    const p = pointsDb?.getPoints ? await pointsDb.getPoints(interaction.user.id) : 0;
    await interaction.channel.send(`💰 <@${interaction.user.id}> 目前積分：**${p}**`);
    return { keepReply: false };
  }

  if (commandName === "rank") {
    const top = interaction.options.getInteger("top") || 10;
    const rows = pointsDb?.getLeaderboard ? await pointsDb.getLeaderboard(top) : [];
    if (!rows.length) {
      await interaction.channel.send("（目前沒有排行榜資料）");
      return { keepReply: false };
    }

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}>：**${r.points}** 分`);
    const e = new EmbedBuilder()
      .setTitle(`🏆 排行榜 Top ${top}`)
      .setDescription(lines.join("\n"));

    await interaction.channel.send({ embeds: [e] });
    return { keepReply: false };
  }

  if (commandName === "counting") {
    if (!games?.countingStart) {
      await interaction.channel.send("❌ games 模組未載入（counting 無法使用）");
      return { keepReply: false };
    }

    const sub = interaction.options.getSubcommand(false);
    const channelId = interaction.channelId;

    if (!sub) {
      await interaction.channel.send("❌ 請使用：/counting start|stop|status");
      return { keepReply: false };
    }

    if (sub === "start") {
      const start = interaction.options.getInteger("start") || 1;
      games.countingStart(channelId, start);
      await interaction.channel.send(
        `✅ counting 已開始！請大家在本頻道依序輸入數字，從 **${start}** 開始。\n規則：同一人連打兩次或打錯就結束。`
      );
      return { keepReply: false };
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) {
        await interaction.channel.send("❌ 需要管理員權限（Manage Server）才能 stop。");
        return { keepReply: false };
      }
      games.countingStop(channelId);
      await interaction.channel.send("🛑 counting 已結束。");
      return { keepReply: false };
    }

    if (sub === "status") {
      const s = games.countingStatus(channelId);
      if (!s?.active) {
        await interaction.channel.send("ℹ️ 本頻道沒有進行中的 counting。");
        return { keepReply: false };
      }
      await interaction.channel.send(`ℹ️ counting 進行中：下一個應該輸入 **${s.expected}**`);
      return { keepReply: false };
    }
  }

  if (commandName === "hl") {
    if (!games?.hlStart) {
      await interaction.channel.send("❌ games 模組未載入（hl 無法使用）");
      return { keepReply: false };
    }

    const sub = interaction.options.getSubcommand(false);
    const channelId = interaction.channelId;

    if (!sub) {
      await interaction.channel.send("❌ 請使用：/hl start|stop|status");
      return { keepReply: false };
    }

    if (sub === "start") {
      // ✅ 你要預設 1~13
      const max = interaction.options.getInteger("max") || 13;
      await games.hlStart(interaction, channelId, max); // 會自己送牌桌訊息（含底牌）
      return { keepReply: false };
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) {
        await interaction.channel.send("❌ 需要管理員權限（Manage Server）才能 stop。");
        return { keepReply: false };
      }
      games.hlStop(channelId);
      await interaction.channel.send("🛑 HL 已結束。");
      return { keepReply: false };
    }

    if (sub === "status") {
      const s = games.hlStatus(channelId);
      if (!s?.active) {
        await interaction.channel.send("ℹ️ 本頻道沒有進行中的 HL。");
        return { keepReply: false };
      }
      await interaction.channel.send(`ℹ️ HL 進行中（1 ~ ${s.max}），目前底牌：**${s.current}**`);
      return { keepReply: false };
    }
  }

  if (commandName === "guess") {
    if (!games?.guessStart) {
      await interaction.channel.send("❌ games 模組未載入（guess 無法使用）");
      return { keepReply: false };
    }

    const sub = interaction.options.getSubcommand(false);
    const channelId = interaction.channelId;

    if (!sub) {
      await interaction.channel.send("❌ 請使用：/guess start|set|stop|status");
      return { keepReply: false };
    }

    if (sub === "set") {
      if (!isAdmin(interaction)) {
        await interaction.channel.send("❌ 只有管理員可以 /guess set。");
        return { keepReply: false };
      }
      const secret = interaction.options.getInteger("secret");
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;

      games.guessSet(channelId, { min, max, secret });
      await interaction.channel.send(
        `✅ 終極密碼已設定！範圍 **${min} ~ ${max}**。\n請大家直接在本頻道輸入數字猜（猜中 +10 分）。`
      );
      return { keepReply: false };
    }

    if (sub === "start") {
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;
      games.guessStart(channelId, { min, max });
      await interaction.channel.send(
        `✅ 終極密碼開始！範圍 **${min} ~ ${max}**。\n請大家直接在本頻道輸入數字猜（猜中 +10 分）。`
      );
      return { keepReply: false };
    }

    if (sub === "stop") {
      if (!isAdmin(interaction)) {
        await interaction.channel.send("❌ 需要管理員權限（Manage Server）才能 stop。");
        return { keepReply: false };
      }
      games.guessStop(channelId);
      await interaction.channel.send("🛑 終極密碼已結束。");
      return { keepReply: false };
    }

    if (sub === "status") {
      const s = games.guessStatus(channelId);
      if (!s?.active) {
        await interaction.channel.send("ℹ️ 本頻道沒有進行中的終極密碼。");
        return { keepReply: false };
      }
      await interaction.channel.send(`ℹ️ 終極密碼範圍：**${s.min} ~ ${s.max}**`);
      return { keepReply: false };
    }
  }

  // fallback
  await edit(interaction, `❌ 未處理的指令：/${commandName}`);
  return { keepReply: true }; // 這種才保留（方便你 debug）
}

module.exports = {
  commandData,
  execute,
};