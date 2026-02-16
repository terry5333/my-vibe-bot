"use strict";

/**
 * src/bot/registerCommands.js
 * 需要環境變數：
 * - DISCORD_TOKEN (Bot token)
 * - DISCORD_CLIENT_ID (Application ID)
 *
 * 可選：
 * - DISCORD_GUILD_ID (如果你要用 guild 指令，立刻生效)
 */

const { REST, Routes } = require("discord.js");

async function registerCommands(commandData) {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID; // 可選（建議你先用 guild 立刻生效）

  if (!token) throw new Error("Missing env DISCORD_TOKEN");
  if (!clientId) throw new Error("Missing env DISCORD_CLIENT_ID");

  const rest = new REST({ version: "10" }).setToken(token);

  // ✅ 建議：有填 DISCORD_GUILD_ID 就走 guild（秒更新）
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commandData,
    });
    console.log("[Commands] Registered GUILD slash commands");
    return;
  }

  // 沒填 guildId 才註冊 global（會有快取延遲）
  await rest.put(Routes.applicationCommands(clientId), { body: commandData });
  console.log("[Commands] Registered GLOBAL slash commands");
}

module.exports = { registerCommands };