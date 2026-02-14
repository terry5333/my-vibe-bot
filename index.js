const { 
    Client, GatewayIntentBits, ActivityType, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits 
} = require('discord.js');
const express = require('express');

// --- 1. Web Server ---
const app = express();
app.get('/', (req, res) => res.send('Vibe Bot Stabilized! 🚀'));
app.listen(process.env.PORT || 3000);

// --- 2. 初始化 Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers 
    ]
});

// --- 3. 遊戲狀態儲存 (結構統一) ---
let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 },
    hl: { active: false, lastCard: 0 }
};

// --- 4. 定義與註冊指令 ---
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

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 系統指令已更新');
    } catch (error) { console.error('註冊指令失敗:', error); }
}

client.on('ready', () => {
    console.log(`🤖 ${client.user.tag} 已上線`);
    client.user.setActivity('穩定運作中', { type: ActivityType.Watching });
    registerCommands();
});

// --- 5. 統一處理所有 Interaction (指令與按鈕) ---
client.on('interactionCreate', async interaction => {
    // A. 處理斜線指令
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'vibe') return await interaction.reply('✨ Vibe 狀態：Debug 完成，運行穩定。');
        
        if (commandName === 'stop') {
            gameData.counting.active = false;
            gameData.guess.active = false;
            gameData.hl.active = false;
            return await interaction.reply('🛑 所有遊戲已停止並重置。');
        }

        if (commandName === 'counting') {
            gameData.counting = { active: true, current: 0, lastUser: null };
            return await interaction.reply('🎮 **Counting 開始！** 請輸入 **1** 開始數數。');
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
            return await interaction.reply({ content: `🃏 **高低牌**\n當前牌：**[ ${gameData.hl.lastCard} ]**\n猜測下一張會大還是小？`, components: [row] });
        }

        if (commandName === 'setup-role') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('role_vibe_gamer').setLabel('領取/移除 Vibe 玩家身份').setStyle(ButtonStyle.Success).setEmoji('🎮')
            );
            return await interaction.reply({ content: '✨ **身份組領取中心**', components: [row] });
        }
    }

    // B. 處理按鈕
    if (interaction.isButton()) {
        // 身份組邏輯
        if (interaction.customId === 'role_vibe_gamer') {
            const roleName = 'Vibe Gamer';
            const role = interaction.guild.roles.cache.find(r => r.name === roleName);
            if (!role) return await interaction.reply({ content: '❌ 找不到身份組，請建立名為 "Vibe Gamer" 的身份組。', ephemeral: true });

            try {
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: '👋 已移除身份組。', ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: '✅ 已領取身份組！', ephemeral: true });
                }
            } catch (e) {
                await interaction.reply({ content: '❌ 權限錯誤，請檢查機器人身份組排序。', ephemeral: true });
            }
        }

        // 高低牌按鈕邏輯
        if (interaction.customId.startsWith('hl_')) {
            if (!gameData.hl.active) return await interaction.reply({ content: '遊戲已結束。', ephemeral: true });

            const nextCard = Math.floor(Math.random() * 13) + 1;
            const isHigher = interaction.customId === 'hl_high';
            const win = (isHigher && nextCard >= gameData.hl.lastCard) || (!isHigher && nextCard <= gameData.hl.lastCard);

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

// --- 6. 處理文字訊息 (Counting & Guess) ---
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    // Counting 遊戲
    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
                gameData.counting.current++;
                gameData.counting.lastUser = msg.author.id;
                await msg.react('✅');
            } else {
                await msg.react('❌');
                await msg.reply(`❌ 數錯或連數！結束於：${gameData.counting.current}`);
                gameData.counting.active = false;
            }
        }
    }

    // Guess 遊戲
    if (gameData.guess.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            const { answer, min, max } = gameData.guess;
            if (num <= min || num >= max) return; // 略過範圍外

            if (num === answer) {
                await msg.reply(`🎊 猜中了！答案是 **${answer}**！`);
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
