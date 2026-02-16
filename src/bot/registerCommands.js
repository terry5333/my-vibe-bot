"use strict";

/**
 * src/bot/registerCommands.js
 * ✅ 預設只註冊 GUILD 指令（避免跟 GLOBAL 重複）
 * ✅ 可選擇一次性清掉 GLOBAL 指令（解決「同名兩份」）
 */

const { REST, Routes } = require("discord.js");
const commands = require("./commands");

async function registerCommands(client) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("Missing env: DISCORD_TOKEN");

  const guildId = process.env.DISCORD_GUILD_ID; // 建議一定要設
  const appId = client.application?.id || client.user.id;

  const rest = new REST({ version: "10" }).setToken(token);

  const body = commands.commandData; // commands.js 裡 export 的 commandData

  // ①（可選）清掉 GLOBAL，解決你「指令清單有兩個一樣的」
  // 只需要跑一次：CLEAR_GLOBAL_COMMANDS=1
  if (process.env.CLEAR_GLOBAL_COMMANDS === "1") {
    try {
      await rest.put(Routes.applicationCommands(appId), { body: [] });
      console.log("[Commands] Cleared GLOBAL commands");
    } catch (e) {
      console.error("[Commands] Clear GLOBAL failed:", e);
    }
  }

  // ② 註冊（優先 GUILD）
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    console.log("[Commands] Registered GUILD slash commands");
  } else {
    // 沒設 guildId 才走 global（但你會更容易出現重複、也比較慢生效）
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log("[Commands] Registered GLOBAL slash commands");
  }
}

module.exports = { registerCommands };