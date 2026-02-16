"use strict";

/**
 * src/bot/registerCommands.js
 * - 只註冊 GUILD 指令（更新快）
 * - NUKE_COMMANDS=1：清空 GLOBAL + GUILD，再重建 GUILD（用來解決「兩個一樣指令」）
 */

const { REST, Routes } = require("discord.js");
const commands = require("./commands");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Application ID
const GUILD_ID = process.env.GUILD_ID;   // Guild ID
const NUKE_COMMANDS = process.env.NUKE_COMMANDS === "1";

async function registerCommands(client) {
  if (!DISCORD_TOKEN) throw new Error("Missing env: DISCORD_TOKEN");
  if (!GUILD_ID) throw new Error("Missing env: GUILD_ID");

  // ✅ 最穩：用 CLIENT_ID；沒有的話就抓 application.id
  let appId = CLIENT_ID;
  if (!appId) {
    try {
      if (!client.application) await client.application?.fetch?.();
      appId = client.application?.id || client.user?.id;
    } catch (_) {
      appId = client.user?.id;
    }
  }
  if (!appId) throw new Error("Missing env: CLIENT_ID (or unable to resolve application id)");

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  // ✅ 核彈模式：一次清乾淨 GLOBAL + GUILD
  if (NUKE_COMMANDS) {
    await rest.put(Routes.applicationCommands(appId), { body: [] });
    console.log("[Commands] Cleared GLOBAL slash commands");

    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: [] });
    console.log("[Commands] Cleared GUILD slash commands");
  }

  // ✅ 只註冊 GUILD（不碰 GLOBAL）
  await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), {
    body: commands.commandData,
  });

  console.log("[Commands] Registered GUILD slash commands");
}

module.exports = { registerCommands };