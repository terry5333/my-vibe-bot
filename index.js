const { 
    Client, GatewayIntentBits, ActivityType, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType 
} = require('discord.js');
const express = require('express');

// --- 1. Web Server (保持在線) ---
const app = express();
app.get('/', (req, res) => res.send('Vibe Bot Final is Online! 🚀'));
app.listen(process.env.PORT || 3000);

// --- 2. 初始化 Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- 3. 遊戲狀態儲存 ---
let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 },
    hl: { active: false, lastCard: 0 }
};

// --- 4. 定義斜線指令 ---
const commands = [
    { name: 'counting', description: '開始 Counting 接力' },
    { name: 'guess', description: '開始終極密碼 (1-100)' },
    { name: 'hl', description: '開始高低牌 (按鈕版)' },
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
    client.user.setActivity('Vibe Coding 🚀', { type: ActivityType.Playing });
    registerCommands();
});

// --- 6. 處理指令 (Interaction) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'vibe') {
        await interaction.reply('✨ 系統環境：Render 雲端 | 狀態：完美流動中');
    }

    if (interaction.commandName === 'stop') {
        Object.keys(gameData).forEach(k => gameData[k].active = false);
        await interaction.reply('🛑 所有遊戲已重置。');
    }

    if (interaction.commandName === 'counting') {
        gameData.counting = { active: true, current: 0, lastUser: null };
        await interaction.reply('🎮 **Counting 開始！** 請從 **1** 開始數數...');
    }

    if (interaction.commandName === 'guess') {
        gameData.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
        await interaction.reply(`🎲 **終極密碼！** 範圍：**1 ~ 100**，請直接輸入數字。`);
    }

    if (interaction.commandName === 'hl') {
        gameData.hl.active = true;
        gameData.hl.lastCard = Math.floor(Math.random() * 13) + 1;
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('hl_high').setLabel('大 (Higher)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('hl_low').setLabel('小 (Lower)').setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({
            content: `🃏 **高低牌 (單人)**\n目前的牌是：**[ ${gameData.hl.lastCard} ]**\n請點擊按鈕猜測下一張牌：`,
            components: [row]
        });
    }
});

// --- 7. 處理按鈕點擊 (HL 遊戲) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (!gameData.hl.active) return interaction.reply({ content: '遊戲已結束', ephemeral: true });

    const nextCard = Math.floor(Math.random() * 13) + 1;
    const isHigher = interaction.customId === 'hl_high';
    const win = (isHigher && nextCard >= gameData.hl.lastCard) || (!isHigher && nextCard <= gameData.hl.lastCard);

    if (win) {
        gameData.hl.lastCard = nextCard;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('hl_high').setLabel('大 (Higher)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('hl_low').setLabel('小 (Lower)').setStyle(ButtonStyle.Secondary)
        );
        await interaction.update({
            content: `✅ 猜對了！是 **${nextCard}**。\n現在牌是：**[ ${nextCard} ]**，繼續？`,
            components: [row]
        });
    } else {
        gameData.hl.active = false;
        await interaction.update({
            content: `💥 猜錯了！是 **${nextCard}**。遊戲結束！`,
            components: []
        });
    }
});

// --- 8. 處理文字訊息 (Counting & Guess) ---
client.on('messageCreate', msg => {
    if (msg.author.bot) return;

    // Counting 邏輯
    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
                gameData.counting.current++;
                gameData.counting.lastUser = msg.author.id;
                msg.react('✅');
            } else {
                msg.react('❌');
                msg.reply(`❌ 遊戲結束！最後數字是 ${gameData.counting.current}`);
                gameData.counting.active = false;
            }
        }
    }

    // Guess 邏輯
    if (gameData.guess.active) {
        const num = parseInt(msg.content);
        if (!isNaN(num) && /^\d+$/.test(msg.content)) {
            const { answer, min, max } = gameData.guess;
            if (num === answer) {
                msg.reply(`🎊 猜中了！答案是 **${answer}**！`);
                gameData.guess.active = false;
            } else if (num > min && num < answer) {
                gameData.guess.min = num;
                msg.reply(`📈 太小！範圍：${gameData.guess.min} ~ ${gameData.guess.max}`);
            } else if (num < max && num > answer) {
                gameData.guess.max = num;
                msg.reply(`📉 太大！範圍：${gameData.guess.min} ~ ${gameData.guess.max}`);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
