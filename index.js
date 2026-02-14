const { 
    Client, GatewayIntentBits, ActivityType, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits 
} = require('discord.js');
const express = require('express');

// --- 1. Web Server (Koyeb 健康檢查與保持在線) ---
const app = express();
const port = process.env.PORT || 8080; 
app.get('/', (req, res) => res.send('Vibe Bot is blazing fast on Koyeb! 🚀'));
app.listen(port, () => console.log(`伺服器正監聽端口：${port}`));

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

// --- 4. 指令清單 ---
const commands = [
    { name: 'counting', description: '開始 Counting 接力遊戲' },
    { name: 'guess', description: '開始終極密碼遊戲 (1-100)' },
    { name: 'hl', description: '開始高低牌遊戲 (按鈕互動版)' },
    { 
        name: 'setup-role', 
        description: '設置身份組領取按鈕 (僅限管理員)',
        default_member_permissions: PermissionFlagsBits.Administrator.toString()
    },
    { name: 'vibe', description: '檢查機器人狀態' },
    { name: 'stop', description: '停止所有進行中的遊戲' }
];

// 註冊斜線指令
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 所有斜線指令已註冊成功');
    } catch (error) {
        console.error('註冊指令失敗:', error);
    }
}

client.on('ready', () => {
    console.log(`🤖 機器人已上線：${client.user.tag}`);
    client.user.setActivity('極速 Vibe 遊戲中', { type: ActivityType.Competing });
    registerCommands();
});

// --- 5. 統一處理 Interaction (指令與按鈕) ---
client.on('interactionCreate', async interaction => {
    // A. 斜線指令處理
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'vibe') return await interaction.reply('⚡ 引擎狀態：極速響應中 (Koyeb 驅動)');

        if (commandName === 'stop') {
            gameData.counting.active = false;
            gameData.guess.active = false;
            gameData.hl.active = false;
            return await interaction.reply('🛑 所有遊戲已強制停止並重置。');
        }

        if (commandName === 'counting') {
            gameData.counting = { active: true, current: 0, lastUser: null };
            return await interaction.reply('🎮 **Counting 開始！** 請直接輸入 **1** 開始接力數數。');
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
            return await interaction.reply({ content: `🃏 **高低牌**\n當前數字：**[ ${gameData.hl.lastCard} ]**\n請猜測下一張牌會更大還是更小？`, components: [row] });
        }

        if (commandName === 'setup-role') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('role_vibe_gamer').setLabel('領取/移除 Vibe 玩家身份').setStyle(ButtonStyle.Success).setEmoji('🎮')
            );
            return await interaction.reply({ content: '✨ **身份組領取中心**\n點擊按鈕自動獲取專屬身份組！', components: [row] });
        }
    }

    // B. 按鈕互動處理
    if (interaction.isButton()) {
        // 身份組按鈕
        if (interaction.customId === 'role_vibe_gamer') {
            const roleName = 'Vibe Gamer';
            const role = interaction.guild.roles.cache.find(r => r.name === roleName);
            if (!role) return await interaction.reply({ content: `❌ 找不到身份組 "${roleName}"，請手動建立它。`, ephemeral: true });

            try {
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: '👋 身份組已移除。', ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: '✅ 身份組已領取！', ephemeral: true });
                }
            } catch (e) {
                await interaction.reply({ content: '❌ 權限不足，請將機器人身份組順序往上拖移。', ephemeral: true });
            }
        }

        // 高低牌按鈕
        if (interaction.customId.startsWith('hl_')) {
            if (!gameData.hl.active) return await interaction.reply({ content: '遊戲已關閉，請重新開始。', ephemeral: true });

            const nextCard = Math.floor(Math.random() * 13) + 1;
            const isHigher = interaction.customId === 'hl_high';
            const win = (isHigher && nextCard >= gameData.hl.lastCard) || (!isHigher && nextCard <= gameData.hl.lastCard);

            if (win) {
                gameData.hl.lastCard = nextCard;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('hl_high').setLabel('大 (Higher)').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('hl_low').setLabel('小 (Lower)').setStyle(ButtonStyle.Secondary)
                );
                await interaction.update({ content: `✅ 猜對了！是 **${nextCard}**。\n現在數字：**[ ${nextCard} ]**，繼續？`, components: [row] });
            } else {
                gameData.hl.active = false;
                await interaction.update({ content: `💥 猜錯了！是 **${nextCard}**。遊戲結束！`, components: [] });
            }
        }
    }
});

// --- 6. 處理文字訊息遊戲 (Counting & Guess) ---
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
                await msg.reply(`❌ 遊戲結束！數錯或是連數了。最後數字：${gameData.counting.current}`);
                gameData.counting.active = false;
            }
        }
    }

    // Guess 遊戲
    if (gameData.guess.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            const { answer, min, max } = gameData.guess;
            if (num <= min || num >= max) return; // 超出當前範圍則無視

            if (num === answer) {
                await msg.reply(`🎊 猜中了！答案就是 **${answer}**！`);
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
