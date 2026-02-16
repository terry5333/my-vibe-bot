"use strict";

/**
 * src/bot/registerCommands.js
 * ✅ 只註冊一邊：有 DISCORD_GUILD_ID -> 註冊 GUILD（建議）
 * ✅ 可選清掉 GLOBAL 舊指令（避免「兩份一樣的指令」）
 */

const { REST, Routes } = require("discord.js");

const adminCommands = require("./commands_admin"); // 這裡拿 commandData

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function registerCommands() {
  const token = requireEnv("DISCORD_TOKEN");
  const clientId = requireEnv("DISCORD_CLIENT_ID");
  const guildId = process.env.DISCORD_GUILD_ID;

  const rest = new REST({ version: "10" }).setToken(token);

  const body = adminCommands.commandData; // array of toJSON()

  // ✅ 如果你以前註冊過 GLOBAL，Discord 會顯示兩份
  // 第一次跑建議開 CLEAR_GLOBAL_COMMANDS=true，把 GLOBAL 清掉
  const clearGlobal = String(process.env.CLEAR_GLOBAL_COMMANDS || "").toLowerCase() === "true";
  if (clearGlobal) {
    try {
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      console.log("[Commands] Cleared GLOBAL slash commands");
    } catch (e) {
      console.warn("[Commands] Clear GLOBAL failed (ignore if no perms):", e?.message || e);
    }
  }

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log("[Commands] Registered GUILD slash commands");
  } else {
    // 只有你真的想用 GLOBAL 才走這裡（不建議初期，會慢且容易兩份）
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log("[Commands] Registered GLOBAL slash commands");
  }
}

module.exports = { registerCommands };