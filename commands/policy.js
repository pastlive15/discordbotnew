const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'policy',
  description: 'View the Terms of Service and Privacy Policy for this bot',
  data: new SlashCommandBuilder()
    .setName('policy')
    .setDescription('Show Terms of Service and Privacy Policy'),

  async execute(interaction) {
    const tosEmbed = new EmbedBuilder()
      .setTitle('📜 Terms of Service')
      .setColor('Blue')
      .setDescription(
        `By using this bot, you agree to the following:\n
• You will not exploit or abuse the bot's features.
• The bot is provided "as is" with no guarantees.
• The bot owner may modify or remove features at any time.
• Continued use means you accept these terms.\n
Violations may result in blacklisting from using the bot.`
      )
      .setFooter({ text: 'Last updated', iconURL: interaction.client.user.displayAvatarURL() })
      .setTimestamp();

    const privacyEmbed = new EmbedBuilder()
      .setTitle('🔒 Privacy Policy')
      .setColor('DarkPurple')
      .setDescription(
        `We care about your data. Here's what we do:\n
• Only store minimal public info (user ID, XP, coins, etc.).
• No access to private messages or personal data.
• Your data is not sold or shared.
• You may request deletion via server admin.\n
Using this bot constitutes agreement to this policy.`
      )
      .setFooter({ text: 'Policy subject to change', iconURL: interaction.client.user.displayAvatarURL() })
      .setTimestamp();

    return interaction.reply({ embeds: [tosEmbed, privacyEmbed], ephemeral: true });
  }
};
