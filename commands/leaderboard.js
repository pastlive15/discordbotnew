// PostgreSQL-compatible Leaderboard Command
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'leaderboard',
  description: '🏅 View the Hall of Fame — Top 10 Legends!',
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the Hall of Fame — top 10 users by level & XP!'),

  async execute(interaction, db) {
    const res = await db.query(
      'SELECT username, user_id, level, xp FROM users ORDER BY level DESC, xp DESC LIMIT 10'
    );
    const topUsers = res.rows;

    if (!topUsers.length) {
      return interaction.reply("🚫 The Hall of Fame is currently empty. Start grinding to get your name etched in history!");
    }

    const medals = ['<a:_dance_:1392229732770254909>', '<a:Crown_light_blue97:1392229747047534663>', '<a:blackcrown:1392229759001432135>'];

    const lines = topUsers.map((user, index) => {
      const medal = medals[index] || `#${index + 1}`;
      const name = user.username || `MysteryUser (${user.user_id})`;
      const level = user.level ?? 0;
      const xp = user.xp ?? 0;
      return `${medal} **${name}** — 🏅 Level **${level}**, <:stars:1392200379281834084> XP: \`${xp.toLocaleString()}\``;
    });

    const embed = new EmbedBuilder()
      .setTitle('🏆 Hall of Fame')
      .setColor('Gold')
      .setThumbnail('https://media.tenor.com/nLa-FFy-Nb4AAAAd/crown-king.gif')
      .setDescription(`These legends have carved their names into glory:\n\n${lines.join('\n')}`)
      .setFooter({ text: 'Use /rank to check your journey to greatness!' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};
