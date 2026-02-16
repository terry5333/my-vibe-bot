"use strict";

/**
 * ✅ 只註冊 GUILD（避免指令兩份）
 * ✅ 可選清掉 GLOBAL（第一次跑建議 CLEAR_GLOBAL_COMMANDS=true）
 */

const { REST, Routes } = require("discord.js");
const adminCommands = require("./commands_admin");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function registerCommands() {
  const token = requireEnv("DISCORD_TOKEN");
  const clientId = requireEnv("DISCORD_CLIENT_ID");
  const guildId = requireEnv("DISCORD_GUILD_ID");

  const rest = new REST({ version: "10" }).setToken(token);
  const body = adminCommands.commandData;

  const clearGlobal = String(process.env.CLEAR_GLOBAL_COMMANDS || "").toLowerCase() === "true";
  if (clearGlobal) {
    try {
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      console.log("[Commands] Cleared GLOBAL slash commands");
    } catch (e) {
      console.warn("[Commands] Clear GLOBAL failed (ignore):", e?.message || e);
    }
  }

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  console.log("[Commands] Registered GUILD slash commands");
}

module.exports = { registerCommands };