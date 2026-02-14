const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.on('messageCreate', m => {
  if (m.content === '!vibe') m.reply('✨ Vibe Check: Passed! 🚀');
});

// Render 需要一個 Port 監聽，不然會判定部署失敗
http.createServer((req, res) => res.end('Vibe Bot is Online!')).listen(process.env.PORT || 3000);

client.login(process.env.DISCORD_TOKEN);
