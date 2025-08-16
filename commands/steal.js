// commands/steal.js
// Refactored Steal Command (atomic, item-aware)
// Description (EN): Attempt to steal coins from another user (base 30% success).
// Uses a single DB transaction with SELECT ... FOR UPDATE to avoid race conditions.
// Item effects:
//   - Gloves: +5% success chance (max 1), not consumed
//   - Silent Boots: halves fine on failure (max 1), not consumed
// Cooldown: 7 minutes. On failure, a small portion compensates the victim and the rest goes to the tax vault.
//
// #คอมเมนต์เป็นภาษาไทยเพื่ออธิบายโค้ด

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');
const { depositTax } = require('../utils/taxUtils');

const COOLDOWN_MS   = 7 * 60 * 1000; // 7 นาที
const BASE_SUCCESS  = 0.30;          // โอกาสสำเร็จพื้นฐาน
const GLOVES_BONUS  = 0.05;          // Gloves ให้โบนัส +5%
const MAX_STEAL_PCT = 0.70;          // ขอปล้นสูงสุด 70% ของเงินเหยื่อ

// ตารางค่าปรับแบบสุ่มถ่วงน้ำหนัก (คิดจาก "จำนวนที่พยายามปล้น")
const FINE_BRACKETS = [
  { chance: 0.50, percent: 0.055 },
  { chance: 0.30, percent: 0.10  },
  { chance: 0.15, percent: 0.15  },
  { chance: 0.05, percent: 0.20  },
];

const COLORS = {
  GREEN: 0x22c55e,
  RED:   0xef4444,
  ORANGE:0xf59e0b,
};

function fmt(n) {
  return new Intl.NumberFormat().format(Number(n || 0));
}

// เลือกเปอร์เซ็นต์ค่าปรับแบบสุ่มตาม weight
function pickFinePercent() {
  const r = Math.random();
  let acc = 0;
  for (const f of FINE_BRACKETS) {
    acc += f.chance;
    if (r < acc) return f.percent;
  }
  return FINE_BRACKETS[FINE_BRACKETS.length - 1].percent;
}

module.exports = {
  name: 'steal',
  description: 'Try to steal coins from another user (base 30% success chance)',
  data: new SlashCommandBuilder()
    .setName('steal')
    .setDescription('Attempt to steal coins from another user')
    .addUserOption(option =>
      option.setName('target')
        .setDescription('User you want to steal from')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of coins to attempt stealing')
        .setRequired(true)),

  // ใช้รูปแบบ execute(interaction, db) เพื่อเข้ากับโค้ดโปรเจ็กต์ของคุณ
  async execute(interaction, db) {
    const thiefUser  = interaction.user;
    const thiefId    = thiefUser.id;
    const targetUser = interaction.options.getUser('target');
    const targetId   = targetUser?.id;
    let requested    = interaction.options.getInteger('amount') || 0;
    const now        = Date.now();

    // Guard พื้นฐาน
    if (!targetId || targetUser.bot) {
      return interaction.reply({ content: '❌ Invalid target (cannot steal from bots).', flags: MessageFlags.Ephemeral });
    }
    if (thiefId === targetId) {
      return interaction.reply({ content: '❌ You cannot steal from yourself.', flags: MessageFlags.Ephemeral });
    }
    if (requested <= 0) {
      return interaction.reply({ content: '❌ Amount must be greater than 0.', flags: MessageFlags.Ephemeral });
    }

    // ให้แน่ใจว่ามี row ทั้งคู่ (ส่ง db เข้าไปด้วย)
    await initUser(thiefUser, db);
    await initUser(targetUser, db);

    let result;

    // ทำงานแบบอะตอมมิกในทรานแซกชัน
    await db.query('BEGIN');
    try {
      // ล็อกทั้ง 2 แถวด้วย FOR UPDATE (เรียงตาม user_id เพื่อกัน deadlock)
      const firstId  = thiefId < targetId ? thiefId : targetId;
      const secondId = thiefId < targetId ? targetId : thiefId;

      const { rows: r1 } = await db.query(
        `SELECT user_id, money, last_steal, items FROM users WHERE user_id = $1 FOR UPDATE`,
        [firstId]
      );
      const { rows: r2 } = await db.query(
        `SELECT user_id, money, last_steal, items FROM users WHERE user_id = $1 FOR UPDATE`,
        [secondId]
      );

      const rowA = r1[0];
      const rowB = r2[0];

      // จับคู่ให้ถูกฝั่ง
      const thief  = (rowA.user_id === thiefId) ? rowA : rowB;
      const victim = (rowA.user_id === targetId) ? rowA : rowB;

      // เช็คคูลดาวน์
      const last = Number(thief.last_steal || 0);
      if (last && now - last < COOLDOWN_MS) {
        const next = last + COOLDOWN_MS;
        await db.query('ROLLBACK');
        const embed = new EmbedBuilder()
          .setTitle('⏳ Cooldown Active')
          .setColor(COLORS.ORANGE)
          .setDescription(`Try again <t:${Math.floor(next / 1000)}:R>.`)
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      // จำกัดจำนวนสูงสุดตาม % ของเงินเหยื่อ
      const victimMoney = Number(victim.money || 0);
      const maxAllowed  = Math.floor(victimMoney * MAX_STEAL_PCT);
      const amount      = Math.max(0, Math.min(requested, maxAllowed));

      if (amount <= 0 || victimMoney <= 0) {
        await db.query('ROLLBACK');
        return interaction.reply({
          content: `❌ ${targetUser.username} doesn't have enough coins to be stolen from right now.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // ผลของไอเท็ม (ไม่ถูก consume)
      const gloves = Math.min(1, Number((thief.items?.gloves) || 0));
      const boots  = Math.min(1, Number((thief.items?.boots)  || 0));

      const successChance = Math.min(0.95, BASE_SUCCESS + gloves * GLOVES_BONUS);
      const success = Math.random() < successChance;

      if (success) {
        // สำเร็จ: โอนเงินจากเหยื่อ → โจร + เซ็ตคูลดาวน์
        const taken = Math.min(amount, victimMoney);

        await db.query(
          `UPDATE users
           SET money = money + $1, last_steal = $3
           WHERE user_id = $2`,
          [taken, thiefId, now]
        );
        await db.query(
          `UPDATE users
           SET money = GREATEST(money - $1, 0)
           WHERE user_id = $2`,
          [taken, targetId]
        );

        result = { type: 'success', taken };
      } else {
        // ล้มเหลว: ค่าปรับขึ้นกับจำนวนที่ "พยายามปล้น" และ Boots ลด 50% (ไม่ถูก consume)
        const finePct = pickFinePercent();
        let fine = Math.floor(amount * finePct);
        if (boots) fine = Math.floor(fine / 2);

        // ค่าปรับไม่เกินเงินที่โจรมีจริง
        const thiefMoney = Number(thief.money || 0);
        fine = Math.min(fine, thiefMoney);

        // แบ่งชดเชยเหยื่อ 2% ที่เหลือเข้าคลังภาษี
        const victimComp   = Math.floor(fine * 0.02);
        const vaultPortion = Math.max(0, fine - victimComp);

        await db.query(
          `UPDATE users
           SET money = GREATEST(money - $1, 0), last_steal = $3
           WHERE user_id = $2`,
          [fine, thiefId, now]
        );
        if (victimComp > 0) {
          await db.query(
            `UPDATE users SET money = money + $1 WHERE user_id = $2`,
            [victimComp, targetId]
          );
        }

        result = { type: 'fail', fine, victimComp, vaultPortion, bootsApplied: !!boots };
      }

      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      console.error('steal error:', e);
      return interaction.reply({ content: '⚠️ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    // ฝากภาษีหลังคอมมิต (ผลข้างเคียง non-critical) — ส่ง db ไปด้วย
    if (result?.type === 'fail' && result.vaultPortion > 0) {
      try { await depositTax(result.vaultPortion, db); } catch {}
    }

    // ตอบกลับผู้ใช้
    if (result?.type === 'success') {
      const embed = new EmbedBuilder()
        .setTitle('🕵️ Success!')
        .setColor(COLORS.GREEN)
        .setDescription(
          `You successfully stole **${fmt(result.taken)}** coins from **${targetUser.username}**.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    } else {
      const parts = [
        `You were caught trying to steal from **${targetUser.username}**.`,
        `💸 Fine: **${fmt(result.fine)}** coins.`,
        result.victimComp > 0
          ? `🤝 Compensation to victim: **${fmt(result.victimComp)}** coins.`
          : `🤝 No compensation to the victim.`,
        result.bootsApplied ? '🥾 Silent Boots reduced your fine by 50%.' : '',
      ].filter(Boolean);

      const embed = new EmbedBuilder()
        .setTitle('🚨 Failed!')
        .setColor(COLORS.RED)
        .setDescription(parts.join('\n'))
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }
  },
};
