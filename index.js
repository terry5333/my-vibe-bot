const { Client, GatewayIntentBits, ActivityType, REST, Routes } = require('discord.js');
const express = require('express');

// --- 網頁伺服器保持在線 ---
const app = express();
app.get('/', (req, res) => res.send('Counting Bot is Online! 🎮'));
app.listen(process.env.PORT || 3000);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- 遊戲狀態 ---
let isGameActive = false;
let currentCount = 0;
let lastUserId = null;

// --- 定義斜線指令 ---
const commands = [
  {
    name: 'counting',
    description: '開始一場 Counting 遊戲！',
  },
  {
    name: 'stop',
    description: '停止當前的遊戲',
  }
];

// --- 註冊斜線指令的函式 ---
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('正在註冊斜線指令...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID), // 需要新增 CLIENT_ID 環境變數
      { body: commands }
    );
    console.log('斜線指令註冊成功！');
  } catch (error) {
    console.error(error);
  }
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  registerCommands(); // 啟動時自動註冊
});

// --- 處理斜線指令回覆 ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'counting') {
    if (isGameActive) {
      return interaction.reply(`遊戲已經在進行中囉！目前的數字是：${currentCount}`);
    }
    isGameActive = true;
    currentCount = 0;
    lastUserId = null;
    await interaction.reply('🎮 **Counting 遊戲開始！** 請直接輸入 **1** 開始接力。');
  }

  if (interaction.commandName === 'stop') {
    isGameActive = false;
    await interaction.reply(`🛑 遊戲已手動停止。最後紀錄為：${currentCount}`);
  }
});

// --- 處理數字監聽 (這部分維持不變) ---
client.on('messageCreate', msg => {
  if (msg.author.bot || !isGameActive) return;

  const number = parseInt(msg.content);
  if (!isNaN(number) && /^\d+$/.test(msg.content)) {
    const nextCount = currentCount + 1;
    if (number === nextCount) {
      if (msg.author.id === lastUserId) {
        msg.react('❌');
        msg.reply(`❌ **失敗！** 不能連續數兩次。遊戲結束！`);
        isGameActive = false;
      } else {
        currentCount = nextCount;
        lastUserId = msg.author.id;
        msg.react('✅');
      }
    } else {
      msg.react('❌');
      msg.reply(`❌ **數錯了！** 應該是 ${nextCount}。遊戲結束！`);
      isGameActive = false;
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
