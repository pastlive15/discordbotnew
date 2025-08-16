// commands/bank.js
// PostgreSQL-compatible Bank Command (polished)
// - Amount parser supports: "all", "half", "25%", "10k", "2.5m", plain numbers
// - Atomic UPDATE ... RETURNING to avoid race conditions
// - Respects bank_limit, clean embeds, MessageFlags (no deprecated ephemeral)

// #คอมเมนต์(TH): โค้ดนี้ทำงานแบบอะตอมมิก ป้องกันกดพร้อมกัน, พาร์สจำนวนใช้ง่าย, และตอบกลับเป็นอังกฤษ

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');

// ---------- helpers ----------
const COLORS = {
  BLUE: 0x3b82f6,
  GREEN: 0x22c55e,
  RED: 0xef4444,
  GOLD: 0xf59e0b,
  GRAY: 0x94a3b8,
};

// #คอมเมนต์(TH): แปลงสตริงจำนวนให้เป็นตัวเลขตามบริบท deposit/withdraw
function parseAmount(input, context) {
  // context = { kind: 'deposit' | 'withdraw', wallet, bank, bankLimit }
  const s = String(input).trim().toLowerCase();

  if (s === 'all') {
    return context.kind === 'deposit' ? context.wallet : context.bank;
  }
  if (s === 'half') {
    const base = context.kind === 'deposit' ? context.wallet : context.bank;
    return Math.floor(base / 2);
  }

  // 25% / 40%
  const pct = s.match(/^(\d{1,3})\s*%$/);
  if (pct) {
    const p = parseInt(pct[1], 10);
    if (p < 0 || p > 100) return NaN;
    const base = context.kind === 'deposit' ? context.wallet : context.bank;
    return Math.floor(base * (p / 100));
  }

  // 10k / 2.5m / 7b
  const suffix = s.match(/^(\d+(\.\d+)?)\s*([kmb])$/);
  if (suffix) {
    const n = parseFloat(suffix[1]);
    const mult = suffix[3] === 'k' ? 1e3 : suffix[3] === 'm' ? 1e6 : 1e9;
    return Math.floor(n * mult);
  }

  // จำนวนล้วน (รองรับใส่คอมม่า)
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.floor(n) : NaN;
}

const fmt = (n) => new Intl.NumberFormat().format(Math.max(0, Number(n || 0)));

function overviewEmbed(user, title = '🏦 Bank Account') {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(COLORS.BLUE)
    .addFields(
      { name: '💰 Wallet', value: `${fmt(user.money)} coins`, inline: true },
      { name: '🏦 Bank', value: `${fmt(user.bank)} / ${fmt(user.bank_limit)} coins`, inline: true },
    )
    .setTimestamp();
}

// ---------- command ----------
module.exports = {
  name: 'bank',
  description: 'Manage your bank account',
  data: new SlashCommandBuilder()
    .setName('bank')
    .setDescription('Bank operations')
    .setDMPermission(false)
    .addSubcommand(cmd =>
      cmd.setName('view').setDescription('View your wallet and bank balance'),
    )
    .addSubcommand(cmd =>
      cmd
        .setName('deposit')
        .setDescription('Deposit coins into your bank')
        .addStringOption(opt =>
          opt
            .setName('amount')
            .setDescription('Amount (number, %, k/m/b, or "all"/"half")')
            .setRequired(true),
        ),
    )
    .addSubcommand(cmd =>
      cmd
        .setName('withdraw')
        .setDescription('Withdraw coins from your bank')
        .addStringOption(opt =>
          opt
            .setName('amount')
            .setDescription('Amount (number, %, k/m/b, or "all"/"half")')
            .setRequired(true),
        ),
    ),

  async execute(interaction, db) {
    const sub = interaction.options.getSubcommand(false) || 'view';
    const actor = interaction.user;

    // #คอมเมนต์(TH): สร้างโปรไฟล์ถ้ายังไม่มี
    let user = await initUser(actor);
    if (!user) {
      return interaction.reply({
        content: "❌ You don't have an account yet.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'view') {
      const embed = overviewEmbed(user, '🏦 Bank Account Overview').setColor(COLORS.GOLD);
      return interaction.reply({ embeds: [embed] });
    }

    // --- deposit / withdraw ---
    const raw = interaction.options.getString('amount', true);
    const kind = sub; // 'deposit' | 'withdraw'
    const ctx = {
      kind,
      wallet: Number(user.money || 0),
      bank: Number(user.bank || 0),
      bankLimit: Number(user.bank_limit || 0),
    };
    let amount = parseAmount(raw, ctx);

    // #คอมเมนต์(TH): validate จำนวน
    if (!Number.isFinite(amount) || amount <= 0) {
      return interaction.reply({
        content:
          '❌ Invalid amount. Try values like `1000`, `10k`, `2.5m`, `25%`, `half`, or `all`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (kind === 'deposit') {
      const spaceLeft = Math.max(0, ctx.bankLimit - ctx.bank);
      if (spaceLeft <= 0) {
        return interaction.reply({ content: '🏦 Your bank is full!', flags: MessageFlags.Ephemeral });
      }
      if (amount > ctx.wallet) {
        return interaction.reply({
          content: "❌ You don't have enough coins in your wallet.",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (amount > spaceLeft) amount = spaceLeft; // #คอมเมนต์(TH): หนีบให้อยู่ในพื้นที่ว่าง

      // ทำแบบ atomic และคืนค่าล่าสุด
      const q = await db.query(
        `UPDATE users
           SET money = money - $1,
               bank  = bank  + $1
         WHERE user_id = $2 AND money >= $1 AND bank + $1 <= bank_limit
         RETURNING user_id, money, bank, bank_limit`,
        [amount, actor.id],
      );

      if (q.rowCount === 0) {
        // #คอมเมนต์(TH): เงื่อนไขไม่ผ่าน/โดนแซง → โหลดค่าสดแล้วแจ้งเหตุผล
        user = (await db.query('SELECT money, bank, bank_limit FROM users WHERE user_id = $1', [actor.id])).rows[0] || user;
        const space = Math.max(0, Number(user.bank_limit) - Number(user.bank));
        const reasons = [];
        if (amount > Number(user.money)) reasons.push('wallet not enough');
        if (amount > space) reasons.push('bank full');
        const reasonText = reasons.length ? ` (${reasons.join(', ')})` : '';
        return interaction.reply({
          content: `⚠️ Deposit failed${reasonText}. Try a smaller amount.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const updated = q.rows[0];
      const embed = new EmbedBuilder()
        .setTitle('🏦 Deposit Successful')
        .setColor(COLORS.GREEN)
        .setDescription(`✅ Deposited **${fmt(amount)} coins** to your bank.`)
        .addFields(
          { name: '💰 Wallet', value: `${fmt(updated.money)} coins`, inline: true },
          { name: '🏦 Bank', value: `${fmt(updated.bank)} / ${fmt(updated.bank_limit)} coins`, inline: true },
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (kind === 'withdraw') {
      if (amount > ctx.bank) {
        return interaction.reply({
          content: "❌ You don't have enough coins in your bank.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const q = await db.query(
        `UPDATE users
           SET bank  = bank  - $1,
               money = money + $1
         WHERE user_id = $2 AND bank >= $1
         RETURNING user_id, money, bank, bank_limit`,
        [amount, actor.id],
      );

      if (q.rowCount === 0) {
        user = (await db.query('SELECT money, bank, bank_limit FROM users WHERE user_id = $1', [actor.id])).rows[0] || user;
        return interaction.reply({
          content: '⚠️ Withdrawal failed (your bank balance changed). Try again.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const updated = q.rows[0];
      const embed = new EmbedBuilder()
        .setTitle('🏧 Withdrawal Successful')
        .setColor(COLORS.GREEN)
        .setDescription(`✅ Withdrew **${fmt(amount)} coins** from your bank.`)
        .addFields(
          { name: '💰 Wallet', value: `${fmt(updated.money)} coins`, inline: true },
          { name: '🏦 Bank', value: `${fmt(updated.bank)} / ${fmt(updated.bank_limit)} coins`, inline: true },
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }
  },
};
