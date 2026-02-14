const { 
    Client, GatewayIntentBits, ActivityType, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits 
} = require('discord.js');
const express = require('express');

// --- 1. Web Server (Render 存活檢查) ---
const app = express();
const port = process.env.PORT || 8080; 
app.get('/', (req, res) => res.send('Vibe Bot is Online! 🚀'));
app.listen(port, () => console.log(`監聽端口: ${port}`));

// --- 2. 檢查環境變數 (避免 TokenInvalid 錯誤) ---
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    console.error('❌ 錯誤：找不到 DISCORD_TOKEN 或 CLIENT_ID 環境變數！');
    console.error('請檢查 Render 的 Environment 設定。');
    process.exit(1); 
}

// --- 3. 初始化 Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers 
    ]
});

// --- 4. 遊戲狀態 ---
let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 }
};

// --- 5. 斜線指令 ---
const commands = [
    { name: 'vibe', description: '檢查狀態' },
    { name: 'counting', description: '開始數數' },
    { name: 'guess', description: '開始終極密碼' },
    { 
        name: 'setup-role', 
        description: '發送自助身份組按鈕',
        default_member_permissions: PermissionFlagsBits.Administrator.toString()
    },
    { name: 'stop', description: '重置遊戲' }
];

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 指令同步成功');
    } catch (e) { console.error('❌ 指令註冊失敗:', e); }
}

client.on('ready', () => {
    console.log(`🤖 機器人已上線：${client.user.tag}`);
    registerCommands();
});

// --- 6. 處理互動 ---
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'vibe') return await interaction.reply('⚡ Vibe Check: 100%');

        if (commandName === 'setup-role') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('toggle_vibe_role')
                    .setLabel('領取/取消 Vibe Gamer 身份組')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🎮')
            );
            return await interaction.reply({ 
                content: '✨ **自助身份組管理**\n點擊按鈕獲取身份組，再次點擊即可取消。', 
                components: [row] 
            });
        }

        if (commandName === 'counting') {
            gameData.counting = { active: true, current: 0, lastUser: null };
            return await interaction.reply('🎮 **數數開始！** 請從 **1** 開始接力。');
        }

        if (commandName === 'guess') {
            gameData.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
            return await interaction.reply('🎲 **終極密碼！** 範圍：1 ~ 100');
        }

        if (commandName === 'stop') {
            gameData.counting.active = false;
            gameData.guess.active = false;
            return await interaction.reply('🛑 已清空所有遊戲狀態。');
        }
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'toggle_vibe_role') {
            const roleName = 'Vibe Gamer'; 
            const role = interaction.guild.roles.cache.find(r => r.name === roleName);

            if (!role) return await interaction.reply({ content: `❌ 找不到 "${roleName}"，請先建立它。`, ephemeral: true });

            try {
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: `👋 已移除你的 **${roleName}**。`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: `✅ 已新增你的 **${roleName}**！`, ephemeral: true });
                }
            } catch (err) {
                await interaction.reply({ content: '❌ 權限錯誤：請把機器人身份組往上拉。', ephemeral: true });
            }
        }
    }
});

// --- 7. 處理遊戲訊息 ---
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
                gameData.counting.current++;
                gameData.counting.lastUser = msg.author.id;
                await msg.react('✅');
            } else {
                await msg.reply(`❌ 數錯了！紀錄停在：${gameData.counting.current}`);
                gameData.counting.active = false;
            }
        }
    }

    if (gameData.guess.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            const { answer, min, max } = gameData.guess;
            if (num <= min || num >= max) return;
            if (num === answer) {
                await msg.reply(`🎊 猜中了！答案是 **${answer}**`);
                gameData.guess.active = false;
            } else if (num < answer) {
                gameData.guess.min = num;
                await msg.reply(`📈 太小！範圍：**${gameData.guess.min} ~ ${gameData.guess.max}**`);
            } else {
                gameData.guess.max = num;
                await msg.reply(`📉 太大！範圍：**${gameData.guess.min} ~ ${gameData.guess.max}**`);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
