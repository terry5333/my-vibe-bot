"use strict";

/**
 * src/bot/registerCommands.js
 * - 只註冊 GUILD commands（立即生效）
 * - 同時清掉 GLOBAL commands（避免出現兩套同名指令）
 *
 * env:
 *   DISCORD_TOKEN
 *   DISCORD_CLIENT_ID  (Application ID)
 *   DISCORD_GUILD_ID
 */

const { REST, Routes } = require("discord.js");
const { commandData } = require("./commands");

async function registerCommands(client) {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token) throw new Error("Missing env: DISCORD_TOKEN");
  if (!clientId) throw new Error("Missing env: DISCORD_CLIENT_ID");
  if (!guildId) throw new Error("Missing env: DISCORD_GUILD_ID");

  const rest = new REST({ version: "10" }).setToken(token);

  // 1) 清掉 GLOBAL commands，避免「兩個一樣的指令」
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log("[Commands] Cleared GLOBAL slash commands");
  } catch (err) {
    console.warn("[Commands] Clear GLOBAL failed (can ignore if none):", err?.message || err);
  }

  // 2) 註冊 GUILD commands（立即生效）
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commandData,
  });

  console.log("[Commands] Registered GUILD slash commands");
  return true;
}

module.exports = { registerCommands };