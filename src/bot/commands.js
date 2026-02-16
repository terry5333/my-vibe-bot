"use strict";

const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const pointsDb = require("../db/points");
const state = require("./state");

/**
 * ⚠️ 你要在 ENV 放：
 * DISCORD_TOKEN
 * CLIENT_ID
 * (可選) GUILD_ID  -> 有填就「秒生效」，沒填就是 GLOBAL 可能要等幾分鐘
 */

function buildCommands() {
  const cmds = [];

  // /info
  cmds.push(
    new SlashCommandBuilder()
      .setName("info")
      .setDescription("查看機器人資訊與狀態")
  );

  // /points
  cmds.push(
    new SlashCommandBuilder()
      .setName("points")
      .setDescription("查看某人的分數（預設自己）")
      .addUserOption((o) => o.setName("user").setDescription("要查誰").setRequired(false))
  );

  // /rank
  cmds.push(
    new SlashCommandBuilder()
      .setName("rank")
      .setDescription("查看排行榜（Top 20）")
  );

  // /guess
  cmds.push(
    new SlashCommandBuilder()
      .setName("guess")
      .setDescription("終極密碼：開始/猜/停止")
      .addSubcommand((s) =>
        s
          .setName("start")
          .setDescription("開始終極密碼（預設 1~100）")
          .addIntegerOption((o) => o.setName("min").setDescription("最小值").setRequired(false))
          .addIntegerOption((o) => o.setName("max").setDescription("最大值").setRequired(false))
      )
      .addSubcommand((s) =>
        s
          .setName("try")
          .setDescription("猜數字")
          .addIntegerOption((o) => o.setName("n").setDescription("你猜的數字").setRequired(true))
      )
      .addSubcommand((s) => s.setName("stop").setDescription("停止終極密碼"))
  );

  // /hl
  cmds.push(
    new SlashCommandBuilder()
      .setName("hl")
      .setDescription("High/Low：開始/猜/停止（簡化牌 1~13）")
      .addSubcommand((s) => s.setName("start").setDescription("開始 High/Low"))
      .addSubcommand((s) =>
        s
          .setName("pick")
          .setDescription("猜下一張是高還是低")
          .addStringOption((o) =>
            o
              .setName("choice")
              .setDescription("high 或 low")
              .setRequired(true)
              .addChoices(
                { name: "高 (high)", value: "high" },
                { name: "低 (low)", value: "low" }
              )
          )
      )
      .addSubcommand((s) => s.setName("stop").setDescription("停止 High/Low"))
  );

  // /counting
  cmds.push(
    new SlashCommandBuilder()
      .setName("counting")
      .setDescription("數字接龍：開始/停止/狀態")
      .addSubcommand((s) => s.setName("start").setDescription("開始數字接龍（訊息打 1、2、3...）"))
      .addSubcommand((s) => s.setName("stop").setDescription("停止數字接龍"))
      .addSubcommand((s) => s.setName("status").setDescription("查看數字接龍狀態"))
  );

  return cmds;
}

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.error("❌ 缺少 ENV：DISCORD_TOKEN / CLIENT_ID");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = buildCommands().map((c) => c.toJSON());

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log("[Commands] Registered GUILD slash commands (instant)");
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log("[Commands] Registered GLOBAL slash commands");
  }
}

/* -------------------- handlers -------------------- */
function makeCommandHandlers(client) {
  const map = new Map();

  map.set("info", {
    execute: async (interaction) => {
      const uptime = Math.floor(process.uptime());
      const rooms = state.getRooms();
      await interaction.editReply(
        [
          "✅ **機器人狀態**",
          `- 上線時間：${uptime}s`,
          `- 目前房間狀態數：${rooms.length}`,
          "",
          "指令：/points /rank /guess /hl /counting",
        ].join("\n")
      );
    },
  });

  map.set("points", {
    execute: async (interaction) => {
      const u = interaction.options.getUser("user") || interaction.user;
      const p = await pointsDb.getPoints(u.id);
      await interaction.editReply(`💰 **${u.username}** 目前分數：**${p}**`);
    },
  });

  map.set("rank", {
    execute: async (interaction) => {
      // 需要 pointsDb.getLeaderboard
      const rows = (await pointsDb.getLeaderboard?.(20)) || [];
      if (!rows.length) return interaction.editReply("（目前沒有排行榜資料）");

      const lines = rows.map((r, i) => `#${i + 1}  <@${r.userId}>  —  **${r.points}**`);
      await interaction.editReply(["🏆 **排行榜 Top 20**", ...lines].join("\n"));
    },
  });

  map.set("guess", {
    execute: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      const gid = interaction.guildId;
      const cid = interaction.channelId;

      if (sub === "start") {
        const min = interaction.options.getInteger("min") ?? 1;
        const max = interaction.options.getInteger("max") ?? 100;
        if (min >= max) return interaction.editReply("❌ min 必須小於 max");

        state.guessStart(gid, cid, min, max);
        return interaction.editReply(`🎮 終極密碼開始！範圍 **${min} ~ ${max}**\n用 **/guess try n:數字** 來猜。`);
      }

      if (sub === "stop") {
        state.guessStop(gid, cid);
        return interaction.editReply("✅ 已停止終極密碼。");
      }

      if (sub === "try") {
        const n = interaction.options.getInteger("n");
        const r = state.guessTry(gid, cid, n);

        if (!r.ok && r.reason === "NOT_RUNNING") {
          return interaction.editReply("❌ 目前沒有終極密碼在跑，先用 **/guess start** 開始。");
        }

        if (r.hit) {
          // 猜中加分 +10（可改）
          const after = await pointsDb.addPoints(interaction.user.id, 10);
          return interaction.editReply(`🎉 猜中了！答案是 **${r.ans}**（+10 分）\n你目前分數：**${after}**`);
        }

        if (r.hint === "UP") {
          return interaction.editReply(`⬆️ 太小了！範圍變成 **${r.min} ~ ${r.max}**`);
        }
        return interaction.editReply(`⬇️ 太大了！範圍變成 **${r.min} ~ ${r.max}**`);
      }
    },
  });

  map.set("hl", {
    execute: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      const gid = interaction.guildId;
      const cid = interaction.channelId;

      if (sub === "start") {
        const r = state.hlStart(gid, cid);
        return interaction.editReply(`🃏 High/Low 開始！目前牌值：**${r.hl.current}**\n用 **/hl pick choice:high/low** 來猜。`);
      }

      if (sub === "stop") {
        state.hlStop(gid, cid);
        return interaction.editReply("✅ 已停止 High/Low。");
      }

      if (sub === "pick") {
        const choice = interaction.options.getString("choice");
        const r = state.hlPick(gid, cid, choice);

        if (!r.ok && r.reason === "NOT_RUNNING") {
          return interaction.editReply("❌ 目前沒有 High/Low 在跑，先用 **/hl start** 開始。");
        }

        if (r.win) {
          const after = await pointsDb.addPoints(interaction.user.id, 5);
          return interaction.editReply(
            `✅ 你猜對了！原本 **${r.cur}** → 下一張 **${r.next}**\n連勝：**${r.streak}**（+5 分）\n你目前分數：**${after}**`
          );
        } else {
          return interaction.editReply(`❌ 你猜錯了！原本 **${r.cur}** → 下一張 **${r.next}**\n連勝歸零。`);
        }
      }
    },
  });

  map.set("counting", {
    execute: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      const gid = interaction.guildId;
      const cid = interaction.channelId;

      if (sub === "start") {
        state.countingStart(gid, cid);
        return interaction.editReply("🔢 數字接龍開始！\n請在此頻道直接打：`1` `2` `3` ...（不能同一個人連續）");
      }

      if (sub === "stop") {
        state.countingStop(gid, cid);
        return interaction.editReply("✅ 已停止數字接龍。");
      }

      if (sub === "status") {
        const s = state.countingStatus(gid, cid);
        if (!s.on) return interaction.editReply("ℹ️ 目前此頻道沒有數字接龍。");
        return interaction.editReply(
          `ℹ️ 數字接龍狀態：\n- 最後數字：**${s.last}**\n- 最後玩家：${s.lastUserId ? `<@${s.lastUserId}>` : "（無）"}\n- 連續成功：**${s.streak}**`
        );
      }
    },
  });

  client.commands = map;
  return map;
}

module.exports = { registerCommands, makeCommandHandlers, buildCommands };