"use strict";

const { Collection, REST, Routes, SlashCommandBuilder } = require("discord.js");

/** ✅ 這裡放「指令處理器」(runtime 用) */
const commands = new Collection();

/** ========= /points ========= */
commands.set("points", {
  data: new SlashCommandBuilder()
    .setName("points")
    .setDescription("查看自己的積分"),
  async execute(interaction, ctx) {
    const userId = interaction.user.id;

    // 你的 points.js 是 getPoints / setPoints / addPoints
    const pointsDb = require("../db/points.js");
    const pts = await pointsDb.getPoints(userId);

    await interaction.editReply(`✅ 你的積分：${pts}`);
  },
});

/** ========= /rank ========= */
commands.set("rank", {
  data: new SlashCommandBuilder()
    .setName("rank")
    .setDescription("查看排行榜前幾名")
    .addIntegerOption((opt) =>
      opt.setName("top").setDescription("顯示前幾名（預設 10）").setMinValue(1).setMaxValue(50)
    ),
  async execute(interaction, ctx) {
    const top = interaction.options.getInteger("top") || 10;

    // 你目前 points.js 沒有 getLeaderboard，所以先用簡易版（讀全部 points）
    const { getDB } = require("../db/firebase");
    const db = getDB();
    const snap = await db.ref("points").get();
    const all = snap.val() || {};

    const rows = Object.entries(all)
      .map(([userId, points]) => ({ userId, points: Number(points || 0) }))
      .sort((a, b) => b.points - a.points)
      .slice(0, top);

    if (!rows.length) return interaction.editReply("目前沒有排行榜資料。");

    const lines = await Promise.all(
      rows.map(async (r, i) => {
        const u = await interaction.client.users.fetch(r.userId).catch(() => null);
        const name = u?.username || r.userId;
        return `${i + 1}. ${name} — ${r.points}`;
      })
    );

    await interaction.editReply(`🏆 排行榜 Top ${top}\n` + lines.join("\n"));
  },
});

/** ✅ 把 commands 塞到 client.commands，events.js 才找得到 */
function loadCommands(client) {
  client.commands = commands;
  console.log(`[Commands] Loaded ${commands.size} handlers into client.commands`);
}

/** ✅ 註冊 slash commands 到 Discord（你現在已經有做，但我給你穩定版） */
async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID; // ✅ 你要在 ENV 放 bot 的 Client ID
  const guildId = process.env.GUILD_ID;   // （可選）填了就「秒生效」，不填就是 global 可能等幾分鐘

  if (!token || !clientId) {
    console.warn("[Commands] ⚠️ 缺少 DISCORD_TOKEN 或 CLIENT_ID，略過註冊");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = [...commands.values()].map((c) => c.data.toJSON());

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log("[Commands] Registered GUILD slash commands");
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log("[Commands] Registered GLOBAL slash commands");
  }
}

module.exports = { loadCommands, registerCommands, commands };
