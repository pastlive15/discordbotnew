// commands/8ball.js
// 🔮 Mystic Orb (8ball) — refined
// - Weighted responses (pos/neutral/neg)
// - Rare & ultra-rare easter eggs
// - Smart formatting for question (adds '?' if missing)
// - Color by sentiment, neat embed layout

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ---------- utils ----------
const chance = (p) => Math.random() < p;
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];

// normalize user question (trim spaces, ensure '?' at end, clamp length)
function normalizeQuestion(q) {
  if (!q) return '…';
  let s = String(q).trim().replace(/\s+/g, ' ');
  if (s.length > 256) s = s.slice(0, 253) + '...';
  if (!/[?？！?]$/.test(s)) s += '?';
  return s;
}

// ---------- responses ----------
const RESPONSES = {
  positive: [
    'Yes.', 'Definitely!', 'Without a doubt.', 'It is certain.',
    'You can rely on it.', 'Absolutely!', 'Signs point to yes.',
    'Most likely.', 'Outlook good.', 'The stars say yes.'
  ],
  neutral: [
    'Maybe.', 'Ask again later.', 'Better not tell you now.',
    'Cannot predict now.', 'Only time will tell.',
    'Focus and try again.', 'Concentrate and ask again.',
    'It’s complicated.', 'Unclear. Try once more.', 'Why not?'
  ],
  negative: [
    'No.', 'Absolutely not.', 'Don’t count on it.',
    'Very doubtful.', 'Chances aren’t good.',
    'Outlook not so good.', 'My sources say no.',
    'Doubtful, but not impossible.'
  ],
  rare: [
    '🪐 The universe says… try again tomorrow.',
    '🎩 A wizard says: Yes—but at what cost?',
    '💀 Certain death. Just kidding... or am I?',
    '🎲 The dice are still rolling...',
    '🧠 My AI brain needs more context.',
    '🌀 A strange force blocks the answer...'
  ],
  ultra: [
    '✨ Fate bends in your favor.',
    '☄️ Portents align. Seize the moment.',
    '🧿 The veil parts: a rare “YES”.',
    '♾️ All timelines converge to NO—change your path.',
  ]
};

// weights for common pool (before rare overrides)
const WEIGHTS = { positive: 0.45, neutral: 0.30, negative: 0.25 };
// rare probabilities (independent override)
const RARE_P = 0.05;    // 5%
const ULTRA_P = 0.01;   // 1%

function drawAnswer() {
  // ultra-rare beats rare
  if (chance(ULTRA_P)) return { text: choice(RESPONSES.ultra), mood: 'ultra' };
  if (chance(RARE_P))  return { text: choice(RESPONSES.rare),  mood: 'rare' };

  const r = Math.random();
  let mood = 'positive';
  if (r < WEIGHTS.positive) mood = 'positive';
  else if (r < WEIGHTS.positive + WEIGHTS.neutral) mood = 'neutral';
  else mood = 'negative';
  return { text: choice(RESPONSES[mood]), mood };
}

const COLORS = {
  positive: 0x2ECC71, // green
  neutral:  0xF1C40F, // yellow
  negative: 0xE74C3C, // red
  rare:     0x9B59B6, // purple
  ultra:    0x00FFFF, // cyan
};

const THUMB = {
  positive: 'https://i.imgur.com/9m8o3qZ.gif', // sparkle yes
  neutral:  'https://i.imgur.com/1zjH2yY.gif', // thinking orb
  negative: 'https://i.imgur.com/2w1yQ6x.gif', // ominous smoke
  rare:     'https://i.imgur.com/3a2q0mY.gif', // swirling galaxy
  ultra:    'https://i.imgur.com/9pJ6yQW.gif', // cosmic flash
};

// ---------- command ----------
module.exports = {
  name: '8ball',
  description: 'Consult the Mystic Orb for answers!',
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Ask the Mystic Orb a question')
    .addStringOption(option =>
      option.setName('question')
        .setDescription('Your question for the Mystic Orb')
        .setRequired(true)
    ),

  async execute(interaction) {
    const rawQ = interaction.options.getString('question');
    const question = normalizeQuestion(rawQ);
    const { text: answer, mood } = drawAnswer();

    const color = COLORS[mood] || 0x6A0DAD;
    const thumb = THUMB[mood];

    const title =
      mood === 'ultra' ? '🔮 Mystic Orb — Omen of Fate'
      : mood === 'rare' ? '🔮 Mystic Orb — Rare Whisper'
      : '🔮 Mystic Orb speaks';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(
        [
          `❓ **${question}**`,
          '',
          `💬 **${answer}**`
        ].join('\n')
      )
      .setColor(color)
      .setThumbnail(thumb)
      .setFooter({
        text: `${interaction.user.username} • /8ball`,
        iconURL: interaction.user.displayAvatarURL({ forceStatic: false, size: 128 })
      })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};
