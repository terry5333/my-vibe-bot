"use strict";

/**
 * src/bot/events.js
 *
 * ✅ 目標：
 * 1) Slash 指令錯誤要印出 stack（不要只回「發生錯誤」）
 * 2) games / messageCreate 缺檔不會炸
 * 3) 支援不同 commands 結構（client.commands / commands.js）
 * 4) 避免 ephemeral deprecated warning → 用 flags
 */

const path = require("path");
const { MessageFlags } = require("discord.js");

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

/* -------------------- Helpers -------------------- */

function getCmdFromClient(client, name) {
  if (!client) return null;
  // 常見：client.commands 是 Collection
  if (client.commands?.get) return client.commands.get(name);
  // 有人會放成一般物件
  if (client.commands && typeof client.commands === "object") return client.commands[name];
  return null;
}

function getCmdFromModule(mod, name) {
  if (!mod) return null;

  // 1) mod.getCommand(name)
  if (typeof mod.getCommand === "function") return mod.getCommand(name);

  // 2) mod.commands 是 Collection/Map
  if (mod.commands?.get) return mod.commands.get(name);

  // 3) mod[name]
  if (mod[name]) return mod[name];

  // 4) mod.commands 是一般物件
  if (mod.commands && typeof mod.commands === "object") return mod.commands[name];

  return null;
}

async function safeReply(interaction, payload) {
  // payload 可以是 { content, flags } 或 string
  const data = typeof payload === "string" ? { content: payload } : payload;

  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(data);
    }
    return await interaction.reply(data);
  } catch (e) {
    console.error("❌ [Slash] safeReply failed:", e);
    return null;
  }
}

function logInteractionContext(interaction) {
  try {
    const guild = interaction.guild?.name || "DM/UnknownGuild";
    const gid = interaction.guildId || "N/A";
    const cid = interaction.channelId || "N/A";
    const user = interaction.user?.tag || interaction.user?.id || "N/A";
    console.error(
      `🧾 Context: guild=${guild}(${gid}) channel=${cid} user=${user} cmd=/${interaction.commandName}`
    );
  } catch {
    // ignore
  }
}

/* -------------------- Main binder -------------------- */

/**
 * ✅ 綁定 Discord 事件
 * @param {import("discord.js").Client} client
 * @param {object} webRuntime 你 web/server 回傳的 runtime（可為 null）
 */
function bindDiscordEvents(client, webRuntime) {
  // ---------- Slash 指令 ----------
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;

    try {
      // 1) client.commands
      let cmd = getCmdFromClient(client, name);

      // 2) commands.js module
      if (!cmd) cmd = getCmdFromModule(commandsMod, name);

      // cmd 可能長這樣：
      // - { execute(interaction, ctx) }
      // - function(interaction, ctx)
      const exec =
        typeof cmd === "function"
          ? cmd
          : cmd && typeof cmd.execute === "function"
          ? cmd.execute.bind(cmd)
          : null;

      if (!exec) {
        return safeReply(interaction, {
          content: `❌ 找不到指令處理器：/${name}\n（可能尚未註冊或 commands 載入失敗）`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // 避免 3 秒超時：先 defer（公開回覆）
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply(); // 不用 ephemeral，避免 deprecated
      }

      await exec(interaction, { client, webRuntime });
    } catch (err) {
      console.error(`❌ [Slash] /${name} Error:`, err);
      logInteractionContext(interaction);

      // 使用者看到的訊息（避免噴一堆 stack）
      await safeReply(interaction, "❌ 發生錯誤（已記錄到伺服器 log）");
    }
  });

  // ---------- 訊息事件（文字遊戲會用到） ----------
  client.on("messageCreate", async (message) => {
    try {
      if (!message || message.author?.bot) return;
      if (!message.guild) return; // 只處理 guild

      if (!gamesMod) return;

      // games.js 建議提供 onMessage / handleMessage
      if (typeof gamesMod.onMessage === "function") {
        await gamesMod.onMessage(message, { client, webRuntime });
      } else if (typeof gamesMod.handleMessage === "function") {
        await gamesMod.handleMessage(message, { client, webRuntime });
      }
    } catch (err) {
      console.error("❌ [Message] Error:", err);
    }
  });

  // ---------- Ready ----------
  client.once("ready", () => {
    console.log("[Discord] Ready:", client.user?.tag);
  });

  // ---------- 未處理錯誤全部印出來 ----------
  process.on("unhandledRejection", (reason) => {
    console.error("❌ unhandledRejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("❌ uncaughtException:", err);
  });
}

module.exports = { bindDiscordEvents };