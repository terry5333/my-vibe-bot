"use strict";

const { REST, Routes } = require("discord.js");

// ✅ 這裡「不要依賴 builders 版本」，直接用 JSON 指令
function getCommandsJSON() {
  return [
    { name: "points", description: "查看分數" },
    { name: "rank", description: "查看排行榜" },

    // 你列的指令（先讓它存在，之後再接遊戲邏輯）
    { name: "counting", description: "數字接龍" },
    { name: "hl", description: "High/Low" },
    { name: "guess", description: "終極密碼" },
    { name: "info", description: "查看資訊" },
  ];
}

async function registerCommands({ clientId, token }) {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = getCommandsJSON();

  await rest.put(Routes.applicationCommands(clientId), { body });
  console.log("[Commands] registered");
}

module.exports = { registerCommands };