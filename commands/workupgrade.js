// commands/work.js
// Work Minigame (smooth UX + atomic rewards + fair bonuses)
// Description (EN): Do a quick reaction minigame to earn coins and XP. Rewards scale with job_level.
// - Atomic UPDATE ... RETURNING to avoid race conditions
// - Per-interaction button token to prevent other users clicking
// - Clean UI: disables buttons after a choice or timeout
//
// #คอมเมนต์(TH):
// - รายได้สเกลตาม job_level: jobMult = 1 + (job_level * 0.12) (สอดคล้องกับที่อัปเกรดใน shop)
// - มีโบนัสสุ่มแต่ปรับโอกาส/รางวัลให้สมเหตุสมผลขึ้น
// - ป้องกันแจ้งเตือนรก: ตอบด้วย embed และ edit ข้อความเดิม

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ComponentType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = {
  GREEN: 0x22c55e,
  RED:   0xef4444,
  BLURPLE: 0x5865f2,
  YELLOW: 0xf59e0b,
};

// #คอมเมนต์(TH): ธีมงาน/อีโมจิ เลือกคำตอบจากชุดสุ่ม และสลับตำแหน่งตัวเลือกทุกครั้ง
const JOB_SCENARIOS = [
  { task: 'Sort documents',    correct: '💼', pool: ['💼', '🧠', '🧹', '📦'] },
  { task: 'Solve a logic puzzle', correct: '🧠', pool: ['💼', '🧠', '🧹', '📄'] },
  { task: 'Clean the floor',   correct: '🧹', pool: ['🧹', '📦', '🔧', '📄'] },
  { task: 'File invoices',     correct: '📄', pool: ['📄', '📦', '📊', '🧹'] },
  { task: 'Assemble widgets',  correct: '🔧', pool: ['🔧', '🔩', '🪛', '📦'] },
  { task: 'Pack boxes',        correct: '📦', pool: ['📄', '📦', '🧹', '🔧'] },
];

// #คอมเมนต์(TH): คุณสมบัติรายได้พื้นฐาน (จะคูณด้วยตัวคูณทั้งหมด)
const BASE_WIN_COINS = [150, 300]; // รวมสุ่ม (min, max)
const BASE_LOSE_COINS = [20, 60];
const BASE_WIN_XP = [40, 75];
const BASE_LOSE_XP = [5, 20];

// #คอมเมนต์(TH): โบนัสสุ่ม (น้ำหนัก/รางวัลแบบพอดี ไม่พังเศรษฐกิจ)
function rollBonus() {
  const r = Math.random();
  if (r < 0.002) { // 0.2%
    return { coins: 2500, xp: 250, note: '\n✨ **Lucky Bonus!** You found a hidden treasure chest!' };
  }
  if (r < 0.003) { // 0.1% (เพิ่มอีกชั้นเล็ก ๆ)
    return { coins: 5000, xp: 500, note: '\n🔑 **Office Jackpot!** The safe had an unclaimed envelope!' };
  }
  return { coins: 0, xp: 0, note: '' };
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// #คอมเมนต์(TH): สลับอาร์เรย์ง่าย ๆ
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fmt(n) {
  return new Intl.NumberFormat().format(Math.max(0, Number(n || 0)));
}

module.exports = {
  name: 'work',
  description: 'Do work to earn rewards through a minigame',
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('Do a work minigame to earn coins and XP'),

  async execute(interaction, db) {
    // #คอมเมนต์(TH): ให้แน่ใจว่ามีผู้ใช้ใน DB
    const user = await initUser(interaction.user);
    if (!user) {
      return interaction.reply({
        content: "❌ You don't have a profile yet. Try using /daily to start!",
        ephemeral: true,
      });
    }

    const userId = interaction.user.id;
    const jobLevel = Math.max(1, Number(user.job_level || 1));
    const coinMult = Number(user.coin_multiplier ?? 1);
    const xpMult   = Number(user.xp_multiplier   ?? 1);
    const jobMult  = 1 + jobLevel * 0.12; // สอดคล้องกับ shop ที่อัปเกรดงาน

    // สุ่มโจทย์และปุ่ม
    const scenario = JOB_SCENARIOS[Math.floor(Math.random() * JOB_SCENARIOS.length)];
    const options = shuffle(Array.from(new Set(scenario.pool))).slice(0, 3);
    if (!options.includes(scenario.correct)) {
      options[0] = scenario.correct; // กันพลาด
      shuffle(options);
    }

    // token กันกดข้ามยูส/กัน replay
    const token = Math.random().toString(36).slice(2, 10);
    const row = new ActionRowBuilder().addComponents(
      options.map((emoji) =>
        new ButtonBuilder()
          .setCustomId(`work_${token}_${emoji}`)
          .setLabel(emoji)
          .setStyle(ButtonStyle.Secondary)
      )
    );

    const game = new EmbedBuilder()
      .setTitle('🛠️ Work Minigame')
      .setDescription(`**Task:** ${scenario.task}\nChoose the correct emoji to complete your job!`)
      .setColor(COLORS.BLURPLE)
      .setFooter({
        text: 'You have 10 seconds to choose.',
        iconURL: interaction.client.user.displayAvatarURL({ forceStatic: false }),
      })
      .setTimestamp();

    await interaction.reply({ embeds: [game], components: [row] });

    const filter = (i) =>
      i.user.id === userId &&
      typeof i.customId === 'string' &&
      i.customId.startsWith(`work_${token}_`);

    const collector = interaction.channel.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 10_000,
      max: 1,
      filter,
    });

    collector.on('collect', async (i) => {
      const chosenEmoji = i.customId.split('_').pop();
      const isCorrect = chosenEmoji === scenario.correct;

      // คำนวณรายได้พื้นฐาน + โบนัส
      const [coinMin, coinMax] = isCorrect ? BASE_WIN_COINS : BASE_LOSE_COINS;
      const [xpMin, xpMax]     = isCorrect ? BASE_WIN_XP    : BASE_LOSE_XP;
      const baseCoins = randInt(coinMin, coinMax);
      const baseXP    = randInt(xpMin, xpMax);

      // โบนัสสุ่ม (เล็กน้อย)
      const bonus = rollBonus();

      // รวมตัวคูณทั้งหมด
      const coinsEarned = Math.floor(baseCoins * jobMult * coinMult) + bonus.coins;
      const xpEarned    = Math.floor(baseXP * jobMult * xpMult)     + bonus.xp;

      // อัปเดตแบบอะตอมมิก
      let updated;
      try {
        const { rows } = await db.query(
          `UPDATE users
             SET money = money + $1,
                 xp    = xp    + $2
           WHERE user_id = $3
           RETURNING money, xp`,
          [coinsEarned, xpEarned, userId]
        );
        updated = rows[0] || { money: Number(user.money) + coinsEarned, xp: Number(user.xp) + xpEarned };
      } catch (e) {
        console.error('work update error:', e);
      }

      const result = new EmbedBuilder()
        .setTitle(isCorrect ? '✅ Task Completed!' : '❌ Task Failed')
        .setDescription(
          `**Task:** ${scenario.task}\n` +
          (isCorrect
            ? `You earned **${fmt(coinsEarned)} coins** and **${fmt(xpEarned)} XP**.`
            : `You failed and still earned **${fmt(coinsEarned)} coins** and **${fmt(xpEarned)} XP**.`) +
          (bonus.note || '')
        )
        .addFields(
          { name: 'Job Multiplier', value: `x${(jobMult).toFixed(2)}`, inline: true },
          { name: 'XP Multiplier', value: `x${(xpMult).toFixed(2)}`, inline: true },
          { name: 'Coin Multiplier', value: `x${(coinMult).toFixed(2)}`, inline: true },
        )
        .setColor(isCorrect ? COLORS.GREEN : COLORS.RED)
        .setFooter({ text: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ forceStatic: false }) })
        .setTimestamp();

      // ปิดปุ่มหลังตอบ
      const disabledRow = new ActionRowBuilder().addComponents(
        options.map((emoji) =>
          new ButtonBuilder()
            .setCustomId(`work_${token}_${emoji}`)
            .setLabel(emoji)
            .setStyle(emoji === scenario.correct ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );

      try {
        await i.update({ embeds: [result], components: [disabledRow] });
      } catch (e) {
        // เผื่อโดน edit ไปแล้ว
        try {
          await interaction.editReply({ embeds: [result], components: [disabledRow] });
        } catch {}
      }
    });

    collector.on('end', async (collected) => {
      if (collected.size === 0) {
        // หมดเวลา: ปิดปุ่มและแจ้งเตือน
        const timeout = new EmbedBuilder()
          .setColor(COLORS.YELLOW)
          .setTitle('⏰ Time’s Up!')
          .setDescription('You took too long! No rewards earned.')
          .setTimestamp();

        const disabledRow = new ActionRowBuilder().addComponents(
          options.map((emoji) =>
            new ButtonBuilder()
              .setCustomId(`work_${token}_${emoji}`)
              .setLabel(emoji)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true)
          )
        );

        try {
          await interaction.editReply({ embeds: [timeout], components: [disabledRow] });
        } catch {}
      }
    });
  },
};
