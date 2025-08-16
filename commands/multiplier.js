// commands/multiplier.js
// Admin-only multipliers manager (view / set / remove)
// - Uses isAdmin helper (ID allowlist / owner override)
// - Pretty embeds, safe validation, MessageFlags (no deprecated ephemeral)

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');
const { isAdmin } = require('../utils/adminAuth');

const COLOR = {
  RED:   0xED4245,
  GREEN: 0x57F287,
  GOLD:  0xF1C40F,
  AQUA:  0x1ABC9C,
  YELLOW:0xF59E0B,
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round2 = (v) => Math.round(v * 100) / 100;
const fmtMult = (v) => `x${round2(Number(v ?? 1)).toFixed(2)}`;

module.exports = {
  name: 'multiplier',
  description: 'View, set, or remove XP/coin multipliers (admin only)',
  data: new SlashCommandBuilder()
    .setName('multiplier')
    .setDescription('View, set, or remove XP/coin multipliers (admin only)')
    .setDMPermission(false)

    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View XP and coin multipliers for a user')
        .addUserOption(o =>
          o.setName('user').setDescription('User to check').setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Set XP and/or coin multiplier for a user')
        .addUserOption(o =>
          o.setName('user').setDescription('Target user').setRequired(true)
        )
        .addNumberOption(o =>
          o.setName('xpmult').setDescription('XP multiplier (e.g., 1.5)').setRequired(false)
        )
        .addNumberOption(o =>
          o.setName('coinmult').setDescription('Coin multiplier (e.g., 2.0)').setRequired(false)
        )
    )

    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove (reset) XP and coin multipliers for a user')
        .addUserOption(o =>
          o.setName('user').setDescription('User to reset').setRequired(true)
        )
    ),

  async execute(interaction, db) {
    try {
      // --- admin gate ---
      const callerId = interaction.user.id;
      const ownerId  = interaction.guild?.ownerId ?? null;
      if (!isAdmin(callerId, ownerId)) {
        const deny = new EmbedBuilder()
          .setColor(COLOR.RED)
          .setTitle('Unauthorized')
          .setDescription('🚫 You are not authorized to use this command.')
          .setTimestamp();
        return interaction.reply({ embeds: [deny], flags: MessageFlags.Ephemeral });
      }

      const sub    = interaction.options.getSubcommand();
      const target = interaction.options.getUser('user');

      if (!target) {
        const warn = new EmbedBuilder()
          .setColor(COLOR.YELLOW)
          .setTitle('Invalid User')
          .setDescription('⚠️ Please provide a valid user.')
          .setTimestamp();
        return interaction.reply({ embeds: [warn], flags: MessageFlags.Ephemeral });
      }

      // Ensure DB row exists
      await initUser(target);

      if (sub === 'view') {
        const res = await db.query(
          'SELECT xp_multiplier, coin_multiplier FROM users WHERE user_id = $1',
          [target.id]
        );
        const row  = res.rows[0] || {};
        const xp   = Number(row.xp_multiplier ?? 1);
        const coin = Number(row.coin_multiplier ?? 1);

        const embed = new EmbedBuilder()
          .setColor(COLOR.GOLD)
          .setTitle(`Multipliers for ${target.username}`)
          .setThumbnail(target.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: '⭐ XP Multiplier', value: fmtMult(xp), inline: true },
            { name: '💰 Coin Multiplier', value: fmtMult(coin), inline: true }
          )
          .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
          .setTimestamp();

        if (round2(xp) === 1 && round2(coin) === 1) {
          embed.setDescription(`${target.username} has no custom multipliers.`);
        }

        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'set') {
        // #คอมเมนต์(TH): จำกัดช่วงเพื่อกันค่าพิลึก เช่น 0 หรือ 9999 (ปรับได้ตามเหมาะสม)
        const MIN = 0.1;
        const MAX = 10.0;

        let xpMultInput   = interaction.options.getNumber('xpmult');     // may be null
        let coinMultInput = interaction.options.getNumber('coinmult');   // may be null

        if (xpMultInput === null && coinMultInput === null) {
          const err = new EmbedBuilder()
            .setColor(COLOR.YELLOW)
            .setTitle('Nothing to Update')
            .setDescription('❌ Provide at least one multiplier to set (`xpmult` and/or `coinmult`).')
            .setTimestamp();
          return interaction.reply({ embeds: [err], flags: MessageFlags.Ephemeral });
        }

        if (xpMultInput !== null) {
          if (!isFinite(xpMultInput) || xpMultInput <= 0) {
            const err = new EmbedBuilder().setColor(COLOR.YELLOW).setTitle('Invalid XP Multiplier').setDescription('⚠️ XP multiplier must be greater than 0.').setTimestamp();
            return interaction.reply({ embeds: [err], flags: MessageFlags.Ephemeral });
          }
          xpMultInput = round2(clamp(xpMultInput, MIN, MAX));
        }

        if (coinMultInput !== null) {
          if (!isFinite(coinMultInput) || coinMultInput <= 0) {
            const err = new EmbedBuilder().setColor(COLOR.YELLOW).setTitle('Invalid Coin Multiplier').setDescription('⚠️ Coin multiplier must be greater than 0.').setTimestamp();
            return interaction.reply({ embeds: [err], flags: MessageFlags.Ephemeral });
          }
          coinMultInput = round2(clamp(coinMultInput, MIN, MAX));
        }

        await db.query(
          `UPDATE users
             SET xp_multiplier   = COALESCE($1, xp_multiplier),
                 coin_multiplier = COALESCE($2, coin_multiplier)
           WHERE user_id = $3`,
          [xpMultInput, coinMultInput, target.id]
        );

        const res2 = await db.query(
          'SELECT xp_multiplier, coin_multiplier FROM users WHERE user_id = $1',
          [target.id]
        );
        const updated = res2.rows[0] || { xp_multiplier: 1, coin_multiplier: 1 };

        const embed = new EmbedBuilder()
          .setColor(COLOR.GREEN)
          .setTitle('Multipliers Updated')
          .setDescription(`✅ Updated **${target.username}**`)
          .setThumbnail(target.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: '⭐ XP Multiplier', value: fmtMult(updated.xp_multiplier), inline: true },
            { name: '💰 Coin Multiplier', value: fmtMult(updated.coin_multiplier), inline: true }
          )
          .setFooter({ text: `Changed by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'remove') {
        await db.query(
          'UPDATE users SET xp_multiplier = 1, coin_multiplier = 1 WHERE user_id = $1',
          [target.id]
        );

        const embed = new EmbedBuilder()
          .setColor(COLOR.AQUA)
          .setTitle('Multipliers Reset')
          .setDescription(`🗑️ Removed custom multipliers for **${target.username}**.`)
          .addFields(
            { name: '⭐ XP Multiplier', value: 'x1.00', inline: true },
            { name: '💰 Coin Multiplier', value: 'x1.00', inline: true }
          )
          .setFooter({ text: `Changed by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      const unknown = new EmbedBuilder()
        .setColor(COLOR.YELLOW)
        .setTitle('Unknown Subcommand')
        .setDescription('⚠️ Try `view`, `set`, or `remove`.')
        .setTimestamp();
      return interaction.reply({ embeds: [unknown], flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('multiplier error:', err);
      const embed = new EmbedBuilder()
        .setColor(COLOR.RED)
        .setTitle('Unexpected Error')
        .setDescription('⚠️ Something went wrong while processing your request.')
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
};
