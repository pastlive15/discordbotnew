const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  name: '8ball',
  description: 'Consult the Mystic Orb for answers!',
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Ask the Mystic Orb a question')
    .addStringOption(option =>
      option.setName('question')
        .setDescription('Your question for the Mystic Orb')
        .setRequired(true)),

  async execute(interaction) {
    const question = interaction.options.getString('question');

    const standardResponses = [
      'Yes.', 'No.', 'Maybe.', 'Definitely!', 'Absolutely not.', 'Ask again later.',
      'I have no idea.', 'Without a doubt.', 'Better not tell you now.',
      'Signs point to yes.', 'Don’t count on it.', 'Most likely.', 'Outlook good.',
      'Very doubtful.', 'My sources say no.', 'You can rely on it.',
      'Concentrate and ask again.', 'Cannot predict now.', 'The stars say yes.',
      'Absolutely!', 'It is certain.', 'Chances aren’t good.', 'Outlook not so good.',
      'Only time will tell.', 'Focus and try again.', 'That is beyond my vision.',
      'Unclear. Reroll fate.', 'It’s complicated.', 'Why not?', 'Doubtful, but not impossible.'
    ];

    const rareResponses = [
      '🪐 The universe says… try again tomorrow.',
      '👾 ERROR 8BALL_NOT_FOUND. Try again.',
      '🎩 A wizard says: Yes, but at what cost?',
      '💀 Certain death. Just kidding... or am I?',
      '🚀 Elon Musk says: To the moon!',
      '🎲 The dice are still rolling...',
      '🧠 My AI brain needs more context.',
      '🌀 A strange force blocks the answer...'
    ];

    const isRare = Math.random() < 0.05; // 5% chance for rare
    const pool = isRare ? rareResponses : standardResponses;
    const answer = pool[Math.floor(Math.random() * pool.length)];

    const embed = new EmbedBuilder()
      .setTitle('🔮 Mystic Orb says...')
      .setDescription(`❓ **${question}**

💬 **${answer}**`)
      .setColor('#6A0DAD')
      .setFooter({ text: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
      .setThumbnail('https://images-ext-1.discordapp.net/external/tAOxVdEWhnami9PoDRyCv09DELJMT8Sx6WGlHJt6i8U/https/i.pinimg.com/originals/86/21/6f/86216f7d3816299ac5aabb5e37bea31f.gif?width=80&height=65')
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};
