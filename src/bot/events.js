"use strict";

/**
 * src/bot/events.js
 *
 * ✅ 目標：
 * 1) 所有 Slash 指令不要再只回「發生錯誤」而看不到原因 → 一定印出 stack
 * 2) 文字遊戲/訊息事件（messageCreate）不會因為缺檔就整個炸 → safeRequire
 * 3) 不強迫你一定要照我的檔案結構：找不到模組就跳過，但會 console.warn
 */

const path = require("path");

/* -------------------- Safe require（避免缺檔直接炸掉） -------------------- */
function safeRequire(p) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(p);
  } catch (e) {
    console.warn(`[Bot] ⚠️ 找不到模組：${p}（已跳過該功能）`);
    return null;
  }
}

/**
 * 你專案若路徑不同，改這裡：
 * - commands: Slash commands collection / handler
 * - games: 文字遊戲（終極密碼/接龍/數字接龍等）
 */
const commandsMod = safeRequire(path.join(__dirname, "./commands.js"));
const gamesMod = safeRequire(path.join(__dirname, "./games.js"));

/**
 * ✅ 綁定 Discord 事件
 * @param {import("discord.js").Client} client
 * @param {object} webRuntime 你 web/server 回傳的 runtime（可為 null）
 */
function bindDiscordEvents(client, webRuntime) {
  // ---------- Slash 指令 ----------
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      // 1) 嘗試從 client.commands（最常見）取
      let cmd =
        client.commands?.get?.(interaction.commandName) ||
        client.commands?.[interaction.commandName];

      // 2) 如果你是把 commands 放在 commands.js 裡
      if (!cmd && commandsMod) {
        // 支援：commandsMod.getCommand(name) 或 commandsMod.commands(Map)
        if (typeof commandsMod.getCommand === "function") {
          cmd = commandsMod.getCommand(interaction.commandName);
        } else if (commandsMod.commands?.get) {
          cmd = commandsMod.commands.get(interaction.commandName);
        } else if (commandsMod[interaction.commandName]) {
          cmd = commandsMod[interaction.commandName];
        }
      }

      if (!cmd || typeof cmd.execute !== "function") {
        return interaction.reply({
          content: `❌ 找不到指令處理器：/${interaction.commandName}\n（可能尚未註冊或 commands 載入失敗）`,
          ephemeral: true,
        });
      }

      // 避免 Discord 3 秒超時：先 defer
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: false });
      }

      // 統一把 runtime 傳進去（你想用就用，不想用可忽略）
      await cmd.execute(interaction, { client, webRuntime });
    } catch (err) {
      // ✅ 這行是關鍵：把真正錯誤印出來（你才知道到底哪裡炸）
      console.error(`❌ [Slash] /${interaction.commandName} Error:`, err);

      // 回覆使用者（避免 bot 直接掛）
      const msg = "❌ 發生錯誤（已記錄到伺服器 log）";
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(msg);
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      } catch (e2) {
        console.error("❌ [Slash] 回覆錯誤訊息也失敗：", e2);
      }
    }
  });

  // ---------- 訊息事件（文字遊戲會用到） ----------
  client.on("messageCreate", async (message) => {
    try {
      // 忽略 bot 自己/其他 bot
      if (!message || message.author?.bot) return;

      // 只在 guild 訊息處理（你想支援 DM 可移除）
      if (!message.guild) return;

      // 如果你沒有 games.js 就跳過
      if (!gamesMod) return;

      /**
       * games.js 建議提供：
       * - onMessage(message, { client, webRuntime })
       * 或
       * - handleMessage(message, { client, webRuntime })
       */
      if (typeof gamesMod.onMessage === "function") {
        await gamesMod.onMessage(message, { client, webRuntime });
      } else if (typeof gamesMod.handleMessage === "function") {
        await gamesMod.handleMessage(message, { client, webRuntime });
      }
    } catch (err) {
      // 不要讓 messageCreate 的錯誤把整個 bot 搞掛
      console.error("❌ [Message] Error:", err);
    }
  });

  // ---------- Ready ----------
  client.once("ready", () => {
    console.log("[Discord] Ready:", client.user?.tag);
  });

  // ---------- 其他：把未處理錯誤都印出來 ----------
  process.on("unhandledRejection", (reason) => {
    console.error("❌ unhandledRejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("❌ uncaughtException:", err);
  });
}

module.exports = { bindDiscordEvents };
