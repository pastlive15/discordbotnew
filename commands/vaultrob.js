// commands/vaultrob.js
// High-risk robbery of the bot's vault (atomic + item-aware)
// Description (EN): Attempt a high-risk robbery of the bot’s vault. Success steals a % of the tax vault;
// failure fines you and sends the fine back to the vault. Master Key doubles payout once; Silent Boots halves fines.
// - Uses taxUtils (getVaultBalance / withdrawFromVault / depositTax) to avoid race conditions
// - 1h cooldown
//
// #คอมเมนต์(TH):
// - ทำงานกับฐานข้อมูลแบบอะตอมโดยให้ taxUtils จัดการยอดของ Vault เพื่อลด race
// - ใช้ SELECT/UPDATE ฝั่งผู้เล่นเฉพาะจุดที่จำเป็น
// - ป้องกันเคส edge หลายจุด (เช่น net 0, vault ไม่พอ ฯลฯ)

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');
const {
  getVaultBalance,
  withdrawFromVault,
  depositTax,
} = require('../utils/taxUtils');

// Optional runtime toggle (from messageCreate). Falls back to false if missing.
let isBigHeistActive = () => false;
try {
  ({ isBigHeistActive } = require('../events/messageCreate'));
} catch {}

const COOLDOWN_MS = 60 * 60 * 1000;     // 1 hour
const MIN_VAULT_TO_ATTEMPT = 10_000;    // don't allow runs when vault is trivial

const COLORS = {
  GOLD:   0xf1c40f,
  RED:    0xed4245,
  ORANGE: 0xf59e0b,
  GRAY:   0x99aab5,
};

const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

module.exports = {
  name: 'vaultrob',
  description: "Attempt to rob the bot's tax vault (extremely risky)",
  data: new SlashCommandBuilder()
    .setName('vaultrob')
    .setDescription("Attempt a high-risk robbery of the bot's vault"),

  async execute(interaction, db) {
    const userId = interaction.user.id;
    const now = Date.now();

    // Ensure user row exists
    const user = await initUser(interaction.user);
    if (!user) {
      return interaction.reply({
        content: '⚠️ Could not initialize your profile. Please try again.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Cooldown
    const last = Number(user.last_vaultrob || 0);
    if (last && now - last < COOLDOWN_MS) {
      const next = Math.floor((last + COOLDOWN_MS) / 1000);
      const embed = new EmbedBuilder()
        .setTitle('⏳ Cooldown Active')
        .setColor(COLORS.ORANGE)
        .setDescription(`You must wait <t:${next}:R> before trying again.`)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // Check vault snapshot (authoritative via taxUtils)
    const vaultBefore = await getVaultBalance();
    if (vaultBefore < MIN_VAULT_TO_ATTEMPT) {
      const embed = new EmbedBuilder()
        .setTitle('🏦 Vault Empty')
        .setColor(COLORS.GRAY)
        .setDescription('The vault is nearly empty — nothing worth stealing!')
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // Event-aware odds
    const big = !!isBigHeistActive();
    const successChance = big ? 0.09 : 0.03;
    const rewardMinPct = big ? 0.20 : 0.10;
    const rewardMaxPct = big ? 0.30 : 0.15;

    const roll = Math.random();
    const hasKey = Number(user.items?.key || 0) > 0;
    const hasBoots = Number(user.items?.boots || 0) > 0;

    if (roll < successChance) {
      // SUCCESS
      const basePct = rewardMinPct + Math.random() * (rewardMaxPct - rewardMinPct);
      const multiplier = hasKey ? 2 : 1;
      const desired = Math.max(1, Math.floor(vaultBefore * basePct * multiplier)); // at least 1

      // Atomically withdraw from vault (caps to available)
      const { withdrawn, remaining } = await withdrawFromVault(desired);
      const gained = Number(withdrawn || 0);

      // Consume 1 Master Key if it actually helped (i.e., we stole > 0)
      if (hasKey && gained > 0) {
        await db.query(
          `
          UPDATE users
          SET items = jsonb_set(
            COALESCE(items,'{}'::jsonb),
            '{key}',
            TO_JSONB(GREATEST(COALESCE((items->>'key')::int,0) - 1, 0)),
            true
          )
          WHERE user_id = $1
          `,
          [userId]
        );
      }

      // Credit user & set cooldown timestamp
      await db.query(
        `UPDATE users SET money = money + $1, last_vaultrob = $2 WHERE user_id = $3`,
        [gained, now, userId]
      );

      const pctShown = ((gained / Math.max(vaultBefore, 1)) * 100).toFixed(2);
      const embed = new EmbedBuilder()
        .setTitle('💰 Vault Robbery Successful!')
        .setColor(COLORS.GOLD)
        .setDescription(
          `You pulled off the impossible and stole **${fmt(gained)}** coins (~${pctShown}%) from the bot's vault!` +
          (hasKey && gained > 0 ? `\n\n🔓 Your Master Key was consumed.` : '')
        )
        .addFields(
          { name: 'Vault Before', value: `${fmt(vaultBefore)} coins`, inline: true },
          { name: 'Vault Now',    value: `${fmt(remaining)} coins`,   inline: true },
          { name: 'Next Attempt', value: 'in 1 hour',                 inline: true },
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    // FAIL
    const wallet = Number(user.money || 0);
    const rawFine = Math.floor(wallet * 0.15);
    const fine = Math.min(wallet, hasBoots ? Math.floor(rawFine / 2) : rawFine);

    // Deduct fine & set cooldown (no negative)
    await db.query(
      `UPDATE users SET money = GREATEST(money - $1, 0), last_vaultrob = $2 WHERE user_id = $3`,
      [fine, now, userId]
    );

    // Send fine to tax vault (non-user balance)
    if (fine > 0) await depositTax(fine);

    const embed = new EmbedBuilder()
      .setTitle('🚨 Vault Robbery Failed!')
      .setColor(COLORS.RED)
      .setDescription(
        `You were caught trying to rob the bot's vault.\n\n` +
        `💸 You lost **${fmt(fine)}** coins in fines.` +
        (hasBoots ? `\n🥾 Silent Boots reduced the fine by **50%**.` : '')
      )
      .addFields(
        { name: 'Vault snapshot', value: `${fmt(vaultBefore)} coins`, inline: true },
        { name: 'Next Attempt',   value: 'in 1 hour',                 inline: true },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
