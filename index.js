const { Client, GatewayIntentBits, ActivityType, REST, Routes } = require('discord.js');
const express = require('express');

// --- 1. 建立 Web Server 保持在線 ---
const app = express();
app.get('/', (req, res) => res.send('Vibe Bot is Online! 🚀'));
app.listen(process.env.PORT || 3000, () => console.log('Keep-alive server is running.'));

// --- 2. 初始化 Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// --- 3. 遊戲狀態變數 ---
// Counting 遊戲
let isCountingActive = false;
let currentCount = 0;
let lastCountUserId = null;

// 終極密碼遊戲
let isGuessActive = false;
let secretAnswer = 0;
let minRange = 1;
let maxRange = 100;

// --- 4. 定義斜線指令 ---
const commands = [
  {
    name: 'counting',
    description: '開始一場 Counting 遊戲'
  },
  {
    name: 'guess',
    description: '開始一場終極密碼遊戲 (1-100)'
  },
  {
    name: 'stop',
    description: '停止所有正在進行的遊戲'
  },
  {
    name: 'vibe',
    description: '檢查機器人的 Vibe 狀態'
  }
];

// --- 5. 註冊斜線指令 ---
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('正在刷新應用程式斜線指令...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('成功註冊斜線指令！');
  } catch (error) {
    console.error('註冊指令時出錯:', error);
  }
}

client.on('ready', () => {
  console.log(`已成功登入為 ${client.user.tag}!`);
  client.user.setActivity('大家玩遊戲', { type: ActivityType.Watching });
  registerCommands();
});

// --- 6. 處理斜線指令 (Interactions) ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'vibe') {
    await interaction.reply('✨ Vibe 狀態：極佳！目前的遊戲伺服器運行正常。');
  }

  if (commandName === 'counting') {
    if (isCountingActive) return interaction.reply(`Counting 遊戲已在進行中，目前數字：${currentCount}`);
    isCountingActive = true;
    isGuessActive = false; // 避免遊戲衝突
    currentCount = 0;
    lastCountUserId = null;
    await interaction.reply('🎮 **Counting 遊戲開始！** 請從 **1** 開始數數...');
  }

  if (commandName === 'guess') {
    if (isGuessActive) return interaction.reply(`終極密碼已在進行中，目前範圍：${minRange} ~ ${maxRange}`);
    isGuessActive = true;
    isCountingActive = false; // 避免遊戲衝突
    secretAnswer = Math.floor(Math.random() * 100) + 1;
    minRange = 1;
    maxRange = 100;
    await interaction.reply(`🎲 **終極密碼開始！** 數字範圍：**1 ~ 100**。請直接輸入數字！`);
  }

  if (commandName === 'stop') {
    isCountingActive = false;
    isGuessActive = false;
    await interaction.reply('🛑 所有遊戲已停止。');
  }
});

// --- 7. 處理文字訊息監聽 (Game Logic) ---
client.on('messageCreate', msg => {
  if (msg.author.bot) return;

  // --- Counting 邏輯 ---
  if (isCountingActive) {
    const num = parseInt(msg.content);
    if (!isNaN(num) && /^\d+$/.test(msg.content)) {
      const nextCount = currentCount + 1;
      if (num === nextCount) {
        if (msg.author.id === lastCountUserId) {
          msg.react('❌');
          msg.reply('❌ 不能連續數兩次！遊戲結束。');
          isCountingActive = false;
        } else {
          currentCount = nextCount;
          lastCountUserId = msg.author.id;
          msg.react('✅');
        }
      } else {
        msg.react('❌');
        msg.reply(`❌ 數錯了！應該是 ${nextCount}。遊戲重置。`);
        isCountingActive = false;
      }
    }
  }

  // --- 終極密碼邏輯 ---
  if (isGuessActive) {
    const guess = parseInt(msg.content);
    if (!isNaN(guess) && /^\d+$/.test(msg.content)) {
      if (guess === secretAnswer) {
        msg.react('🎊');
        msg.reply(`🎊 恭喜 ${msg.author} 猜中了！答案就是 **${secretAnswer}**。`);
        isGuessActive = false;
      } else if (guess > minRange && guess < secretAnswer) {
        minRange = guess;
        msg.reply(`📈 太小了！範圍變為：**${minRange} ~ ${maxRange}**`);
      } else if (guess < maxRange && guess > secretAnswer) {
        maxRange = guess;
        msg.reply(`📉 太大了！範圍變為：**${minRange} ~ ${maxRange}**`);
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
