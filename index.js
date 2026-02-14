const { 
    Client, GatewayIntentBits, ActivityType, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits 
} = require('discord.js');
const express = require('express');

// --- 1. Web Server (防止 Render 部署失敗) ---
const app = express();
const port = process.env.PORT || 8080; 
app.get('/', (req, res) => res.send('Vibe Bot is running on Render! 🚀'));
app.listen(port, () => console.log(`監聽端口: ${port}`));

// --- 2. 初始化 Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers 
    ]
});

// --- 3. 遊戲數據 ---
let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 }
};

// --- 4. 斜線指令定義 ---
const commands = [
    { name: 'vibe', description: '檢查機器人狀態' },
    { name: 'counting', description: '開始數數接力' },
    { name: 'guess', description: '開始終極密碼' },
    { 
        name: 'setup-role', 
        description: '發送身份組自助按鈕 (管理員用)',
        default_member_permissions: PermissionFlagsBits.Administrator.toString()
    },
    { name: 'stop', description: '停止所有遊戲' }
];

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 指令已同步至 Discord');
    } catch (e) { console.error(e); }
}

client.on('ready', () => {
    console.log(`🤖 機器人已上線：${client.user.tag}`);
    client.user.setActivity('在 Render 上 Vibe', { type: ActivityType.Streaming, url: 'https://www.twitch.tv/discord' });
    registerCommands();
});

// --- 5. 處理 Interaction (指令與按鈕) ---
client.on('interactionCreate', async interaction => {
    
    // A. 斜線指令
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'vibe') return await interaction.reply('⚡ 伺服器狀態：良好 | 平台：Render');

        if (commandName === 'setup-role') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('toggle_vibe_role')
                    .setLabel('領取/取消 Vibe Gamer 身份組')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🎮')
            );
            return await interaction.reply({ 
                content: '✨ **身份組自助領取中心**\n點擊下方按鈕獲取身份組，再次點擊即可移除取消。', 
                components: [row] 
            });
        }

        if (commandName === 'counting') {
            gameData.counting = { active: true, current: 0, lastUser: null };
            return await interaction.reply('🎮 **數數開始！** 請從 **1** 開始數。');
        }

        if (commandName === 'guess') {
            gameData.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
            return await interaction.reply('🎲 **終極密碼！** 範圍：**1 ~ 100**');
        }

        if (commandName === 'stop') {
            gameData.counting.active = false;
            gameData.guess.active = false;
            return await interaction.reply('🛑 所有遊戲狀態已重置。');
        }
    }

    // B. 按鈕點擊 (身份組自助切換邏輯)
    if (interaction.isButton()) {
        if (interaction.customId === 'toggle_vibe_role') {
            const roleName = 'Vibe Gamer'; // 請確保伺服器有這個名字的身份組
            const role = interaction.guild.roles.cache.find(r => r.name === roleName);

            if (!role) return await interaction.reply({ content: `❌ 錯誤：找不到身份組 "${roleName}"，請先建立它。`, ephemeral: true });

            try {
                // 自動切換：有則移除，無則新增
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: `👋 已成功**移除**你的 **${roleName}** 身份組。`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: `✅ 已成功**新增**你的 **${roleName}** 身份組！`, ephemeral: true });
                }
            } catch (err) {
                await interaction.reply({ content: '❌ 權限不足！請將機器人的身份組順序移至最上方。', ephemeral: true });
            }
        }
    }
});

// --- 6. 訊息遊戲處理 ---
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    // 數數遊戲邏輯
    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
                gameData.counting.current++;
                gameData.counting.lastUser = msg.author.id;
                await msg.react('✅');
            } else {
                await msg.reply(`❌ 數錯了或是連數！接力結束。最終數字：${gameData.counting.current}`);
                gameData.counting.active = false;
            }
        }
    }

    // 終極密碼邏輯
    if (gameData.guess.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            const { answer, min, max } = gameData.guess;
            if (num <= min || num >= max) return;
            if (num === answer) {
                await msg.reply(`🎊 恭喜！答案就是 **${answer}**`);
                gameData.guess.active = false;
            } else if (num < answer) {
                gameData.guess.min = num;
                await msg.reply(`📈 太小！新範圍：**${gameData.guess.min} ~ ${gameData.guess.max}**`);
            } else {
                gameData.guess.max = num;
                await msg.reply(`📉 太大！新範圍：**${gameData.guess.min} ~ ${gameData.guess.max}**`);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
