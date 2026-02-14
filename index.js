const { 
    Client, GatewayIntentBits, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
    ApplicationCommandOptionType 
} = require('discord.js');
const express = require('express');

// --- 1. Web Server (Render 專用) ---
const app = express();
const port = process.env.PORT || 10000; 
app.get('/', (req, res) => res.send('身分組自選機器人已啟動！🚀'));
app.listen(port);

// --- 2. 初始化 Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers 
    ]
});

// --- 3. 指令設定：新增一個「身分組」參數 ---
const commands = [{
    name: 'setup-role',
    description: '發送指定身分組的領取按鈕',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
        {
            name: 'target-role',
            description: '選擇你想讓大家領取的身分組',
            type: ApplicationCommandOptionType.Role,
            required: true
        }
    ]
}];

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 指令註冊成功');
    } catch (e) { console.error(e); }
}

client.on('ready', () => {
    console.log(`🤖 已登入：${client.user.tag}`);
    registerCommands();
});

// --- 4. 處理互動 ---
client.on('interactionCreate', async interaction => {
    
    // 指令處理
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-role') {
        const selectedRole = interaction.options.getRole('target-role');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                // 將身分組 ID 藏在 customId 裡，按鈕才知道要給哪個組
                .setCustomId(`toggle_role_${selectedRole.id}`)
                .setLabel(`領取/取消 ${selectedRole.name}`)
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✨')
        );

        await interaction.reply({ 
            content: `📢 **身分組發放中心**\n點擊下方按鈕來管理你的 **${selectedRole.name}** 身分組。`, 
            components: [row] 
        });
    }

    // 按鈕處理
    if (interaction.isButton() && interaction.customId.startsWith('toggle_role_')) {
        const roleId = interaction.customId.replace('toggle_role_', '');
        const role = interaction.guild.roles.cache.get(roleId);

        if (!role) {
            return await interaction.reply({ content: '❌ 找不到該身分組，可能已被刪除。', ephemeral: true });
        }

        try {
            if (interaction.member.roles.cache.has(role.id)) {
                await interaction.member.roles.remove(role);
                await interaction.reply({ content: `👋 已移除你的 **${role.name}**。`, ephemeral: true });
            } else {
                await interaction.member.roles.add(role);
                await interaction.reply({ content: `✅ 已為你新增 **${role.name}**！`, ephemeral: true });
            }
        } catch (err) {
            await interaction.reply({ 
                content: '❌ 權限錯誤：請確認機器人的身分組順序在該身分組之上！', 
                ephemeral: true 
            });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
