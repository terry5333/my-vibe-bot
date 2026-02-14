const { 
    Client, GatewayIntentBits, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, 
    PermissionFlagsBits, ApplicationCommandOptionType, EmbedBuilder 
} = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

// --- 1. Firebase 初始化 ---
// 請在 Render 設定一個環境變數 FIREBASE_CONFIG，內容為下載的 JSON 全文
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com/`
});
const db = admin.database();
const pointsRef = db.ref("userPoints");

// --- 2. Web Server ---
const app = express();
app.get('/', (req, res) => res.send('Vibe Bot + Firebase is Live! 🔥'));
app.listen(process.env.PORT || 10000);

// --- 3. 初始化 Discord Client ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});

// 積分處理函式 (改為非同步同步到 Firebase)
async function addPoints(userId, amount) {
    const userRef = pointsRef.child(userId);
    const snapshot = await userRef.once("value");
    const currentPoints = snapshot.val() || 0;
    await userRef.set(currentPoints + amount);
}

// --- 4. 指令清單 ---
const commands = [
    {
        name: 'setup-role',
        description: '身分組按鈕',
        options: [{ name: 'target-role', description: '身分組', type: ApplicationCommandOptionType.Role, required: true }],
        default_member_permissions: PermissionFlagsBits.Administrator.toString()
    },
    { name: 'rank', description: '積分排行榜' },
    { name: 'points', description: '我的積分' },
    { name: 'counting', description: '數數開始' },
    { name: 'guess', description: '終極密碼' },
    { name: 'hl', description: '高低牌' },
    { name: 'stop', description: '停止遊戲' }
];

// 遊戲狀態 (存記憶體即可，重啟重來沒關係)
let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 },
    hl: { active: false, lastCard: 0 }
};

client.on('ready', async () => {
    console.log(`🤖 Firebase 版機器人已上線：${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
});

// --- 5. 互動邏輯 ---
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'rank') {
            const snapshot = await pointsRef.once("value");
            const data = snapshot.val() || {};
            const sorted = Object.entries(data).sort(([, a], [, b]) => b - a).slice(0, 10);
            const description = sorted.map(([id, pts], i) => `${i + 1}. <@${id}> - **${pts}** 分`).join('\n') || "尚無資料";
            return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('🏆 排行榜').setDescription(description).setColor(0x00FF00)] });
        }

        if (commandName === 'points') {
            const snapshot = await pointsRef.child(interaction.user.id).once("value");
            return await interaction.reply(`💰 你的總積分：**${snapshot.val() || 0}** 分`);
        }

        // 啟動遊戲邏輯 (比照前版)
        if (commandName === 'counting') { gameData.counting = { active: true, current: 0, lastUser: null }; await interaction.reply('數數開始！'); }
        if (commandName === 'guess') { gameData.guess = { active: true, answer: Math.floor(Math.random()*100)+1, min: 1, max: 100 }; await interaction.reply('終極密碼開始！'); }
        if (commandName === 'hl') { 
            gameData.hl.active = true; gameData.hl.lastCard = Math.floor(Math.random()*13)+1;
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hl_h').setLabel('大').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('hl_l').setLabel('小').setStyle(ButtonStyle.Danger));
            await interaction.reply({ content: `🃏 當前：${gameData.hl.lastCard}`, components: [row] });
        }
        if (commandName === 'setup-role') {
            const role = interaction.options.getRole('target-role');
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tg_${role.id}`).setLabel(`領取 ${role.name}`).setStyle(ButtonStyle.Primary));
            await interaction.reply({ content: `🎭 設定完成`, components: [row] });
        }
    }

    if (interaction.isButton()) {
        if (interaction.customId.startsWith('tg_')) {
            const roleId = interaction.customId.replace('tg_', '');
            const role = interaction.guild.roles.cache.get(roleId);
            if (interaction.member.roles.cache.has(role.id)) { await interaction.member.roles.remove(role); await interaction.reply({ content: '已移除', ephemeral: true }); }
            else { await interaction.member.roles.add(role); await interaction.reply({ content: '已領取', ephemeral: true }); }
        }
        if (interaction.customId.startsWith('hl_')) {
            if (!gameData.hl.active) return;
            const next = Math.floor(Math.random()*13)+1;
            const win = (interaction.customId === 'hl_h' && next >= gameData.hl.lastCard) || (interaction.customId === 'hl_l' && next <= gameData.hl.lastCard);
            if (win) {
                await addPoints(interaction.user.id, 5);
                gameData.hl.lastCard = next;
                await interaction.update({ content: `✅ 猜對！+5分。目前：**${next}**` });
            } else {
                gameData.hl.active = false;
                await interaction.update({ content: `💥 猜錯！是 ${next}`, components: [] });
            }
        }
    }
});

// 文字遊戲積分
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
            gameData.counting.current++; gameData.counting.lastUser = msg.author.id;
            await addPoints(msg.author.id, 1); await msg.react('💰');
        }
    }
    if (gameData.guess.active && parseInt(msg.content) === gameData.guess.answer) {
        await addPoints(msg.author.id, 50); await msg.reply(`🎊 中獎！+50分`);
        gameData.guess.active = false;
    }
});

client.login(process.env.DISCORD_TOKEN);
