"use strict";

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

function buildCommands() {
  const cmds = [];

  cmds.push(
    new SlashCommandBuilder()
      .setName("rank")
      .setDescription("查看排行榜（秒回）")
  );

  cmds.push(
    new SlashCommandBuilder()
      .setName("points")
      .setDescription("查看自己的積分")
  );

  cmds.push(
    new SlashCommandBuilder()
      .setName("guess")
      .setDescription("開始終極密碼（此頻道）")
      .addIntegerOption((o) => o.setName("min").setDescription("最小值").setRequired(true))
      .addIntegerOption((o) => o.setName("max").setDescription("最大值").setRequired(true))
  );

  cmds.push(
    new SlashCommandBuilder()
      .setName("hl")
      .setDescription("開始高低牌（你自己一局）")
  );

  cmds.push(
    new SlashCommandBuilder()
      .setName("counting")
      .setDescription("開始Counting（此頻道）")
  );

  cmds.push(
    new SlashCommandBuilder()
      .setName("stop")
      .setDescription("強制停止此頻道的遊戲（需要管理權限）")
  );

  return cmds.map((c) => c.toJSON());
}

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.log("⚠️ 跳過註冊指令（缺 DISCORD_TOKEN / CLIENT_ID）");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = buildCommands();

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      console.log("[Commands] Registered GUILD slash commands");
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body });
      console.log("[Commands] Registered GLOBAL slash commands");
    }
  } catch (e) {
    console.error("❌ Register commands failed:", e);
  }
}

module.exports = { registerCommands };
