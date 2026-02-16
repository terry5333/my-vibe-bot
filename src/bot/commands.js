"use strict";

/**
 * src/bot/commands.js
 *
 * 提供：
 * - getSlashCommandData()  給 registerCommands() 用來註冊全部 slash
 * - getCommand(name)       給 events.js 取 execute handler
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const pointsDb = require("../db/points.js");
const { games } = require("./games.js");

// ===== Slash 定義 =====
const slashData = [
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("顯示遊戲指令與規則"),

  new SlashCommandBuilder()
    .setName("points")
    .setDescription("查看自己的分數"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("查看排行榜（前 20 名）"),

  new SlashCommandBuilder()
    .setName("counting")
    .setDescription("數字接龍（在頻道直接打數字）")
    .addSubcommand((s) =>
      s.setName("start").setDescription("開始本頻道的 counting")
        .addIntegerOption((o) =>
          o.setName("start_number")
            .setDescription("起始數字（預設 1）")
            .setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s.setName("stop").setDescription("停止本頻道的 counting")
    )
    .addSubcommand((s) =>
      s.setName("status").setDescription("查看本頻道 counting 狀態")
    ),

  new SlashCommandBuilder()
    .setName("hl")
    .setDescription("高低（按鈕版）")
    .addSubcommand((s) =>
      s.setName("start").setDescription("開始一局高低（按鈕選擇）")
        .addIntegerOption((o) =>
          o.setName("max")
            .setDescription("最大值（預設 100）")
            .setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s.setName("stop").setDescription("停止本頻道高低")
    )
    .addSubcommand((s) =>
      s.setName("status").setDescription("查看本頻道高低狀態")
    ),

  // ✅ 終極密碼：不是 try，而是「直接在伺服器改數字」
  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("終極密碼（管理員設定答案，大家在頻道猜）")
    .addSubcommand((s) =>
      s.setName("set").setDescription("（管理員）直接設定答案數字")
        .addIntegerOption((o) =>
          o.setName("number").setDescription("答案數字").setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("min").setDescription("最小值（預設 1）").setRequired(false)
        )
        .addIntegerOption((o) =>
          o.setName("max").setDescription("最大值（預設 100）").setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // 管理員權限
    )
    .addSubcommand((s) =>
      s.setName("start").setDescription("開始終極密碼（沿用已設定答案或隨機）")
        .addIntegerOption((o) =>
          o.setName("min").setDescription("最小值（預設 1）").setRequired(false)
        )
        .addIntegerOption((o) =>
          o.setName("max").setDescription("最大值（預設 100）").setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s.setName("stop").setDescription("停止本頻道終極密碼")
    )
    .addSubcommand((s) =>
      s.setName("status").setDescription("查看本頻道終極密碼狀態")
    ),
].map((x) => x.toJSON());

// ===== Handler（execute）=====
const commands = new Map();

// /info
commands.set("info", {
  execute: async (interaction) => {
    const msg =
      [
        "🎮 **遊戲指令**",
        "• `/counting start|stop|status`：在頻道直接打數字接龍",
        "• `/hl start|stop|status`：按鈕版高低",
        "• `/guess set|start|stop|status`：終極密碼（管理員可直接設定答案）",
        "",
        "🏆 **加分規則**",
        "• counting 正確一次：+2 分",
        "• hl 猜中一次：+5 分",
        "• 終極密碼猜到：+10 分",
      ].join("\n");
    return interaction.editReply(msg);
  },
});

// /points
commands.set("points", {
  execute: async (interaction) => {
    const userId = interaction.user.id;
    const p = await pointsDb.getPoints(userId);
    return interaction.editReply(`⭐ 你的分數：**${p}**`);
  },
});

// /rank
commands.set("rank", {
  execute: async (interaction) => {
    // 你 pointsDb 若沒有 leaderboard，可先用簡單提示
    if (!pointsDb.getLeaderboard) {
      return interaction.editReply("❌ 目前沒有 getLeaderboard()，請先補上排行榜功能。");
    }
    const rows = await pointsDb.getLeaderboard(20);
    if (!rows || rows.length === 0) return interaction.editReply("目前還沒有排行榜資料。");

    const lines = rows.map((r, i) => `#${i + 1} <@${r.userId}>：**${r.points}**`);
    return interaction.editReply("🏆 **排行榜 Top 20**\n" + lines.join("\n"));
  },
});

// /counting
commands.set("counting", {
  execute: async (interaction) => {
    const sub = interaction.options.getSubcommand();
    const channelId = interaction.channelId;

    if (sub === "start") {
      const startNumber = interaction.options.getInteger("start_number") ?? 1;
      games.countingStart(channelId, startNumber);
      return interaction.editReply(
        `✅ counting 已開始！請在此頻道直接輸入數字，下一個應該是 **${startNumber}**`
      );
    }

    if (sub === "stop") {
      games.countingStop(channelId);
      return interaction.editReply("🛑 counting 已停止。");
    }

    if (sub === "status") {
      const s = games.countingStatus(channelId);
      return interaction.editReply(
        s.active
          ? `📌 counting 進行中：下一個數字應該是 **${s.expected}**（上一位：${s.lastUserId ? `<@${s.lastUserId}>` : "無"}）`
          : "📌 counting 未啟動。"
      );
    }
  },
});

// /hl
commands.set("hl", {
  execute: async (interaction) => {
    const sub = interaction.options.getSubcommand();
    const channelId = interaction.channelId;

    if (sub === "start") {
      const max = interaction.options.getInteger("max") ?? 100;
      const res = await games.hlStart(interaction, channelId, max);
      return interaction.editReply(res);
    }

    if (sub === "stop") {
      games.hlStop(channelId);
      return interaction.editReply("🛑 hl 已停止。");
    }

    if (sub === "status") {
      const s = games.hlStatus(channelId);
      return interaction.editReply(
        s.active ? `📌 hl 進行中（max=${s.max}）` : "📌 hl 未啟動。"
      );
    }
  },
});

// /guess（終極密碼）
commands.set("guess", {
  execute: async (interaction) => {
    const sub = interaction.options.getSubcommand();
    const channelId = interaction.channelId;

    if (sub === "set") {
      const number = interaction.options.getInteger("number");
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;
      games.guessSet(channelId, { min, max, secret: number });
      return interaction.editReply(`✅ 已設定終極密碼：範圍 **${min}~${max}**，答案已更新（不會顯示給玩家）。`);
    }

    if (sub === "start") {
      const min = interaction.options.getInteger("min") ?? 1;
      const max = interaction.options.getInteger("max") ?? 100;
      games.guessStart(channelId, { min, max });
      return interaction.editReply(`✅ 終極密碼已開始！範圍 **${min}~${max}**（在頻道直接輸入數字猜）。`);
    }

    if (sub === "stop") {
      games.guessStop(channelId);
      return interaction.editReply("🛑 終極密碼已停止。");
    }

    if (sub === "status") {
      const s = games.guessStatus(channelId);
      return interaction.editReply(
        s.active
          ? `📌 終極密碼進行中：範圍 **${s.min}~${s.max}**`
          : "📌 終極密碼未啟動。"
      );
    }
  },
});

// ===== Export =====
function getSlashCommandData() {
  return slashData;
}

function getCommand(name) {
  // events.js 會用這個取 handler
  return commands.get(name);
}

module.exports = {
  getSlashCommandData,
  getCommand,
  commands,
};