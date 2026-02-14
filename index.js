const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.send('Counting Bot is Online! 🎮'));
app.listen(process.env.PORT || 3000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// --- 遊戲狀態變數 ---
let isGameActive = false; // 預設遊戲是關閉的
let currentCount = 0;
let lastUserId = null;

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', msg => {
  if (msg.author.bot) return;

  // 1. 啟動指令：!counting
  if (msg.content === '!counting') {
    if (isGameActive) {
      msg.reply('遊戲已經在進行中囉！目前的數字是：' + currentCount);
    } else {
      isGameActive = true;
      currentCount = 0;
      lastUserId = null;
      msg.reply('🎮 **Counting 遊戲開始！** 請從 **1** 開始數。 (數錯或連數兩次就會結束哦！)');
    }
    return; // 執行完啟動指令就結束這次監聽
  }

  // 2. 停止指令：!stop (選配，想停的時候可以用)
  if (msg.content === '!stop' && isGameActive) {
    isGameActive = false;
    msg.reply(`🛑 遊戲已手動停止。最後紀錄為：${currentCount}`);
    return;
  }

  // 3. Counting 遊戲邏輯 (只有在 isGameActive 為 true 時才執行)
  if (isGameActive) {
    const number = parseInt(msg.content);

    // 檢查訊息是否為純數字且不含空格
    if (!isNaN(number) && /^\d+$/.test(msg.content)) {
      const nextCount = currentCount + 1;

      if (number === nextCount) {
        // 檢查是否連續數兩次
        if (msg.author.id === lastUserId) {
          msg.react('❌');
          msg.reply(`❌ **失敗！** 不能連續數兩次。遊戲結束，輸入 \`!counting\` 重新開始。`);
          isGameActive = false;
        } else {
          // 成功接力
          currentCount = nextCount;
          lastUserId = msg.author.id;
          msg.react('✅');
        }
      } else {
        // 數錯了
        msg.react('❌');
        msg.reply(`❌ **數錯了！** 應該是 ${nextCount}。遊戲結束，紀錄為 ${currentCount}。輸入 \`!counting\` 重新開始。`);
        isGameActive = false;
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
