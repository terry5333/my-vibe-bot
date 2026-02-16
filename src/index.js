"use strict";

/**
 * src/index.js
 * - ✅ 只留一個 interactionCreate handler（避免 40060 重複回覆）
 * - ✅ ChatInputCommand：先 ephemeral defer，指令用 channel.send() 發在頻道，最後 deleteReply()
 * - ✅ Button（HL）：交給 gamesMod.onInteraction 處理（不做 deferReply）
 * - ✅ messageCreate：counting/guess 讀頻道數字
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
  } catch (_) {}
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

  try {
    await registerCommands(client);
    console.log("[Commands] registered");
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }
});

// ✅ 唯一 interactionCreate handler
client.on("interactionCreate", async (interaction) => {
  try {
    // 1) 先處理「按鈕」（HL）
    if (interaction.isButton()) {
      if (typeof gamesMod?.onInteraction === "function") {
        await gamesMod.onInteraction(interaction, { client });
      }
      return; // 按鈕就到此結束
    }

    // 2) 只處理 Slash 指令
    if (!interaction.isChatInputCommand()) return;

    // 先 defer（ephemeral）避免超時 Unknown interaction 10062
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // 執行指令（commands.js 內會用 channel.send() 真正發到頻道）
    const result = await commands.execute(interaction, { client });

    // 預設刪掉 ephemeral 回覆，避免使用者看到多餘「已回覆/已公開」提示
    const keepReply = Boolean(result && result.keepReply);
    if (!keepReply) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.deleteReply();
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error("[interactionCreate] error:", err);

    // 出錯時：短暫 ephemeral 提示後刪掉
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ 指令執行出錯，請稍後再試。");
        setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
      } else if (interaction.isRepliable?.()) {
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