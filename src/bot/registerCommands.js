"use strict";

/**
 * src/bot/registerCommands.js
 * ✅ 只註冊「Guild」指令，避免 Global + Guild 重複出現
 * ✅ 用 client.token（避免 REST 沒 token）
 *
 * 需要 env:
 * - DISCORD_GUILD_ID
 */

const { REST, Routes } = require("discord.js");
const commands = require("./commands"); // exports.commandData

async function registerCommands(client) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    throw new Error("Missing env: DISCORD_GUILD_ID (只註冊 guild 指令需要它)");
  }

  if (!client?.application?.id) {
    throw new Error("client.application.id not ready (請在 ready 事件後呼叫 registerCommands)");
  }

  // ✅ token 來源：client.token（login 成功後會有）
  const token = client.token || process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("Missing Discord token (client.token / DISCORD_TOKEN)");
  }

  const rest = new REST({ version: "10" }).setToken(token);

  const body = Array.isArray(commands.commandData) ? commands.commandData : [];

  // 註冊到 guild（立即生效）
  await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), {
    body,
  });

  console.log("[Commands] Registered GUILD slash commands");
}

module.exports = { registerCommands };