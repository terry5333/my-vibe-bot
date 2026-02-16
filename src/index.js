"use strict";

/**
 * src/index.js
 * - 統一處理 interaction：先 ephemeral defer，執行後 deleteReply()，避免聊天室多一段回覆
 * - 只留一個 interactionCreate handler，避免 40060
 * - counting/guess 用 messageCreate
 */

const { Client, GatewayIntentBits, Partials, MessageFlags } = require("discord.js");

const { registerCommands } = require("./bot/registerCommands");
const commands = require("./bot/commands");
const gamesMod = require("./bot/games");

// ---- Firebase init（避免 initFirebase is not a function）----
function safeInitFirebase() {
  try {
    const fb = require("./db/firebase");
    if (typeof fb === "function") return fb();
    if (fb && typeof fb.initFirebase === "function") return fb.initFirebase();
    // 其他情況：忽略
  } catch (_) {
    // 沒有 firebase 模組就忽略
  }
}

// ---- env ----
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ Missing env: DISCORD_TOKEN");
  process.exit(1);
}

// ---- client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // counting/guess 需要讀訊息
  ],
  partials: [Partials.Channel],
});

// ---- bootstrap ----
safeInitFirebase();

client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  // 註冊指令：只註冊 GUILD，並清掉 GLOBAL，避免指令重複
  try {
    await registerCommands(client);
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ 唯一 interactionCreate handler（避免重複回覆）
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // 先 defer（ephemeral），避免 3 秒超時 Unknown interaction 10062
  // 用 flags 避免 ephemeral deprecated 警告
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    // defer 失敗就不要硬回覆，讓下面走 try/catch
  }

  try {
    // 執行指令（commands 內不要再 interaction.reply）
    const result = await commands.execute(interaction, { client });

    // 預設：把 ephemeral 回覆刪掉 → 使用者不會看到「已公開/已回覆」之類多餘訊息
    // 若你未來想保留某些指令的私密回覆，可讓 commands.execute 回傳 { keepReply: true }
    const keepReply = Boolean(result && result.keepReply);
    if (!keepReply) {
      try {
        // 只有 defer/replied 才能 delete
        if (interaction.deferred || interaction.replied) {
          await interaction.deleteReply();
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error("[interactionCreate] error:", err);

    // 出錯也不要在頻道噴一堆訊息：只用 ephemeral 提示（或直接刪掉）
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ 指令執行出錯，請稍後再試。");
        // 2 秒後刪掉，避免留下訊息
        setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
      } else {
        await interaction.reply({
          content: "❌ 指令執行出錯，請稍後再試。",
          flags: MessageFlags.Ephemeral,
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
      }
    } catch (_) {}
  }
});

// counting / guess：直接在頻道輸入數字
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    if (typeof gamesMod?.onMessage === "function") {
      await gamesMod.onMessage(message, { client });
    }
  } catch (err) {
    console.error("[messageCreate] error:", err);
  }
});

client.login(DISCORD_TOKEN);