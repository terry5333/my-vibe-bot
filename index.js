const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const express = require('express');

// 1. 建立伺服器 (讓 Render 覺得你有在工作)
const app = express();
app.get('/', (req, res) => res.send('Vibe Bot is Online! ✨'));
app.listen(process.env.PORT || 3000);

// 2. 機器人本體
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  client.user.setActivity('保持 Vibe 能量...', { type: ActivityType.Watching });
});

client.on('messageCreate', msg => {
  if (msg.author.bot) return;
  if (msg.content === '!vibe') {
    msg.reply('🌊 正在為你充電... ⚡ 目前運行於 Render 雲端，Vibe 穩定！');
  }
});

client.login(process.env.DISCORD_TOKEN);
