const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ApplicationCommandOptionType, EmbedBuilder } = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.get('/', (req, res) => res.send('Bot Alive'));
app.listen(process.env.PORT || 10000);

// --- Firebase 初始化 ---
try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CONFIG)),
            databaseURL: "https://my-pos-4eeee-default-rtdb.firebaseio.com/"
        });
    }
} catch (e) { console.error("Firebase Init Error:", e); }

const db = admin.database();
const pointsRef = db.ref("userPoints");

// --- 工具函數：帶有逾時的讀取，防止機器人卡死 ---
async function getDB(ref) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase Timeout')), 5000));
    const data = ref.once("value");
    return Promise.race([data, timeout]);
}

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] 
});

// --- 指令註冊 ---
const commands = [
    { name: 'rank', description: '積分排行榜' },
    { name: 'points', description: '查詢個人積分' },
    { name: 'setup-role', description: '設置身分組按鈕', options: [{ name: 'role', description: '選擇身分組', type: ApplicationCommandOptionType.Role, required: true }], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'counting', description: '開始數數遊戲' },
    { name: 'guess', description: '開始終極密碼' },
    { name: 'hl', description: '開始高低牌' }
];

client.on('ready', async () => {
    console.log(`✅ ${client.user.tag} 已登入`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    } catch (e) { console.error(e); }
});

// 遊戲狀態
let game = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 },
    hl: { active: false, lastCard: 0 }
};

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            if (commandName === 'rank') {
                await interaction.deferReply();
                const snapshot = await getDB(pointsRef).catch(() => null);
                if (!snapshot) return interaction.editReply("❌ 資料庫連線逾時，請檢查 Firebase Rules。");
                
                const data = snapshot.val() || {};
                const sorted = Object.entries(data).sort(([,a], [,b]) => b - a).slice(0, 10);
                const list = sorted.map(([id, p], i) => `${i+1}. <@${id}>: **${p}** 分`).join('\n') || "暫無資料";
                await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🏆 積分排行榜").setDescription(list).setColor(0xFFAA00)] });
            }

            if (commandName === 'setup-role') {
                const role = interaction.options.getRole('role');
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`role_${role.id}`).setLabel(`領取/移除 ${role.name}`).setStyle(ButtonStyle.Primary)
                );
                await interaction.reply({ content: "點擊下方按鈕領取身分組：", components: [row] });
            }

            if (commandName === 'guess') {
                game.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
                await interaction.reply(`🎲 終極密碼開始！請輸入 **1 ~ 100** 之間的數字。`);
            }

            if (commandName === 'hl') {
                game.hl.active = true;
                game.hl.lastCard = Math.floor(Math.random() * 13) + 1;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('hl_h').setLabel('更大').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('hl_l').setLabel('更小').setStyle(ButtonStyle.Danger)
                );
                await interaction.reply({ content: `🃏 當前點數為：**${game.hl.lastCard}**，下一張會更...？`, components: [row] });
            }
        }

        if (interaction.isButton()) {
            // 處理身分組
            if (interaction.customId.startsWith('role_')) {
                const roleId = interaction.customId.split('_')[1];
                const role = interaction.guild.roles.cache.get(roleId);
                if (!role) return interaction.reply({ content: "找不到該身分組", ephemeral: true });

                try {
                    if (interaction.member.roles.cache.has(roleId)) {
                        await interaction.member.roles.remove(role);
                        await interaction.reply({ content: `✅ 已移除 ${role.name}`, ephemeral: true });
                    } else {
                        await interaction.member.roles.add(role);
                        await interaction.reply({ content: `✅ 已領取 ${role.name}`, ephemeral: true });
                    }
                } catch (e) {
                    await interaction.reply({ content: "❌ 權限不足！請確保機器人的身分組順序在該身分組之上。", ephemeral: true });
                }
            }

            // 處理高低牌
            if (interaction.customId.startsWith('hl_')) {
                if (!game.hl.active) return interaction.reply({ content: "遊戲已結束", ephemeral: true });
                const nextCard = Math.floor(Math.random() * 13) + 1;
                const isHigher = nextCard >= game.hl.lastCard;
                const userGuessHigher = interaction.customId === 'hl_h';

                if (userGuessHigher === isHigher) {
                    game.hl.lastCard = nextCard;
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('hl_h').setLabel('更大').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('hl_l').setLabel('更小').setStyle(ButtonStyle.Danger)
                    );
                    await interaction.update({ content: `✅ 猜對了！下一張是 **${nextCard}**。繼續猜？`, components: [row] });
                } else {
                    game.hl.active = false;
                    await interaction.update({ content: `❌ 猜錯了！下一張是 **${nextCard}**。遊戲結束。`, components: [] });
                }
            }
        }
    } catch (err) { console.error("Interaction Error:", err); }
});

client.on('messageCreate', async msg => {
    if (msg.author.bot || !msg.guild) return;

    // 終極密碼邏輯
    if (game.guess.active) {
        const guess = parseInt(msg.content);
        if (isNaN(guess)) return;

        if (guess === game.guess.answer) {
            game.guess.active = false;
            await msg.reply(`🎊 恭喜！答案就是 **${guess}**！`);
            // 加分邏輯可在此添加
        } else if (guess > game.guess.answer) {
            game.guess.max = Math.min(game.guess.max, guess);
            await msg.reply(`📉 更小一點！目前範圍：${game.guess.min} ~ ${game.guess.max}`);
        } else {
            game.guess.min = Math.max(game.guess.min, guess);
            await msg.reply(`📈 更大一點！目前範圍：${game.guess.min} ~ ${game.guess.max}`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
