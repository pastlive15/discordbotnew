// commands/lottery.js
// Lottery (6-digit) with rollover jackpot, admin-set winning code, admin-set prize splits,
// bulk random purchase with per-user per-round cap, and atomic wallet updates.
//
// Subcommands:
//   /lottery buy | info | my | draw | setcode | setpot | setsplits
//
// - /lottery buy:
//     * If `code` provided -> amount forced to 1 (manual code)
//     * If `amount` provided (and no `code`) -> buy many tickets with random codes
//     * Per-user per-round cap (MAX_TICKETS_PER_USER = 100) with advisory lock
//
// Requires:
// - initUser(user, db)
// - isAdmin(userId, ownerId?) in ../utils/adminAuth
//
// DB tables: see SQL at bottom of this message

const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { initUser } = require('../utils/initUser');
const { isAdmin } = require('../utils/adminAuth');

// ---------- CONFIG ----------
const TICKET_PRICE = 500;                // ราคาใบละ
const HOUSE_CUT = 0.10;                  // ส่วนแบ่งบ้าน (20%); ที่เหลือเข้า pot
const CODE_LEN = 6;                      // ★★ ใช้เลข "6 หลัก" ★★
const AUTO_CREATE_ROUND = true;          // สร้างรอบใหม่อัตโนมัติ ถ้าไม่มีรอบเปิดอยู่
const CURRENCY_EMOJI = '<a:PixelCoin:1392196932926967858>';
const MAX_TICKETS_PER_USER = 100;        // ลิมิต/คน/รอบ

// ค่าเริ่มต้นของสัดส่วนเงินรางวัล (ใช้เมื่อไม่มี override_splits)
const PRIZE_SPLITS = Object.freeze({
  match5: 0.75,   // ถ้าต้องการ match6 ก็เปลี่ยน logic draw เพิ่มได้ (ตอนนี้ใช้ exact-position 6/5/4?... เราใช้ 6/5/4 → ตามด้านล่าง)
  match4: 0.20,
  match3: 0.05,
});

// ---------- HELPERS ----------
const fmt = (n) => new Intl.NumberFormat().format(Math.max(0, Number(n || 0)));

function randCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

function normalizeCode(code) {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length > CODE_LEN) return digits.slice(-CODE_LEN);
  return digits.padStart(CODE_LEN, '0');
}

function countMatches(code, win) {
  let m = 0;
  for (let i = 0; i < CODE_LEN; i++) if (code[i] === win[i]) m++;
  return m;
}

function normalizePercent(x) {
  if (x == null) return null;
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? n / 100 : n;
}

function pickSplits(row) {
  if (row && row.override_splits) {
    const os = row.override_splits;
    const m5 = Number(os.match5 ?? 0);
    const m4 = Number(os.match4 ?? 0);
    const m3 = Number(os.match3 ?? 0);
    if ([m5, m4, m3].every(v => Number.isFinite(v) && v >= 0)) {
      return { match5: m5, match4: m4, match3: m3 };
    }
  }
  return PRIZE_SPLITS;
}

// ---------- DB PRIMITIVES ----------
async function ensureOpenRound(db) {
  const { rows } = await db.query(
    `SELECT * FROM lottery_rounds WHERE status='open' ORDER BY id DESC LIMIT 1`
  );
  if (rows.length > 0) return rows[0];

  if (!AUTO_CREATE_ROUND) return null;

  const { rows: created } = await db.query(
    `INSERT INTO lottery_rounds (status, pot, rollover, created_at)
     VALUES ('open', 0, 0, NOW())
     RETURNING *`
  );
  return created[0];
}

async function getOpenRound(db) {
  const { rows } = await db.query(
    `SELECT * FROM lottery_rounds WHERE status='open' ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function getLastDrawnRounds(db, limit = 3) {
  const { rows } = await db.query(
    `SELECT * FROM lottery_rounds WHERE status='drawn' ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getMyTickets(db, userId, roundId) {
  const { rows } = await db.query(
    `SELECT id, code, created_at FROM lottery_tickets
     WHERE user_id=$1 AND round_id=$2
     ORDER BY id DESC LIMIT 50`,
    [userId, roundId]
  );
  return rows;
}

// ---------- COMMAND ----------
module.exports = {
  name: 'lottery',
  description: 'Daily lottery (6-digit) with rollover jackpot!',
  data: new SlashCommandBuilder()
    .setName('lottery')
    .setDescription('Play the lottery (6-digit).')
    .addSubcommand(sc =>
      sc.setName('buy')
        .setDescription('Buy lottery ticket(s). If you choose a code, amount is forced to 1.')
        .addStringOption(o =>
          o.setName('code')
            .setDescription(`Custom ${CODE_LEN}-digit code (optional, digits only). If provided, amount=1`)
            .setRequired(false))
        .addIntegerOption(o =>
          o.setName('amount')
            .setDescription('How many tickets to buy (random codes only).')
            .setMinValue(1)
            .setMaxValue(100) // per call; global cap per round still applies
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc.setName('info')
        .setDescription('Show current pot, your tickets, and recent results'))
    .addSubcommand(sc =>
      sc.setName('my')
        .setDescription('Show your tickets for the current round'))
    .addSubcommand(sc =>
      sc.setName('draw')
        .setDescription('Draw the lottery now (admin only)'))
    .addSubcommand(sc =>
      sc.setName('setcode')
        .setDescription('Set or clear the winning code for the current open round (admin)')
        .addStringOption(o =>
          o.setName('code')
            .setDescription('Planned winning code (digits only)')
            .setRequired(false))
        .addBooleanOption(o =>
          o.setName('clear')
            .setDescription('Clear planned code for the open round')
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc.setName('setpot')
        .setDescription('Admin: set or add to the current round pot')
        .addStringOption(o =>
          o.setName('mode')
            .setDescription('"set" to replace pot, "add" to add amount')
            .addChoices(
              { name: 'set', value: 'set' },
              { name: 'add', value: 'add' },
            )
            .setRequired(true))
        .addIntegerOption(o =>
          o.setName('amount')
            .setDescription('Amount of coins')
            .setMinValue(0)
            .setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('setsplits')
        .setDescription('Admin: override prize splits (match6/match5/match4 OR match5/match4/match3 based on your policy)')
        .addNumberOption(o =>
          o.setName('match5')
            .setDescription('Top prize share (e.g., 75 or 0.75)')
            .setRequired(true))
        .addNumberOption(o =>
          o.setName('match4')
            .setDescription('Second prize share (e.g., 20 or 0.20)')
            .setRequired(true))
        .addNumberOption(o =>
          o.setName('match3')
            .setDescription('Third prize share (e.g., 5 or 0.05)')
            .setRequired(true))
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {import('pg').Pool} db
   */
  async execute(interaction, db) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'buy')      return buyTicket(interaction, db);
    if (sub === 'info')     return info(interaction, db);
    if (sub === 'my')       return my(interaction, db);
    if (sub === 'draw')     return draw(interaction, db);
    if (sub === 'setcode')  return setPlannedCode(interaction, db);
    if (sub === 'setpot')   return setPot(interaction, db);
    if (sub === 'setsplits')return setSplits(interaction, db);
  },
};

// ---------- /lottery buy ----------
async function buyTicket(interaction, db) {
  const user = await initUser(interaction.user, db);
  if (!user) {
    return interaction.reply({ content: '❌ You need a profile to play.', flags: MessageFlags.Ephemeral });
  }

  const open = await ensureOpenRound(db);
  if (!open) {
    return interaction.reply({ content: '⛔ No open lottery round.', flags: MessageFlags.Ephemeral });
  }

  const wallet = Number(user.money || 0);

  // Read options
  const inputCode = (interaction.options.getString('code') || '').trim();
  let requestedAmount = interaction.options.getInteger('amount') ?? 1;
  if (!Number.isFinite(requestedAmount) || requestedAmount < 1) requestedAmount = 1;

  const singleWithCustomCode = !!inputCode;
  if (singleWithCustomCode) requestedAmount = 1;
  else if (requestedAmount > 100) requestedAmount = 100;

  // --- TX start
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Advisory lock กัน race บน (roundId, userId)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${open.id}:${interaction.user.id}`]);

    // เช็คจำนวนที่มีแล้วในรอบนี้
    const { rows: cntRows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM lottery_tickets WHERE round_id=$1 AND user_id=$2`,
      [open.id, interaction.user.id]
    );
    const alreadyHave = Number(cntRows[0]?.c || 0);
    const remaining = Math.max(0, MAX_TICKETS_PER_USER - alreadyHave);
    if (remaining <= 0) {
      await client.query('ROLLBACK');
      return interaction.reply({
        content: `⛔ You already have **${fmt(MAX_TICKETS_PER_USER)}** tickets this round.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ตัดสินใจจำนวนที่จะซื้อ
    let codes = [];
    if (singleWithCustomCode) {
      if (remaining < 1) {
        await client.query('ROLLBACK');
        return interaction.reply({
          content: `⛔ Ticket cap reached: ${fmt(MAX_TICKETS_PER_USER)} per round.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const code = normalizeCode(inputCode);
      if (!code) {
        await client.query('ROLLBACK');
        return interaction.reply({ content: '❌ Please enter digits only for `code`.', flags: MessageFlags.Ephemeral });
      }
      codes = [code];
    } else {
      const maxAffordable = Math.floor(wallet / TICKET_PRICE);
      const canBuy = Math.min(requestedAmount, remaining, maxAffordable);
      if (canBuy <= 0) {
        await client.query('ROLLBACK');
        if (maxAffordable <= 0) {
          return interaction.reply({
            content: `💸 Not enough balance. Ticket = **${fmt(TICKET_PRICE)}** ${CURRENCY_EMOJI}`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({
          content: `⛔ You can only buy **${fmt(remaining)}** more ticket(s) this round.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      for (let i = 0; i < canBuy; i++) codes.push(randCode());
    }

    const totalCost = TICKET_PRICE * codes.length;

    // ตัดเงินรวม (atomic)
    const { rows: r1 } = await client.query(
      `UPDATE users
       SET money = money - $2
       WHERE user_id = $1 AND money >= $2
       RETURNING money`,
      [interaction.user.id, totalCost]
    );
    if (r1.length === 0) {
      await client.query('ROLLBACK');
      return interaction.reply({
        content: `💸 Balance changed. You need **${fmt(totalCost)}** ${CURRENCY_EMOJI}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ใส่ตั๋ว (batch)
    const { rows: tks } = await client.query(
      `
      WITH data(code) AS ( SELECT UNNEST($3::text[]) )
      INSERT INTO lottery_tickets (round_id, user_id, code, created_at)
      SELECT $1, $2, d.code, NOW()
      FROM data d
      RETURNING id, code
      `,
      [open.id, interaction.user.id, codes]
    );

    // เพิ่ม pot
    const toPot = Math.floor(totalCost * (1 - HOUSE_CUT));
    await client.query(
      `UPDATE lottery_rounds SET pot = pot + $2 WHERE id = $1`,
      [open.id, toPot]
    );

    await client.query('COMMIT');

    // ตอบกลับ
    const show = tks.slice(0, 10);
    const more = tks.length - show.length;

    const lines = [];
    if (singleWithCustomCode) {
      lines.push(`🧾 Code: \`${tks[0].code}\``);
    } else {
      lines.push(`🧾 Codes (${tks.length}):`);
      for (const row of show) lines.push(`• #${row.id} — \`${row.code}\``);
      if (more > 0) lines.push(`…and ${fmt(more)} more`);
    }
    lines.push('');
    lines.push(`💰 Price: ${fmt(TICKET_PRICE)} × ${fmt(tks.length)} = **${fmt(totalCost)}** ${CURRENCY_EMOJI}`);
    lines.push(`🏦 Added to pot: **${fmt(toPot)}** ${CURRENCY_EMOJI}`);
    const newTotal = alreadyHave + tks.length;
    lines.push(`👤 Your tickets this round: **${fmt(newTotal)} / ${fmt(MAX_TICKETS_PER_USER)}**`);

    const embed = new EmbedBuilder()
      .setTitle(singleWithCustomCode ? '🎟️ Lottery Ticket Purchased' : '🎟️ Lottery Tickets Purchased')
      .setColor(0x5865f2)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Round #${open.id}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('lottery buy error:', e);

    if (e?.code === 'P0001') {
      return interaction.reply({
        content: '⛔ Ticket cap reached for this round (max 100 per user).',
        flags: MessageFlags.Ephemeral
      });
    }

    return interaction.reply({ content: '❌ Failed to buy ticket(s). Try again.', flags: MessageFlags.Ephemeral });
  } finally {
    client.release();
  }
}

// ---------- /lottery info ----------
async function info(interaction, db) {
  const open = await getOpenRound(db);
  const last = await getLastDrawnRounds(db, 3);

  let desc = '';
  if (open) {
    const { rows: t } = await db.query(
      `SELECT COUNT(*)::int AS c FROM lottery_tickets WHERE round_id=$1`,
      [open.id]
    );
    const splits = pickSplits(open);
    const pct = (x) => `${Math.round(x * 1000) / 10}%`;

    const { rows: mineCnt } = await db.query(
      `SELECT COUNT(*)::int AS c FROM lottery_tickets WHERE round_id=$1 AND user_id=$2`,
      [open.id, interaction.user.id]
    );
    const mineCount = Number(mineCnt[0]?.c || 0);

    desc += `🟢 **Open Round #${open.id}**\n`;
    desc += `🏦 Pot: **${fmt(open.pot)}** ${CURRENCY_EMOJI}\n`;
    desc += `🎟️ Tickets: **${fmt(t[0].c)}**\n`;
    desc += `🏅 Splits: 6→${pct(splits.match5)} • 5→${pct(splits.match4)} • 4→${pct(splits.match3)}\n`; // ป้ายกำกับข้อความ (คุณปรับตาม policy ได้)
    desc += `👤 Your cap: **${fmt(mineCount)} / ${fmt(MAX_TICKETS_PER_USER)}**\n`;
    if (open.planned_code) {
      desc += `🧭 Planned code: \`${open.planned_code}\`\n`;
    }
  } else {
    desc += `🔴 No open round right now.\n`;
  }

  if (last.length > 0) {
    desc += `\n**Recent Results**\n`;
    for (const r of last) {
      desc += `• Round #${r.id} → Code **\`${r.draw_code}\`** | Pot ${fmt(r.pot + r.rollover)} ${CURRENCY_EMOJI}\n`;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('🎰 Lottery Info (6-digit)')
    .setColor(0x5865f2)
    .setDescription(desc)
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ---------- /lottery my ----------
async function my(interaction, db) {
  const open = await getOpenRound(db);
  if (!open) {
    return interaction.reply({ content: '🔴 No open round now.', flags: MessageFlags.Ephemeral });
  }

  const mine = await getMyTickets(db, interaction.user.id, open.id);
  if (mine.length === 0) {
    return interaction.reply({ content: '😶 You have no tickets this round.', flags: MessageFlags.Ephemeral });
  }

  let desc = '';
  for (const tk of mine.slice(0, 25)) {
    desc += `• #${tk.id} — \`${tk.code}\`\n`;
  }
  if (mine.length > 25) desc += `…and ${mine.length - 25} more\n`;

  const embed = new EmbedBuilder()
    .setTitle(`🎟️ Your Tickets — Round #${open.id}`)
    .setColor(0x5865f2)
    .setDescription(desc)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------- /lottery setcode (admin) ----------
async function setPlannedCode(interaction, db) {
  const ownerId = interaction.client?.application?.owner?.id;
  if (!isAdmin(interaction.user.id, ownerId)) {
    return interaction.reply({ content: '⛔ Admins only.', flags: MessageFlags.Ephemeral });
  }

  const clear = interaction.options.getBoolean('clear') ?? false;
  const raw = interaction.options.getString('code');

  const { rows } = await db.query(
    `SELECT id, planned_code FROM lottery_rounds WHERE status='open' ORDER BY id DESC LIMIT 1`
  );
  if (rows.length === 0) {
    return interaction.reply({ content: '🔴 No open round to set code.', flags: MessageFlags.Ephemeral });
  }
  const round = rows[0];

  if (clear) {
    await db.query(`UPDATE lottery_rounds SET planned_code = NULL WHERE id=$1`, [round.id]);
    return interaction.reply({ content: `✅ Cleared planned winning code for Round #${round.id}.` });
  }

  if (!raw || !/^\d+$/.test(raw)) {
    return interaction.reply({ content: '❌ Please provide digits only in `code`, or use `clear:true`.', flags: MessageFlags.Ephemeral });
  }

  const code = normalizeCode(raw);
  await db.query(`UPDATE lottery_rounds SET planned_code = $2 WHERE id = $1`, [round.id, code]);

  return interaction.reply({ content: `✅ Set planned winning code for Round #${round.id} → \`${code}\`` });
}

// ---------- /lottery setpot (admin) ----------
async function setPot(interaction, db) {
  const ownerId = interaction.client?.application?.owner?.id;
  if (!isAdmin(interaction.user.id, ownerId)) {
    return interaction.reply({ content: '⛔ Admins only.', flags: MessageFlags.Ephemeral });
  }

  const mode = interaction.options.getString('mode'); // 'set' or 'add'
  const amount = Math.max(0, interaction.options.getInteger('amount') ?? 0);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, pot FROM lottery_rounds WHERE status='open' ORDER BY id DESC LIMIT 1 FOR UPDATE`
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return interaction.reply({ content: '🔴 No open round to adjust pot.', flags: MessageFlags.Ephemeral });
    }
    const round = rows[0];

    let newPot = Number(round.pot || 0);
    if (mode === 'set') newPot = amount;
    else if (mode === 'add') newPot += amount;
    else {
      await client.query('ROLLBACK');
      return interaction.reply({ content: '❌ Invalid mode. Use "set" or "add".', flags: MessageFlags.Ephemeral });
    }

    newPot = Math.max(0, Math.floor(newPot));

    await client.query(
      `UPDATE lottery_rounds SET pot=$2 WHERE id=$1`,
      [round.id, newPot]
    );
    await client.query('COMMIT');

    return interaction.reply({ content: `✅ Pot for Round #${round.id} is now **${fmt(newPot)}** ${CURRENCY_EMOJI}` });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('setpot error:', e);
    return interaction.reply({ content: '❌ Failed to update pot.', flags: MessageFlags.Ephemeral });
  } finally {
    client.release();
  }
}

// ---------- /lottery setsplits (admin) ----------
async function setSplits(interaction, db) {
  const ownerId = interaction.client?.application?.owner?.id;
  if (!isAdmin(interaction.user.id, ownerId)) {
    return interaction.reply({ content: '⛔ Admins only.', flags: MessageFlags.Ephemeral });
  }

  const m5raw = interaction.options.getNumber('match5');
  const m4raw = interaction.options.getNumber('match4');
  const m3raw = interaction.options.getNumber('match3');

  const m5 = normalizePercent(m5raw);
  const m4 = normalizePercent(m4raw);
  const m3 = normalizePercent(m3raw);

  if ([m5, m4, m3].some(v => v == null)) {
    return interaction.reply({ content: '❌ Please provide non-negative numbers for all splits.', flags: MessageFlags.Ephemeral });
  }

  const sum = m5 + m4 + m3;
  if (sum > 1.0001) {
    return interaction.reply({ content: '❌ Sum of splits must be ≤ 100%.', flags: MessageFlags.Ephemeral });
  }

  const { rows } = await db.query(
    `SELECT id FROM lottery_rounds WHERE status='open' ORDER BY id DESC LIMIT 1`
  );
  if (rows.length === 0) {
    return interaction.reply({ content: '🔴 No open round to set splits.', flags: MessageFlags.Ephemeral });
  }
  const roundId = rows[0].id;

  await db.query(
    `UPDATE lottery_rounds
     SET override_splits = $2::jsonb
     WHERE id = $1`,
    [roundId, { match5: m5, match4: m4, match3: m3 }]
  );

  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  return interaction.reply({
    content: `✅ Set prize splits for Round #${roundId} → 6:${pct(m5)} • 5:${pct(m4)} • 4:${pct(m3)}`
  });
}

// ---------- /lottery draw (admin) ----------
async function draw(interaction, db) {
  const ownerId = interaction.client?.application?.owner?.id;
  if (!isAdmin(interaction.user.id, ownerId)) {
    return interaction.reply({ content: '⛔ Admins only.', flags: MessageFlags.Ephemeral });
  }

  const open = await getOpenRound(db);
  if (!open) {
    return interaction.reply({ content: '🔴 No open round to draw.', flags: MessageFlags.Ephemeral });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock round
    const { rows: r0 } = await client.query(
      `SELECT * FROM lottery_rounds WHERE id=$1 FOR UPDATE`,
      [open.id]
    );
    if (r0.length === 0 || r0[0].status !== 'open') {
      await client.query('ROLLBACK');
      return interaction.reply({ content: '⚠️ Round already closed.', flags: MessageFlags.Ephemeral });
    }

    // Load tickets
    const { rows: tickets } = await client.query(
      `SELECT id, user_id, code FROM lottery_tickets WHERE round_id=$1 ORDER BY id ASC`,
      [open.id]
    );

    // Winning code (planned or random)
    let winCode = r0[0].planned_code ? normalizeCode(r0[0].planned_code) : randCode();

    // Count matches (6/5/4 ตำแหน่งเหมือน)
    const winners6 = [];
    const winners5 = [];
    const winners4 = [];
    for (const tk of tickets) {
      const m = countMatches(tk.code, winCode);
      if (m === 6) winners6.push(tk);
      else if (m === 5) winners5.push(tk);
      else if (m === 4) winners4.push(tk);
    }

    // Compute pools using override splits if present (ใช้คีย์เดิม match5/match4/match3)
    // เราจะ map: 6→match5, 5→match4, 4→match3 เพื่อใช้ตารางเดิมได้
    const splits = pickSplits(r0[0]);
    const pot = Number(r0[0].pot || 0) + Number(r0[0].rollover || 0);
    const pool6 = Math.floor(pot * splits.match5);
    const pool5 = Math.floor(pot * splits.match4);
    const pool4 = Math.floor(pot * splits.match3);

    let paidOut = 0;

    async function payPool(entries, poolAmount, matchCount) {
      if (!entries.length || poolAmount <= 0) return 0;
      const each = Math.max(1, Math.floor(poolAmount / entries.length));
      for (const tk of entries) {
        await client.query(
          `UPDATE users SET money = money + $2 WHERE user_id = $1`,
          [tk.user_id, each]
        );
        await client.query(
          `INSERT INTO lottery_wins (round_id, user_id, ticket_id, prize, matches, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [open.id, tk.user_id, tk.id, each, matchCount]
        );
        paidOut += each;
      }
      return each;
    }

    await payPool(winners6, pool6, 6);
    await payPool(winners5, pool5, 5);
    await payPool(winners4, pool4, 4);

    const rollover = Math.max(0, pot - paidOut);

    // Close round (clear planned_code and override_splits)
    await client.query(
      `UPDATE lottery_rounds
       SET status='drawn',
           draw_code=$2,
           paid_out=$3,
           planned_code=NULL,
           override_splits=NULL,
           rollover=0,
           closed_at=NOW()
       WHERE id=$1`,
      [open.id, winCode, paidOut]
    );

    // Create next round with rollover as starting pot
    let nextRoundId = null;
    if (AUTO_CREATE_ROUND) {
      const { rows: nxt } = await client.query(
        `INSERT INTO lottery_rounds (status, pot, rollover, created_at)
         VALUES ('open', $1, $2, NOW())
         RETURNING id`,
        [rollover, 0]
      );
      nextRoundId = nxt[0].id;
    } else {
      await client.query(
        `UPDATE lottery_rounds SET rollover=$2 WHERE id=$1`,
        [open.id, rollover]
      );
    }

    await client.query('COMMIT');

    // Summary
    const lines = [];
    const pct = (x) => `${Math.round(x * 1000) / 10}%`;
    lines.push(`🟣 **Round #${open.id}** result`);
    lines.push(`🏁 Winning code: **\`${winCode}\`**`);
    lines.push(`${CURRENCY_EMOJI} Pot: **${fmt(pot)}** | Paid out: **${fmt(paidOut)}** | Rollover: **${fmt(rollover)}**`);
    lines.push(`🏅 Splits used → 6:${pct(splits.match5)} • 5:${pct(splits.match4)} • 4:${pct(splits.match3)}`);
    lines.push('');
    lines.push(`🥇 Match 6: **${winners6.length}** winner(s)`);
    lines.push(`🥈 Match 5: **${winners5.length}** winner(s)`);
    lines.push(`🥉 Match 4: **${winners4.length}** winner(s)`);
    if (nextRoundId) {
      lines.push('');
      lines.push(`🟢 New round opened: **#${nextRoundId}** (starting pot **${fmt(rollover)}** ${CURRENCY_EMOJI})`);
    }

    const embed = new EmbedBuilder()
      .setTitle('🎉 Lottery Draw Complete (6-digit)')
      .setColor(0x22c55e)
      .setDescription(lines.join('\n'))
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('lottery draw error:', e);
    return interaction.reply({ content: '❌ Draw failed. Try again.', flags: MessageFlags.Ephemeral });
  } finally {
    client.release();
  }
}
