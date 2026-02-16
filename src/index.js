"use strict";

const { Client, GatewayIntentBits, Partials } = require("discord.js");

// 你的 Firebase 初始化（如果你原本有）
let firebaseInit = null;
try {
  firebaseInit = require("./db/firebase"); // 你如果沒有這個檔，這行可以刪掉
} catch (e) {
  // 不強制
}

// ✅ 你缺的：指令註冊器
const { registerCommands } = require("./bot/registerCommands");

// ✅ 你的指令處理器（你現在錯就是因為這個沒 export 或路徑不對）
const { makeCommandHandlers } = require("./bot/commands");

// ✅ 你的 Web 後台（如果你原本有）
let startWeb = null;
try {
  ({ startWeb } = require("./web/admin"));
} catch (e) {
  // 沒有也沒關係
}

async function main() {
  const {
    DISCORD_TOKEN,
    DISCORD_CLIENT_ID,
  } = process.env;

  if (!DISCORD_TOKEN) {
    console.error("❌ 缺少 ENV：DISCORD_TOKEN");
    process.exit(1);
  }
  if (!DISCORD_CLIENT_ID) {
    console.error("❌ 缺少 ENV：DISCORD_CLIENT_ID");
    process.exit(1);
  }

  // Firebase 初始化（如果你原本有用）
  if (firebaseInit && typeof firebaseInit.init === "function") {
    await firebaseInit.init();
    console.log("[Firebase] Initialized");
  }

  // ✅ Discord Client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  // ✅ 先把 handler 建好（避免找不到）
  if (typeof makeCommandHandlers !== "function") {
    console.error("❌ Fatal: makeCommandHandlers is not a function（請確認 src/bot/commands.js 有 export）");
    process.exit(1);
  }
  const handlers = makeCommandHandlers({ client });

  client.once("ready", async () => {
    console.log(`[Discord] Logged in as ${client.user?.tag}`);

    // ✅ 註冊全域 slash commands
    try {
      await registerCommands({
        clientId: DISCORD_CLIENT_ID,
        token: DISCORD_TOKEN,
      });
      console.log("[Commands] Registered GLOBAL slash commands");
    } catch (e) {
      console.error("❌ Register commands failed:", e);
    }

    // ✅ Web 後台
    try {
      if (typeof startWeb === "function") {
        startWeb();
      }
    } catch (e) {
      console.error("❌ Start web failed:", e);
    }
  });

  // ✅ Slash 指令事件
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;

      const name = interaction.commandName;
      const fn = handlers?.[name];

      if (!fn) {
        // 不要讓它直接噴錯，只回應「還沒接上」
        return interaction.reply({
          content: `⚠️ 這個指令目前還沒接上處理器：/${name}`,
          ephemeral: true,
        });
      }

      await fn(interaction);
    } catch (e) {
      console.error("[interactionCreate] error:", e);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: "❌ 發生錯誤", ephemeral: true });
        } else {
          await interaction.reply({ content: "❌ 發生錯誤", ephemeral: true });
        }
      } catch {}
    }
  });

  await client.login(DISCORD_TOKEN);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});