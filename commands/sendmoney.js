// commands/sendmoney.js
// Send Money (atomic, BIGINT-safe, bank-cap aware)
// Description (EN): Transfer coins to another user with a fixed-point tax, using a single DB transaction.
// - Uses BigInt for all arithmetic to avoid float errors
// - Fixed tax rate (floor), configurable via TAX_NUM/TAX_DEN
// - Honors recipient bank capacity (recomputes gross so the *net* fits the bank)
// - Fully atomic with SELECT ... FOR UPDATE to prevent race conditions
//
// #คอมเมนต์ภาษาไทย: โค้ดนี้คำนวณทุกอย่างในทรานแซกชันเดียว ปลอดภัยจากการส่งซ้ำ/กดแข่งกัน
// #และใช้ BigInt เพื่อป้องกันความผิดพลาดจากทศนิยมแบบ float ของ JS

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');
const { depositTax } = require('../utils/taxUtils');

// --- Fixed-point tax (e.g., 0.00132 = 132 / 100000) ---
const TAX_NUM = 132n;      // numerator
const TAX_DEN = 100000n;   // denominator

// ---------- helpers ----------
const toBigIntSafe = (v, def = 0n) => {
  if (v === null || v === undefined) return def;
  try { return BigInt(v); } catch { return def; }
};
const ceilDiv = (a, b) => (a + b - 1n) / b; // ปัดขึ้น (BigInt)
const fmt = (n) => new Intl.NumberFormat().format(Number(n)); // ใส่คอมม่าให้อ่านง่าย

// คำนวณภาษีแบบปัดลง: floor(gross * rate)
const computeTax = (gross) => (gross * TAX_NUM) / TAX_DEN;

// อยากให้ "net หลังหักภาษี" = desiredNet → หา gross ขั้นต่ำที่ต้องหักจากผู้ส่ง
const grossFromNet = (desiredNet) => {
  const keepDen = TAX_DEN - TAX_NUM; // สัดส่วนที่เหลือหลังหักภาษี
  return ceilDiv(desiredNet * TAX_DEN, keepDen);
};

module.exports = {
  name: 'sendmoney',
  description: 'Send coins to another user',
  data: new SlashCommandBuilder()
    .setName('sendmoney')
    .setDescription('Transfer coins to another user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Recipient')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('amount')
        .setDescription('Amount to send (or `all`)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('from')
        .setDescription('Source wallet')
        .addChoices(
          { name: 'Money', value: 'money' },
          { name: 'Bank',  value: 'bank'  },
        ))
    .addStringOption(option =>
      option.setName('to')
        .setDescription('Destination wallet')
        .addChoices(
          { name: 'Money', value: 'money' },
          { name: 'Bank',  value: 'bank'  },
        )),

  // execute(interaction, db) — ให้เข้ากับโปรเจ็กต์เดิม
  async execute(interaction, db) {
    try {
      const senderUser = interaction.user;
      const senderId   = senderUser.id;
      const recipient  = interaction.options.getUser('user');
      const rawAmount  = (interaction.options.getString('amount') || '').trim();
      const source     = (interaction.options.getString('from') || 'money').toLowerCase();
      const dest       = (interaction.options.getString('to')   || 'money').toLowerCase();

      // --- validation เบื้องต้น ---
      if (!recipient || recipient.bot) {
        return interaction.reply({ content: '🤖 You cannot send money to a bot.', flags: MessageFlags.Ephemeral });
      }
      if (recipient.id === senderId) {
        return interaction.reply({ content: '❌ You cannot send money to yourself.', flags: MessageFlags.Ephemeral });
      }
      if (!['money', 'bank'].includes(source) || !['money', 'bank'].includes(dest)) {
        return interaction.reply({ content: '⚠️ Invalid source/destination. Choose `money` or `bank`.', flags: MessageFlags.Ephemeral });
      }

      // สร้าง row ถ้ายังไม่มี (นอกทรานแซกชันได้ เพราะเป็น upsert ครั้งแรก)
      await initUser(senderUser);
      await initUser(recipient);

      // --- เริ่มทรานแซกชันแบบอะตอมมิก ---
      await db.query('BEGIN');

      // ล็อกทั้งสองฝั่งแบบ SELECT ... FOR UPDATE (เรียง id เพื่อกัน deadlock)
      const firstId  = senderId < recipient.id ? senderId : recipient.id;
      const secondId = senderId < recipient.id ? recipient.id : senderId;

      const { rows: r1 } = await db.query(
        `SELECT user_id, username, money, bank, bank_limit FROM users WHERE user_id = $1 FOR UPDATE`,
        [firstId]
      );
      const { rows: r2 } = await db.query(
        `SELECT user_id, username, money, bank, bank_limit FROM users WHERE user_id = $1 FOR UPDATE`,
        [secondId]
      );
      const rowA = r1[0], rowB = r2[0];
      const sender   = rowA.user_id === senderId ? rowA : rowB;
      const receiver = rowA.user_id === recipient.id ? rowA : rowB;

      // แปลงยอดคงเหลือเป็น BigInt
      const senderBalance    = toBigIntSafe(sender[source]);
      const receiverBalance  = toBigIntSafe(receiver[dest]);
      const receiverBank     = toBigIntSafe(receiver.bank);
      const receiverBankCap  = toBigIntSafe(receiver.bank_limit, 200000n);

      // parse amount
      let requested;
      if (rawAmount.toLowerCase() === 'all') {
        requested = senderBalance;
      } else {
        if (!/^\d+$/.test(rawAmount)) {
          await db.query('ROLLBACK');
          return interaction.reply({ content: '⚠️ Enter a whole number or `all`.', flags: MessageFlags.Ephemeral });
        }
        requested = toBigIntSafe(rawAmount);
      }

      if (requested <= 0n) {
        await db.query('ROLLBACK');
        return interaction.reply({ content: '⚠️ Amount must be greater than 0.', flags: MessageFlags.Ephemeral });
      }
      if (senderBalance < requested) {
        await db.query('ROLLBACK');
        return interaction.reply({ content: `🚫 You do not have enough coins in your ${source}.`, flags: MessageFlags.Ephemeral });
      }

      // คำนวณภาษี/ยอดรับสุทธิ (เริ่มต้นจาก gross = requested)
      let gross = requested;               // หักจากผู้ส่งเท่านี้
      let tax   = computeTax(gross);       // floor
      let net   = gross - tax;             // ผู้รับได้เท่านี้

      // ป้องกันกรณีส่งน้อยจนหลังหักภาษีเหลือ 0
      if (net <= 0n) {
        await db.query('ROLLBACK');
        return interaction.reply({ content: '⚠️ Amount is too small after tax. Try a larger amount.', flags: MessageFlags.Ephemeral });
      }

      // ถ้าปลายทางเป็น bank → ต้องไม่เกินเพดาน (เติมต่อได้สูงสุด availableSpace)
      if (dest === 'bank') {
        const space = receiverBankCap - receiverBank;
        if (space <= 0n) {
          await db.query('ROLLBACK');
          return interaction.reply({ content: `🏦 ${recipient.username}'s bank is full.`, flags: MessageFlags.Ephemeral });
        }
        if (net > space) {
          // ต้องส่ง net ให้เท่ากับ space → คำนวณ gross ใหม่
          net   = space;
          gross = grossFromNet(net);
          tax   = computeTax(gross);
          let recalculatedNet = gross - tax;

          // กัน edge case ปัดลงจน net > space (มากสุด +1)
          if (recalculatedNet > space) {
            gross -= 1n;
            tax = computeTax(gross);
            recalculatedNet = gross - tax;
          }
          net = recalculatedNet;

          if (net <= 0n) {
            await db.query('ROLLBACK');
            return interaction.reply({ content: '⚠️ After bank-cap adjustment, net would be 0. Try a smaller amount.', flags: MessageFlags.Ephemeral });
          }
          if (senderBalance < gross) {
            await db.query('ROLLBACK');
            return interaction.reply({ content: '🚫 You cannot cover transfer + tax after bank cap adjustment.', flags: MessageFlags.Ephemeral });
          }
        }
      }

      // อัปเดตยอดในฐานข้อมูล (สองฝั่ง)
      const newSenderAmt   = senderBalance - gross;
      const newReceiverAmt = receiverBalance + net;

      await db.query(`UPDATE users SET ${source} = $1 WHERE user_id = $2`, [String(newSenderAmt), senderId]);
      await db.query(`UPDATE users SET ${dest}   = $1 WHERE user_id = $2`, [String(newReceiverAmt), recipient.id]);

      // ปิดทรานแซกชันก่อนเรียก depositTax (ลดความเสี่ยงเรื่อง nested tx)
      await db.query('COMMIT');

      // ฝากภาษีเข้า vault แยก (non-critical side effect)
      if (tax > 0n) {
        try { await depositTax(Number(tax)); } catch {}
      }

      // สร้าง embed ตอบกลับ
      const embed = new EmbedBuilder()
        .setTitle('✅ Money Sent')
        .setColor(0x22c55e)
        .setDescription(
          `**${sender.username || interaction.user.username}** sent **${fmt(gross)}** coins from **${source}** to **${recipient.username}**’s **${dest}**.\n` +
          `💸 **Tax:** ${fmt(tax)}\n` +
          `📥 **Received:** ${fmt(net)}`
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });

    } catch (err) {
      console.error('sendmoney error:', err);
      try { await db.query('ROLLBACK'); } catch {}
      return interaction.reply({ content: '⚠️ Something went wrong while processing your transfer.', flags: MessageFlags.Ephemeral });
    }
  },
};
