"use strict";

/**
 * src/bot/registerCommands.js
 * 只註冊 GUILD 指令（更新快）
 * 可用 CLEAR_GLOBAL_COMMANDS=1 清空舊 GLOBAL 指令（避免同名出現兩份）
 */

const { REST, Routes } = require("discord.js");
const commands = require("./commands");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Application ID
const GUILD_ID = process.env.GUILD_ID;   // Guild ID
const CLEAR_GLOBAL_COMMANDS = process.env.CLEAR_GLOBAL_COMMANDS === "1";

async function registerCommands(client) {
  if (!DISCORD_TOKEN) throw new Error("Missing env: DISCORD_TOKEN");

  const appId = CLIENT_ID || client?.user?.id;
  if (!appId) throw new Error("Missing env: CLIENT_ID (or client.user.id not ready yet)");
  if (!GUILD_ID) throw new Error("Missing env: GUILD_ID");

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  // ✅ 跑一次就好：清空舊 GLOBAL，避免同名指令出現兩份
  if (CLEAR_GLOBAL_COMMANDS) {
    await rest.put(Routes.applicationCommands(appId), { body: [] });
    console.log("[Commands] Cleared GLOBAL slash commands");
  }

  // ✅ 只註冊 GUILD（更新秒生效）
  await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), {
    body: commands.commandData,
  });

  console.log("[Commands] Registered GUILD slash commands");
}

module.exports = { registerCommands };