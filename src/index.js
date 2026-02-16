"use strict";

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");

const { commandData, makeCommandHandlers } = require("./bot/commands");
const { registerCommands } = require("./bot/registerCommands");
const gamesMod = require("./bot/games");

// 如果你有 firebase init 就留著，沒有就刪掉這兩行
const firebase = require("./db/firebase");

async function safeEdit(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch (e) {
    // 吞掉避免把 bot 弄掛（尤其是 10062/40060）
  }
}

async function main() {
  // Firebase（可選）
  try {
    if (firebase?.init) await firebase.init();
    console.log("[Firebase] Initialized");
  } catch (e) {
    console.log("[Firebase] init skipped:", e?.message || e);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  // 避免 Unhandled error 把程序炸掉
  process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
  process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
  client.on("error", (err) => console.error("[client error]", err));

  const handlers = makeCommandHandlers({ client });

  client.once(Events.ClientReady, async () => {
    console.log(`[Discord] Logged in as ${client.user.tag}`);

    try {
      await registerCommands(commandData);
      console.log("[Commands] registered");
    } catch (e) {
      console.error("[Commands] register failed:", e);
    }
  });

  // ✅ 只保留一個 InteractionCreate
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ✅ 先 ack，避免 3 秒超時 → Unknown interaction(10062)
    // 這裡用 public defer（ephemeral=false），才不會全部都變成私訊效果
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: false });
      }
    } catch (e) {
      // defer 失敗就算了，後面會走 safeEdit
    }

    const fn = handlers[interaction.commandName];
    if (!fn) {
      await safeEdit(interaction, { content: "❌ 這個指令沒有處理器。" });
      return;
    }

    try {
      await fn(interaction);
    } catch (err) {
      console.error("[interactionCreate] error:", err);
      // ✅ 這裡只 editReply，不會再 reply → 避免 40060
      await safeEdit(interaction, { content: "❌ 指令執行出錯，請稍後再試。" });
    }
  });

  client.on(Events.MessageCreate, async (msg) => {
    try {
      await gamesMod?.onMessage?.(msg);
    } catch (e) {
      console.error("[messageCreate] error:", e);
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});