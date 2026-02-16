"use strict";

const state = require("./state");

function bindDiscordEvents(client) {
  // Slash 指令處理
    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;
    const cmd = client.commands?.get?.(name);

    try {
      if (!cmd) {
        return interaction.reply({
          content: `❌ 找不到指令處理器：/${name}`,
          ephemeral: true,
        });
      }

      // 先 defer 避免 3 秒超時（你之前說回覆慢，就是這個）
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: false });
      }

      await cmd.execute(interaction);
    } catch (err) {
      console.error(`❌ [Slash] /${name} Error:`, err);

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

  // counting 用 messageCreate（數字接龍是訊息最好玩）
  client.on("messageCreate", async (message) => {
    try {
      if (!message || message.author?.bot) return;
      if (!message.guildId) return;

      // 如果這個頻道正在 counting，就把純數字當作輸入
      const content = String(message.content || "").trim();
      if (!content) return;

      const st = state.countingStatus(message.guildId, message.channelId);
      if (!st.on) return;

      const result = state.countingFeedMessage({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        content,
      });

      if (result.ok) {
        // 成功就不用一直回，避免洗版（可自行改成每 10 次回一次）
        return;
      }

      if (result.reason === "SAME_USER") {
        await message.reply("❌ 不可以連續同一個人！已重置，從 **1** 開始。");
      } else if (result.reason === "WRONG_NUMBER") {
        await message.reply(`❌ 數字錯了！應該要是 **${result.want}**。已重置，從 **1** 開始。`);
      }
    } catch (err) {
      console.error("❌ [Message] Error:", err);
    }
  });

  client.once("ready", () => {
    console.log("[Discord] Ready:", client.user?.tag);
  });

  process.on("unhandledRejection", (reason) => console.error("❌ unhandledRejection:", reason));
  process.on("uncaughtException", (err) => console.error("❌ uncaughtException:", err));
}

module.exports = { bindDiscordEvents };