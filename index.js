const { 
    Client, GatewayIntentBits, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, 
    PermissionFlagsBits, ApplicationCommandOptionType, EmbedBuilder 
} = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

// --- 1. Firebase 初始化 ---
let db;
let pointsRef;

try {
    if (!process.env.FIREBASE_CONFIG) {
        console.error("❌ 錯誤：找不到 FIREBASE_CONFIG 環境變數");
    } else {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // 注意：如果你的資料庫在不同區域，網址可能不同
            databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com/`
        });
        db = admin.database();
        pointsRef = db.ref("userPoints");
        console.log("🔥 Firebase 初始化成功！");
    }
} catch (e) {
    console.error("❌ Firebase 初始化崩潰:", e.message);
}

// --- 2. Web Server ---
const app = express();
app.get('/', (req, res) => res.send('Bot Status: Online'));
app.listen(process.env.PORT || 10000);

// --- 3. Discord Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers 
    ]
});

// 積分非同步處理
async function addPoints(userId, amount) {
    try {
        if (!pointsRef) return;
        const userRef = pointsRef.child(userId);
        const snapshot = await userRef.once("value");
        const currentPoints = snapshot.val() || 0;
        await userRef.set(currentPoints + amount);
    } catch (e) {
        console.error("❌ 增加積分失敗:", e.message);
    }
}

// --- 4. 指令註冊 ---
const commands = [
    { name: 'rank', description: '查看積分排行榜' },
    { name: 'points', description: '查看我的個人積分' },
    { name: 'setup-role', description: '發送身分組按鈕', options: [{ name: 'target-role', description: '身分組', type: ApplicationCommandOptionType.Role, required: true }], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'counting', description: '開始數數接力遊戲' },
    { name: 'guess', description: '開始終極密碼' },
    { name: 'hl', description: '開始高低牌遊戲' },
    { name: 'stop', description: '停止遊戲' }
];

client.on('ready', async () => {
    console.log(`🤖 機器人上線：${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
});

// 遊戲狀態
let gameData = { counting: { active: false, current: 0, lastUser: null }, guess: { active: false, answer: 0, min: 1, max: 100 }, hl: { active: false, lastCard: 0 } };

// --- 5. 互動處理 ---
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // 排行榜
        if (commandName === 'rank') {
            await interaction.deferReply();
            console.log("正在嘗試讀取排行榜...");
            try {
                const snapshot = await pointsRef.once("value").catch(e => { throw e });
                const data = snapshot.val() || {};
                const sorted = Object.entries(data).sort(([, a], [, b]) => b - a).slice(0, 10);
                const description = sorted.map(([id, pts], i) => `${i + 1}. <@${id}> - **${pts}** 分`).join('\n') || "目前尚無積分記錄";
                
                await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🏆 積分排行榜').setDescription(description).setColor(0xFFD700)] });
            } catch (err) {
                console.error("❌ 排行榜讀取錯誤:", err.message);
                await interaction.editReply(`❌ 資料庫讀取超時或失敗：${err.message}`);
            }
        }

        // 個人分數
        if (commandName === 'points') {
            await interaction.deferReply({ ephemeral: true });
            try {
                const snapshot = await pointsRef.child(interaction.user.id).once("value");
                const pts = snapshot.val() || 0;
                await interaction.editReply(`💰 你目前擁有 **${pts}** 分！`);
            } catch (err) {
                await interaction.editReply("❌ 無法獲取分數，請檢查資料庫。");
            }
        }

        // 身分組按鈕邏輯
        if (commandName === 'setup-role') {
            const role = interaction.options.getRole('target-role');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`tg_${role.id}`).setLabel(`領取 / 移除 ${role.name}`).setStyle(ButtonStyle.Primary)
            );
            return await interaction.reply({ content: `🎭 **身分組中心**`, components: [row] });
        }

        // 啟動遊戲 (簡化版)
        if (commandName === 'counting') { gameData.counting = { active: true, current: 0, lastUser: null }; await interaction.reply('🎮 數數開始！從 1 開始。'); }
        if (commandName === 'guess') { gameData.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 }; await interaction.reply('🎲 終極密碼開始！'); }
        if (commandName === 'hl') { 
            gameData.hl.active = true; gameData.hl.lastCard = Math.floor(Math.random() * 13) + 1;
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hl_h').setLabel('大').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('hl_l').setLabel('小').setStyle(ButtonStyle.Danger));
            await interaction.reply({ content: `🃏 當前數字：${gameData.hl.lastCard}`, components: [row] });
        }
        if (commandName === 'stop') { gameData.counting.active = gameData.guess.active = gameData.hl.active = false; await interaction.reply('🛑 遊戲已關閉。'); }
    }

    // 按鈕處理
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('tg_')) {
            const roleId = interaction.customId.replace('tg_', '');
            const role = interaction.guild.roles.cache.get(roleId);
            try {
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: '已移除。', ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: '已領取！', ephemeral: true });
                }
            } catch (e) { await interaction.reply({ content: '權限不足！', ephemeral: true }); }
        }

        if (interaction.customId.startsWith('hl_')) {
            if (!gameData.hl.active) return;
            const next = Math.floor(Math.random() * 13) + 1;
            const win = (interaction.customId === 'hl_h' && next >= gameData.hl.lastCard) || (interaction.customId === 'hl_l' && next <= gameData.hl.lastCard);
            if (win) {
                await addPoints(interaction.user.id, 5);
                gameData.hl.lastCard = next;
                await interaction.update({ content: `✅ 猜對了！(+5分) 下一張：**${next}**` });
            } else {
                gameData.hl.active = false;
                await interaction.update({ content: `💥 猜錯了！是 **${next}**。遊戲結束！`, components: [] });
            }
        }
    }
});

// 文字訊息處理
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
            gameData.counting.current++; gameData.counting.lastUser = msg.author.id;
            await addPoints(msg.author.id, 1); await msg.react('✅');
        }
    }
    if (gameData.guess.active && parseInt(msg.content) === gameData.guess.answer) {
        await addPoints(msg.author.id, 50); await msg.reply(`🎊 猜中了！獲得 50 積分。`);
        gameData.guess.active = false;
    }
});

client.login(process.env.DISCORD_TOKEN);
