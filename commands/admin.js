// commands/admin.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { initUser } = require('../utils/initUser');
const { isAdmin } = require('../utils/adminAuth');

const VALID_LOCATIONS = new Set(['money', 'bank']); // whitelist for column names

module.exports = {
  name: 'admin',
  description: 'Admin commands to manage user stats',
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands to manage user stats')
    // NOTE: Do NOT gate by Discord permission; we’ll gate by ID list instead.
    .setDMPermission(false)
    .addSubcommand(subcommand =>
      subcommand.setName('editxp')
        .setDescription('Edit XP for a user')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('New XP amount').setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('editcoin')
        .setDescription('Edit coins for a user')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('New coin amount').setRequired(true))
        .addStringOption(option => option.setName('location').setDescription('Where to apply the coins: money or bank')
          .addChoices({ name: 'money', value: 'money' }, { name: 'bank', value: 'bank' })
          .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('editlevel')
        .setDescription('Edit level for a user')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('New level').setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('editjoblevel')
        .setDescription('Edit job level for a user')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('New job level').setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('addxp')
        .setDescription('Add XP to a user')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('Amount of XP to add').setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('addcoin')
        .setDescription('Add coins to a user')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('Amount of coins to add').setRequired(true))
        .addStringOption(option => option.setName('location').setDescription('Where to add the coins: money or bank')
          .addChoices({ name: 'money', value: 'money' }, { name: 'bank', value: 'bank' })
          .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('addlevel')
        .setDescription('Add levels to a user')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('Amount of levels to add').setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('addjoblevel')
        .setDescription('Add job levels to a user')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('Amount of job levels to add').setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('resetdaily')
        .setDescription('Reset a user\'s daily cooldown')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('resetsteal')
        .setDescription('Reset a user\'s steal cooldown')
        .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))),

  async execute(interaction, db) {
    // Authorize: allow only IDs listed in config/admins.json (and optionally guild owner)
    const callerId = interaction.user.id;
    const ownerId = interaction.guild?.ownerId;
    if (!isAdmin(callerId, ownerId)) {
      return interaction.reply({
        content: '🚫 You are not authorized to use this command.',
        ephemeral: true
      });
    }

    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getUser('user');
    if (!target) {
      return interaction.reply({ content: '⚠️ Please provide a valid user.', ephemeral: true });
    }

    const userId = target.id;
    const username = target.username;

    // Ensure the target exists in DB
    await initUser(target);

    const embed = new EmbedBuilder()
      .setTimestamp()
      .setFooter({ text: `Modified by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) });

    let query = '';
    let message = '';
    let values = [];

    switch (sub) {
      case 'editxp': {
        const amount = interaction.options.getInteger('amount');
        query = 'UPDATE users SET xp = $1 WHERE user_id = $2';
        values = [amount, userId];
        message = `✅ Set **${username}**'s XP to **${amount}**.`;
        embed.setTitle('📘 XP Set').setColor('Blue');
        break;
      }
      case 'editcoin': {
        const amount = interaction.options.getInteger('amount');
        const location = interaction.options.getString('location');
        if (!VALID_LOCATIONS.has(location)) {
          return interaction.reply({ content: '⚠️ Location must be `money` or `bank`.', ephemeral: true });
        }
        query = `UPDATE users SET ${location} = $1 WHERE user_id = $2`;
        values = [amount, userId];
        message = `✅ Set **${username}**'s ${location} to **${amount} coins**.`;
        embed.setTitle('💰 Coin Set').setColor('Gold');
        break;
      }
      case 'addcoin': {
        const amount = interaction.options.getInteger('amount');
        const location = interaction.options.getString('location');
        if (!VALID_LOCATIONS.has(location)) {
          return interaction.reply({ content: '⚠️ Location must be `money` or `bank`.', ephemeral: true });
        }
        query = `UPDATE users SET ${location} = ${location} + $1 WHERE user_id = $2`;
        values = [amount, userId];
        message = `➕ Added **${amount} coins** to **${username}**'s ${location}.`;
        embed.setTitle('💰 Coins Added').setColor('Gold');
        break;
      }
      case 'editlevel': {
        const amount = interaction.options.getInteger('amount');
        query = 'UPDATE users SET level = $1 WHERE user_id = $2';
        values = [amount, userId];
        message = `✅ Set **${username}**'s level to **${amount}**.`;
        embed.setTitle('🏆 Level Set').setColor('Purple');
        break;
      }
      case 'editjoblevel': {
        const amount = interaction.options.getInteger('amount');
        query = 'UPDATE users SET job_level = $1 WHERE user_id = $2';
        values = [amount, userId];
        message = `✅ Set **${username}**'s job level to **${amount}**.`;
        embed.setTitle('🛠️ Job Level Set').setColor('DarkOrange');
        break;
      }
      case 'addxp': {
        const amount = interaction.options.getInteger('amount');
        query = 'UPDATE users SET xp = xp + $1 WHERE user_id = $2';
        values = [amount, userId];
        message = `➕ Added **${amount} XP** to **${username}**.`;
        embed.setTitle('📘 XP Added').setColor('Blue');
        break;
      }
      case 'addlevel': {
        const amount = interaction.options.getInteger('amount');
        query = 'UPDATE users SET level = level + $1 WHERE user_id = $2';
        values = [amount, userId];
        message = `➕ Added **${amount} levels** to **${username}**.`;
        embed.setTitle('🏆 Levels Added').setColor('Purple');
        break;
      }
      case 'addjoblevel': {
        const amount = interaction.options.getInteger('amount');
        query = 'UPDATE users SET job_level = job_level + $1 WHERE user_id = $2';
        values = [amount, userId];
        message = `➕ Added **${amount} job levels** to **${username}**.`;
        embed.setTitle('🛠️ Job Levels Added').setColor('DarkOrange');
        break;
      }
      case 'resetdaily': {
        query = 'UPDATE users SET last_daily = 0 WHERE user_id = $1';
        values = [userId];
        message = `🕒 **${username}** can now claim their daily reward again.`;
        embed.setTitle('🔁 Daily Cooldown Reset').setColor('Aqua');
        break;
      }
      case 'resetsteal': {
        query = 'UPDATE users SET last_steal = 0 WHERE user_id = $1';
        values = [userId];
        message = `🕵️‍♂️ **${username}** can now steal again.`;
        embed.setTitle('🔁 Steal Cooldown Reset').setColor('Red');
        break;
      }
      default:
        return interaction.reply({ content: '⚠️ Unknown subcommand.', ephemeral: true });
    }

    if (query) {
      await db.query(query, values);
      embed.setDescription(message);
      return interaction.reply({ embeds: [embed] });
    }
  }
};
