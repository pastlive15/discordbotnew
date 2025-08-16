// commands/daily.js
// PostgreSQL-safe Daily Reward (hardened)
// - Uses ms timestamps
// - Atomic UPDATE ... RETURNING
// - Graceful handling when initUser fails
// - Uses MessageFlags (no deprecated ephemeral)

const { EmbedBuilder, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = {
  AQUA: 0x00BCD4,
  RED: 0xEF4444,
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

module.exports = {
  name: 'daily',
  description: 'Claim your daily reward',
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily reward'),

  async execute(interaction, db) {
    try {
      const userId = interaction.user.id;
      const nowMs = Date.now();

      // Ensure user exists (fresh row) — pass db to initUser
      let user = await initUser(interaction.user, db);
      if (!user) {
        const snap = await db.query('SELECT * FROM users WHERE user_id = $1', [userId]);
        user = snap.rows[0];
      }
      if (!user) {
        return interaction.reply({
          content: '⚠️ Could not initialize your profile. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const lastDaily = Number(user.last_daily || 0);
      if (lastDaily && (nowMs - lastDaily) < ONE_DAY_MS) {
        const nextSec = Math.floor((lastDaily + ONE_DAY_MS) / 1000);
        const embed = new EmbedBuilder()
          .setColor(COLORS.RED)
          .setTitle('⏳ Already Claimed')
          .setDescription(`You’ve already claimed your daily. Come back <t:${nextSec}:R>.`)
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      // ----- Reward formula -----
      const lvl = Math.max(1, Number(user.level || 1));
      const coinMin = 300 + (lvl - 1) * 20;
      const coinMax = 500 + (lvl - 1) * 30;
      const xpMin = 120 + (lvl - 1) * 10;
      const xpMax = 250 + (lvl - 1) * 15;

      let coins = Math.floor(Math.random() * (coinMax - coinMin + 1)) + coinMin;
      let xp = Math.floor(Math.random() * (xpMax - xpMin + 1)) + xpMin;

      const coinMult = Number(user.coin_multiplier ?? 1.0);
      const xpMult   = Number(user.xp_multiplier ?? 1.0);
      coins = Math.floor(coins * coinMult);
      xp    = Math.floor(xp * xpMult);

      // 2% Lucky bonus (extra +25% coins)
      let bonusLine = '';
      if (Math.random() < 0.02) {
        const bonus = Math.floor(coins * 0.25);
        coins += bonus;
        bonusLine = `\n🍀 **Lucky Bonus:** +${fmt(bonus)} coins!`;
      }

      // Atomic update
      const { rows } = await db.query(
        `UPDATE users
           SET money = money + $1,
               xp    = xp    + $2,
               last_daily = $3
         WHERE user_id = $4
         RETURNING money, xp;`,
        [coins, xp, nowMs, userId]
      );

      const updated = rows[0] || { money: (user.money || 0) + coins, xp: (user.xp || 0) + xp };

      const embed = new EmbedBuilder()
        .setTitle('<a:GreenCheck:1392201101859885137> Daily Reward Claimed!')
        .setColor(COLORS.AQUA)
        .setDescription(
          `🔓 Daily chest opened!\n\n` +
          `<a:PixelCoin:1392196932926967858> **+${fmt(coins)} coins**\n` +
          `📈 **+${fmt(xp)} XP**${bonusLine}\n\n` +
          `🏦 Total Coins: **${fmt(updated.money)}**\n` +
          `<:stars:1392200379281834084> Total XP: **${fmt(updated.xp)}**`
        )
        .setFooter({
          text: `${interaction.user.username}'s Daily Tracker`,
          iconURL: interaction.user.displayAvatarURL({ size: 128 }),
        })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error('daily error:', err);
      try { await db.query('ROLLBACK'); } catch {}
      return interaction.reply({
        content: '⚠️ Something went wrong while claiming your daily. Please try again.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  },
};
