const { 
    Client, GatewayIntentBits, ActivityType, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits 
} = require('discord.js');
const express = require('express');

// --- 1. Web Server (Koyeb 健康檢查與保持在線) ---
const app = express();
const port = process.env.PORT || 8080; 
app.get('/', (req, res) => res.send('Vibe Bot is blazing fast on Koyeb! 🚀'));
app.listen(port, () => console.log(`伺服器正在監聽端口：${port}`));

// --- 2. 初始化 Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers 
    ]
});

// --- 3. 遊戲狀態儲存 ---
let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 },
    hl: { active: false, lastCard: 0 }
};

// --- 4. 斜線指令定義 ---
const commands = [
    { name: 'counting', description: '開始 Counting 接力遊戲' },
    { name: 'guess', description: '開始終極密碼遊戲 (1-100)' },
    { name: 'hl', description: '開始高低牌遊戲 (按鈕版)' },
    { 
        name: 'setup-role', 
        description: '設置身份組切換按鈕 (管理員專用)',
        default_member_permissions: PermissionFlagsBits.Administrator.toString()
    },
    { name: 'vibe', description: '檢查系統狀態' },
    { name: 'stop', description: '停止所有進行中的遊戲' }
];

// 註冊指令
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 所有斜線指令已同步成功');
    } catch (error) { console.error('註冊失敗:', error); }
}

client.on('ready', () => {
    console.log(`🚀 ${client.user.tag} 已在 Koyeb 啟動`);
    client.user.setActivity('極速遊戲 Vibe ⚡', { type: ActivityType.Playing });
    registerCommands();
});

// --- 5. 統一處理互動 (指令與按鈕) ---
client.on('interactionCreate', async interaction => {
    
    // A. 斜線指令邏輯
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'vibe') return await interaction.reply('⚡ 引擎狀態：完美流動中');

        if (commandName === 'stop') {
            gameData.counting.active = false;
            gameData.guess.active = false;
            gameData.hl.active = false;
            return await interaction.reply('🛑 所有遊戲已重置。');
        }

        if (commandName === 'counting') {
            gameData.counting = { active: true, current: 0, lastUser: null };
            return await interaction.reply('🎮 **Counting 開始！** 請直接輸入 **1** 開始接力。');
        }

        if (commandName === 'guess') {
            gameData.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
            return await interaction.reply(`🎲 **終極密碼！** 範圍：**1 ~ 100**，請直接輸入數字。`);
        }

        if (commandName === 'hl') {
            gameData.hl.active = true;
            gameData.hl.lastCard = Math.floor(Math.random() * 13) + 1;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('hl_high').setLabel('大 (Higher)').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('hl_low').setLabel('小 (Lower)').setStyle(ButtonStyle.Secondary)
            );
            return await interaction.reply({ content: `🃏 **高低牌**\n當前數字：**[ ${gameData.hl.lastCard} ]**`, components: [row] });
        }

        if (commandName === 'setup-role') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('toggle_vibe_role')
                    .setLabel('領取 / 取消 Vibe Gamer 身份組')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🎮')
            );
            return await interaction.reply({ 
                content: '✨ **身份組領取中心**\n點擊下方按鈕領取身份組，再次點擊即可移除。', 
                components: [row] 
            });
        }
    }

    // B. 按鈕互動邏輯 (身份組切換 + 遊戲)
    if (interaction.isButton()) {
        
        // 身份組自助切換：點一下新增，點一下取消
        if (interaction.customId === 'toggle_vibe_role') {
            const roleName = 'Vibe Gamer'; // 請確保伺服器有這個名字的身份組
            const role = interaction.guild.roles.cache.find(r => r.name === roleName);

            if (!role) return await interaction.reply({ content: `❌ 找不到身份組 "${roleName}"，請先建立它。`, ephemeral: true });

            try {
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: `👋 已成功**取消**你的 **${roleName}** 身份組。`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: `✅ 已成功**新增**你的 **${roleName}** 身份組！`, ephemeral: true });
                }
            } catch (err) {
                await interaction.reply({ content: '❌ 機器人權限不足！請將機器人的身份組順序拉到最高。', ephemeral: true });
            }
        }

        // 高低牌遊戲邏輯
        if (interaction.customId.startsWith('hl_')) {
            if (!gameData.hl.active) return await interaction.reply({ content: '遊戲已結束', ephemeral: true });
            const nextCard = Math.floor(Math.random() * 13) + 1;
            const win = (interaction.customId === 'hl_high' && nextCard >= gameData.hl.lastCard) || (interaction.customId === 'hl_low' && nextCard <= gameData.hl.lastCard);
            
            if (win) {
                gameData.hl.lastCard = nextCard;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('hl_high').setLabel('大 (Higher)').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('hl_low').setLabel('小 (Lower)').setStyle(ButtonStyle.Secondary)
                );
                await interaction.update({ content: `✅ 猜對了！是 **${nextCard}**。繼續？`, components: [row] });
            } else {
                gameData.hl.active = false;
                await interaction.update({ content: `💥 猜錯了！是 **${nextCard}**。遊戲結束。`, components: [] });
            }
        }
    }
});

// --- 6. 處理文字訊息 (數數遊戲與終極密碼) ---
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    // Counting 接力邏輯
    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
                gameData.counting.current++;
                gameData.counting.lastUser = msg.author.id;
                await msg.react('✅');
            } else {
                await msg.reply(`❌ 遊戲結束！數錯或連數了。最後紀錄：${gameData.counting.current}`);
                gameData.counting.active = false;
            }
        }
    }

    // 終極密碼邏輯
    if (gameData.guess.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            const { answer, min, max } = gameData.guess;
            if (num <= min || num >= max) return; // 超出範圍則忽略
            if (num === answer) {
                await msg.reply(`🎊 猜中了！答案是 **${answer}**`);
                gameData.guess.active = false;
            } else if (num < answer) {
                gameData.guess.min = num;
                await msg.reply(`📈 太小了！範圍變為：**${gameData.guess.min} ~ ${gameData.guess.max}**`);
            } else {
                gameData.guess.max = num;
                await msg.reply(`📉 太大了！範圍變為：**${gameData.guess.min} ~ ${gameData.guess.max}**`);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

