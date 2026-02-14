const { 
    Client, GatewayIntentBits, ActivityType, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits
} = require('discord.js');
const express = require('express');

// --- 1. Web Server ---
const app = express();
app.get('/', (req, res) => res.send('Vibe Bot All-in-One is Online! 🚀'));
app.listen(process.env.PORT || 3000);

// --- 2. 初始化 Client (新增 GuildMembers Intent 以便操作身份組) ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers 
    ]
});

// --- 3. 遊戲與設定狀態 ---
let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 },
    hl: { active: false, lastCard: 0 }
};

// --- 4. 定義指令 (新增 setup-role) ---
const commands = [
    { name: 'counting', description: '開始 Counting 接力' },
    { name: 'guess', description: '開始終極密碼 (1-100)' },
    { name: 'hl', description: '開始高低牌 (按鈕版)' },
    { 
        name: 'setup-role', 
        description: '設置身份組領取按鈕 (僅限管理員)',
        default_member_permissions: PermissionFlagsBits.Administrator.toString()
    },
    { name: 'vibe', description: '檢查系統狀態' },
    { name: 'stop', description: '停止所有遊戲' }
];

// --- 5. 註冊指令 ---
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 指令註冊成功');
    } catch (error) { console.error(error); }
}

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    registerCommands();
});

// --- 6. 處理指令 (Interaction) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'vibe') await interaction.reply('✨ Vibe 狀態：極致穩定 | 支援身份組領取');

    if (commandName === 'stop') {
        Object.keys(gameData).forEach(k => gameData[k].active = false);
        await interaction.reply('🛑 所有遊戲已停止。');
    }

    if (commandName === 'counting') {
        gameData.counting = { active: true, current: 0, lastUser: null };
        await interaction.reply('🎮 **Counting 開始！** 請從 **1** 開始數數...');
    }

    if (commandName === 'guess') {
        gameData.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
        await interaction.reply(`🎲 **終極密碼！** 範圍：**1 ~ 100**，請直接輸入數字。`);
    }

    if (commandName === 'hl') {
        gameData.hl.active = true;
        gameData.hl.lastCard = Math.floor(Math.random() * 13) + 1;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('hl_high').setLabel('大 (Higher)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('hl_low').setLabel('小 (Lower)').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({ content: `🃏 **高低牌**\n當前牌：**[ ${gameData.hl.lastCard} ]**`, components: [row] });
    }

    // --- 新增：設置身份組按鈕指令 ---
    if (commandName === 'setup-role') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('role_vibe_gamer')
                .setLabel('領取 Vibe 玩家身份')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🎮')
        );

        await interaction.reply({
            content: '✨ **身份組領取中心**\n點擊下方按鈕來獲取或移除你的遊戲身份組！',
            components: [row]
        });
    }
});

// --- 7. 處理按鈕互動 (HL 遊戲 & 身份組) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    // A. 處理高低牌按鈕 (略，同前版本)
    if (interaction.customId.startsWith('hl_')) {
        // ... (這裡保留你原本的 HL 邏輯) ...
    }

    // B. 處理身份組按鈕
    if (interaction.customId === 'role_vibe_gamer') {
        // 【重要】請先在伺服器建立一個名為 "Vibe Gamer" 的身份組
        const roleName = 'Vibe Gamer'; 
        const role = interaction.guild.roles.cache.find(r => r.name === roleName);

        if (!role) {
            return interaction.reply({ content: `❌ 找不到名為 "${roleName}" 的身份組，請管理員先建立它！`, ephemeral: true });
        }

        try {
            if (interaction.member.roles.cache.has(role.id)) {
                await interaction.member.roles.remove(role);
                await interaction.reply({ content: `👋 已移除你的 **${roleName}** 身份組。`, ephemeral: true });
            } else {
                await interaction.member.roles.add(role);
                await interaction.reply({ content: `✅ 已為你加上 **${roleName}** 身份組！`, ephemeral: true });
            }
        } catch (err) {
            console.error(err);
            await interaction.reply({ content: '❌ 機器人權限不足（請確保機器人的身份組順序高於目標身份組）。', ephemeral: true });
        }
    }
});

// --- 8. 處理文字訊息 (Counting & Guess 略，同前版本) ---
// ... (保留你原本的 messageCreate 邏輯) ...

client.login(process.env.DISCORD_TOKEN);
