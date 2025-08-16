// commands/shop.js
// ร้านค้า (ปรับแต่งสวย + ปลอดภัย) สำหรับระบบเศรษฐกิจ
// คอมเมนต์ทั้งหมดเป็นภาษาไทย / ข้อความที่ผู้ใช้เห็นเป็นภาษาอังกฤษ
// - อัปเกรดธนาคารแบบขั้นบันได: เริ่ม 200,000; เพิ่มครั้งละ 50,000; ราคา = 75,000 * 1.15^tier (ปัดขึ้น)
// - ซื้อแบบอะตอมมิก (คำสั่ง SQL เดียว) ป้องกัน race conditions
// - ค่าบริการอัปเกรดงาน = 500 * job_level ปัจจุบัน (อะตอมมิก)
// - ไอเท็มโจรกรรมแบบจำกัด/สะสมได้ เก็บใน JSONB พร้อม guard
// - แสดงผลด้วยปุ่ม (ephemeral) และรีเฟรช UI หลังซื้อทุกครั้ง พร้อมปิดปุ่มเมื่อซื้อไม่ได้

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = {
  AQUA: 0x00bcd4,
  GREEN: 0x22c55e,
  RED: 0xef4444,
  GOLD: 0xf59e0b,
  GRAY: 0x94a3b8,
};

// ค่าพื้นฐานของระบบอัปเกรดธนาคาร
const BANK_BASE = 200_000;      // เพดานธนาคารเริ่มต้น
const BANK_STEP = 50_000;       // เพิ่มครั้งละ 50k
const BANK_BASE_PRICE = 75_000; // ราคาฐานครั้งแรก
const BANK_GROWTH = 1.15;       // ราคาโต 15% ต่อขั้น
const BANK_HARD_CAP = 2_000_000;// เพดานสูงสุด

// ---------- helper (คำนวณ tier/ราคา/format) ----------
function bankTier(limit) {
  return Math.max(0, Math.floor((Number(limit || BANK_BASE) - BANK_BASE) / BANK_STEP));
}
function bankUpgradePrice(limit) {
  const tier = bankTier(limit);
  return Math.ceil(BANK_BASE_PRICE * Math.pow(BANK_GROWTH, tier));
}
function fmt(n) {
  return new Intl.NumberFormat().format(Number(n || 0));
}
function canAfford(user, cost) {
  return Number(user.money || 0) >= Number(cost || 0);
}

// UI: สร้าง embed ตามผู้ใช้ปัจจุบัน (ข้อความเป็นอังกฤษ)
function buildShopEmbed(user) {
  const atCap = Number(user.bank_limit || BANK_BASE) >= BANK_HARD_CAP;
  const nextPrice = atCap ? 0 : bankUpgradePrice(user.bank_limit);
  const nextLimit = atCap ? user.bank_limit : Math.min(user.bank_limit + BANK_STEP, BANK_HARD_CAP);

  const embed = new EmbedBuilder()
    .setTitle('🛒 Economy Shop')
    .setColor(COLORS.AQUA)
    .setDescription('Tap a button below to purchase items or upgrades.')
    .addFields(
      {
        name: atCap
          ? '🏦 Bank Upgrade — MAXED'
          : `🏦 Bank Upgrade — ${fmt(nextPrice)} coins`,
        value: atCap
          ? `Your bank limit is already at the maximum (**${fmt(BANK_HARD_CAP)}**).`
          : `Increase bank limit by **+${fmt(BANK_STEP)}** → ${fmt(nextLimit)} (current: ${fmt(user.bank_limit)}).\nPrice scales +15% per tier • Max: ${fmt(BANK_HARD_CAP)}.`,
      },
      {
        name: `📈 Job Upgrade — ${fmt(500 * (user.job_level || 1))} coins`,
        value: 'Increase your Job Level by +1 to boost work rewards. Cost scales with your current level.',
      },
      { name: '🧤 Gloves — 35,000 coins', value: 'Increase /steal success chance by +5%. (max 1)' },
      { name: '🥾 Silent Boots — 30,000 coins', value: 'If caught using /steal, your fine is halved. (max 1)' },
      { name: '🔓 Master Key — 25,000 coins', value: 'Doubles your next vaultrob reward. (stackable)' },
    )
    .setFooter({
      text: `Balance: ${fmt(user.money)} • Wallet | Bank: ${fmt(user.bank)} / ${fmt(user.bank_limit)}`,
      iconURL: 'https://cdn.discordapp.com/emojis/1083251527998363718.webp?size=96&quality=lossless',
    })
    .setTimestamp();

  return embed;
}

// แถวปุ่ม (ปิดปุ่มอัตโนมัติถ้าซื้อไม่ได้)
function buildShopRow(user) {
  const atCap = Number(user.bank_limit || BANK_BASE) >= BANK_HARD_CAP;
  const bankPrice = atCap ? Infinity : bankUpgradePrice(user.bank_limit);
  const jobPrice = 500 * (user.job_level || 1);

  const glovesHave = Number(user.items?.gloves || 0);
  const bootsHave  = Number(user.items?.boots  || 0);

  const btnBank = new ButtonBuilder()
    .setCustomId('buy_bank')
    .setLabel(atCap ? 'Bank Upgrade (MAXED)' : `Buy Bank Upgrade (${fmt(bankPrice)})`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(atCap || !canAfford(user, bankPrice));

  const btnJob = new ButtonBuilder()
    .setCustomId('buy_job')
    .setLabel(`Buy Job Upgrade (${fmt(jobPrice)})`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!canAfford(user, jobPrice));

  const btnGloves = new ButtonBuilder()
    .setCustomId('buy_gloves')
    .setLabel('Buy Gloves (35,000)')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(glovesHave >= 1 || !canAfford(user, 35_000));

  const btnBoots = new ButtonBuilder()
    .setCustomId('buy_boots')
    .setLabel('Buy Boots (30,000)')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(bootsHave >= 1 || !canAfford(user, 30_000));

  const btnKey = new ButtonBuilder()
    .setCustomId('buy_key')
    .setLabel('Buy Master Key (25,000)')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!canAfford(user, 25_000));

  return new ActionRowBuilder().addComponents(btnBank, btnJob, btnGloves, btnBoots, btnKey);
}

// ---------- atomic SQL actions (ซื้อแบบคำสั่งเดียว) ----------
async function buyBankUpgrade(db, userId) {
  // ซื้ออัปเกรดธนาคารแบบอะตอมมิก: คิดราคา/เช็คเพดาน/หักเงิน/บวกเพดาน ในคำสั่งเดียว
  const { rows } = await db.query(
    `
    WITH u AS (
      SELECT user_id, money, bank_limit
      FROM users
      WHERE user_id = $1
      FOR UPDATE
    ),
    calc AS (
      SELECT
        user_id,
        money,
        bank_limit,
        LEAST($5, bank_limit + $2) AS new_limit,
        CEIL($3 * POWER($4, GREATEST(0, FLOOR((bank_limit - $6) / $2))))::bigint AS price
      FROM u
    ),
    guard AS (
      SELECT *
      FROM calc
      WHERE bank_limit < $5
        AND money >= price
    ),
    upd AS (
      UPDATE users
      SET money = users.money - guard.price,
          bank_limit = guard.new_limit
      FROM guard
      WHERE users.user_id = guard.user_id
      RETURNING users.user_id, users.username, users.money, users.bank, users.bank_limit
    )
    SELECT *, (SELECT price FROM guard) AS charged
    FROM upd;
    `,
    [userId, BANK_STEP, BANK_BASE_PRICE, BANK_GROWTH, BANK_HARD_CAP, BANK_BASE],
  );

  if (rows.length === 0) {
    // อธิบายสาเหตุที่ซื้อไม่สำเร็จให้ชัดเจน
    const snap = await db.query('SELECT money, bank_limit FROM users WHERE user_id = $1', [userId]);
    const u = snap.rows[0] || {};
    if ((u.bank_limit || BANK_BASE) >= BANK_HARD_CAP) {
      return { ok: false, msg: `🏦 Your bank limit is already at the maximum (**${fmt(BANK_HARD_CAP)}**).` };
    }
    const price = bankUpgradePrice(u.bank_limit);
    if ((u.money || 0) < price) {
      return { ok: false, msg: `💸 Not enough coins. You need **${fmt(price)}**.` };
    }
    return { ok: false, msg: '⚠️ Purchase failed. Please try again.' };
  }

  const updated = rows[0];
  const charged = Number(rows[0].charged || 0);
  return {
    ok: true,
    charged,
    user: updated,
    note: `🏦 Bank limit upgraded to **${fmt(updated.bank_limit)}** (paid **${fmt(charged)}**).`,
  };
}

async function buyJobUpgrade(db, userId) {
  const { rows } = await db.query(
    `
    WITH u AS (
      SELECT user_id, money, job_level
      FROM users
      WHERE user_id = $1
      FOR UPDATE
    ),
    calc AS (
      SELECT user_id, money, job_level, (500 * GREATEST(job_level,1))::bigint AS price
      FROM u
    ),
    guard AS (
      SELECT * FROM calc WHERE money >= price
    ),
    upd AS (
      UPDATE users
      SET money = users.money - guard.price,
          job_level = users.job_level + 1
      FROM guard
      WHERE users.user_id = guard.user_id
      RETURNING users.user_id, users.username, users.money, users.job_level
    )
    SELECT *, (SELECT price FROM guard) AS charged FROM upd;
    `,
    [userId],
  );

  if (rows.length === 0) {
    const snap = await db.query('SELECT money, job_level FROM users WHERE user_id=$1', [userId]);
    const u = snap.rows[0] || { job_level: 1, money: 0 };
    const price = 500 * (u.job_level || 1);
    if (u.money < price) return { ok: false, msg: `💸 Not enough coins. You need **${fmt(price)}**.` };
    return { ok: false, msg: '⚠️ Purchase failed. Please try again.' };
  }

  const updated = rows[0];
  const charged = Number(rows[0].charged || 0);
  return {
    ok: true,
    charged,
    user: updated,
    note: `📈 Job level upgraded to **${updated.job_level}** (paid **${fmt(charged)}**).`,
  };
}

async function buyLimitedFlagItem(db, userId, key, price, maxCount = 1) {
  // ซื้อไอเท็มที่มีจำนวนสูงสุด (เช่น gloves/boots) แบบอะตอมมิก
  const { rows } = await db.query(
    `
    WITH u AS (
      SELECT user_id, money, items
      FROM users
      WHERE user_id = $1
      FOR UPDATE
    ),
    calc AS (
      SELECT
        user_id,
        money,
        COALESCE(items, '{}'::jsonb) AS items,
        COALESCE((items->>$2)::int, 0) AS have
      FROM u
    ),
    guard AS (
      SELECT *
      FROM calc
      WHERE have < $4 AND money >= $3
    ),
    upd AS (
      UPDATE users
      SET money = users.money - $3,
          items = jsonb_set(
            COALESCE(users.items,'{}'::jsonb),
            ARRAY[$2],
            TO_JSONB(COALESCE((users.items->>$2)::int,0) + 1),
            true
          )
      FROM guard
      WHERE users.user_id = guard.user_id
      RETURNING users.user_id, users.username, users.money, users.items
    )
    SELECT * FROM upd;
    `,
    [userId, key, price, maxCount],
  );

  if (rows.length === 0) {
    const snap = await db.query('SELECT money, items FROM users WHERE user_id=$1', [userId]);
    const money = Number(snap.rows[0]?.money || 0);
    const have = Number(snap.rows[0]?.items?.[key] || 0);
    if (have >= maxCount) return { ok: false, msg: `❌ You already own **${prettyItemName(key)}** (max ${maxCount}).` };
    if (money < price) return { ok: false, msg: `💸 Not enough coins. You need **${fmt(price)}**.` };
    return { ok: false, msg: '⚠️ Purchase failed. Please try again.' };
  }
  return { ok: true, note: `✅ Purchased **${prettyItemName(key)}**.` };
}

async function buyStackItem(db, userId, key, price) {
  // ซื้อไอเท็มแบบสะสมได้ (เช่น master key) แบบอะตอมมิก
  const { rows } = await db.query(
    `
    WITH u AS (
      SELECT user_id, money, items
      FROM users
      WHERE user_id = $1
      FOR UPDATE
    ),
    guard AS (
      SELECT * FROM u WHERE money >= $3
    ),
    upd AS (
      UPDATE users
      SET money = users.money - $3,
          items = jsonb_set(
            COALESCE(users.items,'{}'::jsonb),
            ARRAY[$2],
            TO_JSONB(COALESCE((users.items->>$2)::int, 0) + 1),
            true
          )
      FROM guard
      WHERE users.user_id = guard.user_id
      RETURNING users.user_id, users.username, users.money, users.items
    )
    SELECT * FROM upd;
    `,
    [userId, key, price],
  );

  if (rows.length === 0) {
    const money = Number((await db.query('SELECT money FROM users WHERE user_id=$1', [userId])).rows[0]?.money || 0);
    if (money < price) return { ok: false, msg: `💸 Not enough coins. You need **${fmt(price)}**.` };
    return { ok: false, msg: '⚠️ Purchase failed. Please try again.' };
  }
  return { ok: true, note: `🔓 You bought a **${prettyItemName(key)}**.` };
}

function prettyItemName(key) {
  switch (key) {
    case 'gloves': return 'Gloves';
    case 'boots':  return 'Silent Boots';
    case 'key':    return 'Master Key';
    default:       return key;
  }
}

// ---------- command ----------
module.exports = {
  name: 'shop',
  description: 'View and purchase items from the shop',
  data: new SlashCommandBuilder().setName('shop').setDescription('Browse and buy items from the shop'),

  async execute(interaction, db) {
    // โหลด/สร้างโปรไฟล์ผู้ใช้
    let user = await initUser(interaction.user);
    if (!user) {
      return interaction.reply({ content: '❌ You need a profile to use the shop.', flags: MessageFlags.Ephemeral });
    }

    // ส่ง UI แรก (ephemeral)
    await interaction.reply({
      embeds: [buildShopEmbed(user)],
      components: [buildShopRow(user)],
      flags: MessageFlags.Ephemeral,
    });

    // ดึง message ของ reply แบบชัดเจน แล้วเก็บปุ่มจาก "ข้อความนั้น" (เหมาะกับ ephemeral)
    const msg = await interaction.fetchReply();

    // เก็บปุ่ม 60 วิ และจำกัดให้เจ้าของข้อความกดเท่านั้น
    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60_000,
      filter: (btn) => btn.user.id === interaction.user.id,
    });

    collector.on('collect', async (btn) => {
      await btn.deferUpdate();

      // ดึงสภาพล่าสุดก่อนคำนวณราคา
      user = await initUser(interaction.user);

      let result;
      switch (btn.customId) {
        case 'buy_bank':
          result = await buyBankUpgrade(db, user.user_id);
          break;
        case 'buy_job':
          result = await buyJobUpgrade(db, user.user_id);
          break;
        case 'buy_gloves':
          result = await buyLimitedFlagItem(db, user.user_id, 'gloves', 35_000, 1);
          break;
        case 'buy_boots':
          result = await buyLimitedFlagItem(db, user.user_id, 'boots', 30_000, 1);
          break;
        case 'buy_key':
          result = await buyStackItem(db, user.user_id, 'key', 25_000);
          break;
        default:
          result = { ok: false, msg: '❌ Unknown item.' };
      }

      if (!result.ok) {
        return interaction.followUp({ content: result.msg || '⚠️ Failed.', flags: MessageFlags.Ephemeral });
      }

      // รีเฟรช UI หลังซื้อสำเร็จ (ปิดปุ่มอัตโนมัติถ้าซื้อไม่ได้)
      user = await initUser(interaction.user);
      await interaction.editReply({
        embeds: [buildShopEmbed(user)],
        components: [buildShopRow(user)],
      });

      // แจ้งผลสั้น ๆ
      await interaction.followUp({ content: result.note || '✅ Purchased.', flags: MessageFlags.Ephemeral });
    });

    collector.on('end', async () => {
      try {
        const latest = await initUser(interaction.user);
        await interaction.editReply({
          embeds: [buildShopEmbed(latest)],
          components: [],
          content: '⏰ Shop session ended.',
        });
      } catch {}
    });
  },
};
