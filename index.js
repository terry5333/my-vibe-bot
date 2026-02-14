const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ApplicationCommandOptionType, EmbedBuilder } = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.get('/', (req, res) => res.send('Vibe Bot is Running!'));
app.listen(process.env.PORT || 10000);

// --- 1. Firebase 初始化 (穩定版) ---
let db, pointsRef;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://my-pos-4eeee-default-rtdb.firebaseio.com/"
        });
    }
    db = admin.database();
    pointsRef = db.ref("userPoints");
    console.log("🔥 Firebase 連線已建立");
} catch (e) { console.error("Firebase Error:", e.message); }

// --- 2. 核心加分功能 (加入錯誤處理) ---
async function addPoints(userId, amount) {
    if (!pointsRef) return console.log("❌ 無法加分：資料庫未連線");
    try {
        const userRef = pointsRef.child(userId);
        const snapshot = await userRef.once("value");
        const newPoints = (snapshot.val() || 0) + amount;
        await userRef.set(newPoints);
        console.log(`✅ 已為 ${userId} 增加 ${amount} 分，目前：${newPoints}`);
    } catch (e) { console.error("加分失敗:", e.message); }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

// --- 3. 指令註冊 ---
const commands = [
    { name: 'rank', description: '顯示排行榜' },
    { name: 'points', description: '查詢我的積分' },
    { name: 'guess', description: '開始終極密碼' },
    { name: 'hl', description: '開始高低牌' }
];

let game = { guess: { active: false, answer: 0, min: 1, max: 100 }, hl: { active: false, lastCard: 0 } };

client.on('ready', async () => {
    console.log(`✅ 機器人登入：${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
});

// --- 4. 交互處理 ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'rank') {
            await interaction.deferReply();
            const snapshot = await pointsRef.once("value");
            const data = snapshot.val() || {};
            const sorted = Object.entries(data).sort(([, a], [, b]) => b - a).slice(0, 10);
            const list = sorted.map(([id, p], i) => `${i+1}. <@${id}>: **${p}** 分`).join('\n') || "尚無資料";
            await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🏆 排行榜").setDescription(list).setColor(0xFFD700)] });
        }

        if (commandName === 'points') {
            await interaction.deferReply({ ephemeral: true });
            const snapshot = await pointsRef.child(interaction.user.id).once("value");
            const pts = snapshot.val() || 0;
            await interaction.editReply(`💰 你的總積分為：**${pts}** 分`);
        }

        if (commandName === 'guess') {
            game.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
            await interaction.reply(`🎲 **終極密碼開始！** 範圍：1 ~ 100，請直接輸入數字。`);
        }

        if (commandName === 'hl') {
            game.hl.active = true;
            game.hl.lastCard = Math.floor(Math.random() * 13) + 1;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('hl_h').setLabel('大').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('hl_l').setLabel('小').setStyle(ButtonStyle.Danger)
            );
            await interaction.reply({ content: `🃏 當前點數：**${game.hl.lastCard}**，下一張牌會更大還是更小？`, components: [row] });
        }
    }

    if (interaction.isButton() && interaction.customId.startsWith('hl_')) {
        if (!game.hl.active) return;
        const next = Math.floor(Math.random() * 13) + 1;
        const win = (interaction.customId === 'hl_h' && next >= game.hl.lastCard) || (interaction.customId === 'hl_l' && next <= game.hl.lastCard);
        if (win) {
            addPoints(interaction.user.id, 5); // 高低牌加分
            game.hl.lastCard = next;
            await interaction.update({ content: `✅ 猜對了！(+5分) 目前點數：**${next}**` });
        } else {
            game.hl.active = false;
            await interaction.update({ content: `❌ 猜錯了！那張牌是 **${next}**。遊戲結束！`, components: [] });
        }
    }
});

// --- 5. 終極密碼邏輯 (修復沒反應問題) ---
client.on('messageCreate', async msg => {
    if (msg.author.bot || !game.guess.active) return;

    const num = parseInt(msg.content);
    if (isNaN(num)) return; // 如果輸入的不是數字就忽略

    if (num === game.guess.answer) {
        game.guess.active = false;
        await addPoints(msg.author.id, 50); // 終極密碼加分
        await msg.reply(`🎊 **恭喜猜中！** 答案就是 **${num}**！你獲得了 50 積分！`);
    } else if (num < game.guess.answer && num > game.guess.min) {
        game.guess.min = num;
        await msg.reply(`📈 更大一點！目前範圍：${game.guess.min} ~ ${game.guess.max}`);
    } else if (num > game.guess.answer && num < game.guess.max) {
        game.guess.max = num;
        await msg.reply(`📉 更小一點！目前範圍：${game.guess.min} ~ ${game.guess.max}`);
    }
});

client.login(process.env.DISCORD_TOKEN);
