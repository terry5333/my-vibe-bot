"use strict";

const { REST, Routes } = require("discord.js");
const commands = require("./commands"); // exports.commandData

async function registerCommands(client) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("Missing env: DISCORD_GUILD_ID");

  const appId = client?.application?.id;
  if (!appId) throw new Error("client.application.id not ready");

  const token = client.token || process.env.DISCORD_TOKEN;
  if (!token) throw new Error("Missing Discord token");

  const rest = new REST({ version: "10" }).setToken(token);
  const body = Array.isArray(commands.commandData) ? commands.commandData : [];

  // ✅ 1) 清掉「GLOBAL」指令（避免和 GUILD 重複）
  await rest.put(Routes.applicationCommands(appId), { body: [] });
  console.log("[Commands] Cleared GLOBAL slash commands");

  // ✅ 2) 註冊「GUILD」指令（立即生效）
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
  console.log("[Commands] Registered GUILD slash commands");
}

module.exports = { registerCommands };