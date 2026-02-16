"use strict";

/**
 * src/bot/registerCommands.js
 * - 只註冊 GUILD 指令
 * - 啟動時清掉 GLOBAL 指令 → 修「指令重複」
 */

const { REST, Routes } = require("discord.js");
const commands = require("./commands");

async function registerCommands(client) {
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.GUILD_ID;

  if (!token) throw new Error("Missing env: DISCORD_TOKEN");
  if (!guildId) throw new Error("Missing env: GUILD_ID（要用 guild 註冊才能避免指令重複）");

  const rest = new REST({ version: "10" }).setToken(token);

  const appId = client.user.id;

  // 1) 清掉 GLOBAL 指令（避免你看到兩份）
  try {
    await rest.put(Routes.applicationCommands(appId), { body: [] });
    console.log("[Commands] Cleared GLOBAL slash commands");
  } catch (e) {
    console.warn("[Commands] Clear GLOBAL failed (can ignore if no global):", e?.message || e);
  }

  // 2) 註冊 GUILD 指令
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: commands.commandData,
  });

  console.log("[Commands] Registered GUILD slash commands");
}

module.exports = { registerCommands };