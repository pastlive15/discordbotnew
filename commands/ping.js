const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'ping',
  description: 'Check the bot\'s latency',
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot\'s latency'),

  async execute(interaction) {
    const sent = await interaction.reply({ content: '📡 Pinging...', fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    const apiLatency = Math.round(interaction.client.ws.ping);

    const embed = new EmbedBuilder()
      .setTitle('🏓 Pong!')
      .setDescription(`📶 **Latency:** \`${latency}ms\`
🛰️ **API Latency:** \`${apiLatency}ms\``)
      .setColor('#00FFFF')
      .setThumbnail('https://i.pinimg.com/originals/80/7b/5c/807b5c4b02e765bb4930b7c66662ef4b.gif')
      .setFooter({ text: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
      .setTimestamp();

    return interaction.editReply({ content: '', embeds: [embed] });
  }
};
