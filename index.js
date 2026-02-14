const { 
    Client, GatewayIntentBits, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, 
    PermissionFlagsBits, ApplicationCommandOptionType, ActivityType 
} = require('discord.js');
const express = require('express');

// --- 1. Web Server (Render 存活專用) ---
const app = express();
const port = process.env.PORT || 10000; 
app.get('/', (req, res) => res.send('Vibe Bot Ultimate is Online! 🚀'));
app.listen(port, () => console.log(`監聽端口: ${port}`));

// --- 2. 初始化 Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers // 身份組功能必備
    ]
});

// --- 3. 遊戲數據 ---
let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 },
    hl: { active: false, lastCard: 0 }
};

// --- 4. 指令清單 ---
const commands = [
    // 身份組指令
    {
        name: 'setup-role',
        description: '製作一個領取特定身份組的按鈕 (管理員用)',
        default_member_permissions: PermissionFlagsBits.Administrator.toString(),
        options: [
            {
                name: 'target-role',
                description: '選擇要放入按鈕的身份組',
                type: ApplicationCommandOptionType.Role,
                required: true
            }
        ]
    },
    // 遊戲指令
    { name: 'counting', description: '開始數數接力遊戲' },
    { name: 'guess', description: '開始終極密碼 (1-100)' },
    { name: 'hl', description: '開始高低牌 (按鈕版)' },
    { name: 'stop', description: '停止所有遊戲' },
    { name: 'vibe', description: '檢查機器人狀態' }
];

// 註冊指令
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 所有指令 (遊戲 + 身份組) 已註冊成功');
    } catch (e) { console.error('❌ 指令註冊失敗:', e); }
}

client.on('ready', () => {
    console.log(`🤖 機器人已上線：${client.user.tag}`);
    client.user.setActivity('Vibe with Games & Roles', { type: ActivityType.Playing });
    registerCommands();
});

// --- 5. 互動處理 (核心邏輯) ---
client.on('interactionCreate', async interaction => {
    
    // A. 斜線指令
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // --- 身份組設定指令 ---
        if (commandName === 'setup-role') {
            const selectedRole = interaction.options.getRole('target-role');
            
            // 建立專屬該身份組的按鈕
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`toggle_role_${selectedRole.id}`) // 將 ID 藏在按鈕裡
                    .setLabel(`領取 / 移除 ${selectedRole.name}`)
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✨')
            );

            return await interaction.reply({ 
                content: `🎭 **身份組領取中心**\n點擊下方按鈕來獲取 **${selectedRole.name}**！`, 
                components: [row] 
            });
        }

        // --- 遊戲指令 ---
        if (commandName === 'counting') {
            gameData.counting = { active: true, current: 0, lastUser: null };
            return await interaction.reply('🎮 **數數遊戲開始！** 請從 **1** 開始輸入。');
        }

        if (commandName === 'guess') {
            gameData.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
            return await interaction.reply('🎲 **終極密碼！** 範圍：1 ~ 100，請直接輸入數字。');
        }

        if (commandName === 'hl') {
            gameData.hl.active = true;
            gameData.hl.lastCard = Math.floor(Math.random() * 13) + 1;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('hl_high').setLabel('大 (Higher)').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('hl_low').setLabel('小 (Lower)').setStyle(ButtonStyle.Secondary)
            );
            return await interaction.reply({ 
                content: `🃏 **高低牌**\n當前數字：**[ ${gameData.hl.lastCard} ]**\n猜下張牌更大還是更小？`, 
                components: [row] 
            });
        }

        if (commandName === 'stop') {
            gameData.counting.active = false;
            gameData.guess.active = false;
            gameData.hl.active = false;
            return await interaction.reply('🛑 所有遊戲已停止。');
        }

        if (commandName === 'vibe') return await interaction.reply('⚡ 系統運作正常！');
    }

    // B. 按鈕互動
    if (interaction.isButton()) {
        
        // --- 身份組按鈕邏輯 ---
        if (interaction.customId.startsWith('toggle_role_')) {
            const roleId = interaction.customId.replace('toggle_role_', '');
            const role = interaction.guild.roles.cache.get(roleId);

            if (!role) return await interaction.reply({ content: '❌ 找不到該身份組 (可能已被刪除)。', ephemeral: true });

            try {
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: `👋 已移除 **${role.name}**。`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: `✅ 已獲得 **${role.name}**！`, ephemeral: true });
                }
            } catch (err) {
                await interaction.reply({ 
                    content: '❌ **權限不足！** 請將機器人的身份組拉到比該身份組**更高**的位置。', 
                    ephemeral: true 
                });
            }
        }

        // --- 高低牌遊戲邏輯 ---
        if (interaction.customId.startsWith('hl_')) {
            if (!gameData.hl.active) return await interaction.reply({ content: '遊戲已結束。', ephemeral: true });

            const nextCard = Math.floor(Math.random() * 13) + 1;
            const isHigh = interaction.customId === 'hl_high';
            const win = (isHigh && nextCard >= gameData.hl.lastCard) || (!isHigh && nextCard <= gameData.hl.lastCard);

            if (win) {
                gameData.hl.lastCard = nextCard;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('hl_high').setLabel('大').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('hl_low').setLabel('小').setStyle(ButtonStyle.Secondary)
                );
                await interaction.update({ content: `✅ 猜對了！是 **${nextCard}**。繼續？\n當前：**[ ${nextCard} ]**`, components: [row] });
            } else {
                gameData.hl.active = false;
                await interaction.update({ content: `💥 猜錯了！是 **${nextCard}**。遊戲結束！`, components: [] });
            }
        }
    }
});

// --- 6. 文字訊息監聽 (數數 & 終極密碼) ---
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    // 數數遊戲
    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
                gameData.counting.current++;
                gameData.counting.lastUser = msg.author.id;
                await msg.react('✅');
            } else {
                await msg.reply(`❌ 失敗！數字是 **${gameData.counting.current + 1}**。遊戲重置。`);
                gameData.counting.active = false;
            }
        }
    }

    // 終極密碼
    if (gameData.guess.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            const { answer, min, max } = gameData.guess;
            if (num <= min || num >= max) return; // 超出範圍忽略

            if (num === answer) {
                await msg.reply(`🎊 BINGO！答案是 **${answer}**`);
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
