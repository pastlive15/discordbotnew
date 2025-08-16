// commands/inventory.js
// อินเวนทอรี (ออกแบบใหม่ + ปรับประสิทธิภาพ + ดูของคนอื่นได้)
// - แสดงเป็นหน้าๆ (หลายรายการต่อหน้า แทน 1 หน้า/1 ไอเท็ม)
// - ปุ่มเลื่อนซ้าย/ขวา + ปุ่มปิด + ตัวเลขหน้า
// - เพิ่ม optional: /inventory user:@someone
// - รองรับไอเท็มที่ไม่รู้จัก (fallback แสดงเป็น 🧩 <key>)
// - ใช้ ephemeral ด้วย MessageFlags เพื่อกันสแปม

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

// สี (ใช้เลข hex ปลอดภัยกับ setColor)
const COLORS = {
  PURPLE: 0x8b5cf6,
  GRAY: 0x94a3b8,
  GREEN: 0x22c55e,
  RED: 0xef4444,
};

const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

// แมปไอเท็มที่ “รู้จัก” (ข้อความใน Embed เป็นภาษาอังกฤษ)
// #หมายเหตุ: เพิ่มไอเท็มใหม่ที่นี่ได้เลย
const KNOWN_ITEMS = {
  gloves: {
    name: '🧤 Gloves',
    describe: () => 'Increase /steal success chance by **+5%** (max 1).',
  },
  boots: {
    name: '🥾 Silent Boots',
    describe: () => 'Halves your /steal fine if caught (max 1).',
  },
  key: {
    name: '🔓 Master Key',
    describe: () => 'Doubles your next **vaultrob** reward (consumed).',
  },
};

// แปลง items JSON → array แสดงผล (ตัด 0 ออก) + รองรับคีย์ที่ไม่รู้จัก
function materializeInventory(itemsJson) {
  const items = itemsJson || {};
  const rows = [];
  for (const [key, rawQty] of Object.entries(items)) {
    const qty = Number(rawQty || 0);
    if (qty <= 0) continue;

    const known = KNOWN_ITEMS[key];
    if (known) {
      rows.push({
        key,
        name: known.name,
        qty,
        description: known.describe(),
        order: 0, // #Comment: ให้ไอเท็มที่รู้จักเรียงขึ้นก่อน
      });
    } else {
      // fallback สำหรับไอเท็มที่ยังไม่ถูกแมป
      rows.push({
        key,
        name: `🧩 ${key}`,
        qty,
        description: 'Unrecognized item (added by an update or event).',
        order: 1, // #Comment: ไม่รู้จัก → เรียงต่อท้าย
      });
    }
  }
  return rows;
}

// ตัดหน้า: แบ่งเป็นกลุ่มละ N รายการต่อหน้า
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// สร้าง Embed ของหน้าที่กำหนด
function buildPageEmbed(username, pageItems, pageIdx, pageTotal, totals) {
  const embed = new EmbedBuilder()
    .setTitle(`🎒 ${username}'s Inventory`)
    .setColor(COLORS.PURPLE)
    .setDescription(
      pageItems
        .map((it) => `**${it.name}** × **${fmt(it.qty)}**\n${it.description}`)
        .join('\n\n')
    )
    .setFooter({
      text: `Items: ${fmt(totals.count)} • Distinct: ${fmt(
        totals.distinct
      )} • Page ${pageIdx + 1}/${pageTotal}`,
    })
    .setTimestamp();
  return embed;
}

// ปุ่มควบคุม
function buildRowControls(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('inv_prev')
      .setEmoji('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('inv_next')
      .setEmoji('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('inv_close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

module.exports = {
  name: 'inventory',
  description: 'Check your or another user’s usable item inventory',
  data: new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('View a usable item inventory')
    .addUserOption((o) =>
      o
        .setName('user')
        .setDescription('User to view (defaults to you)')
        .setRequired(false)
    ),

  async execute(interaction) {
    // เลือกเป้าหมาย (ถ้าไม่เลือก → ตัวเอง)
    const target = interaction.options.getUser('user') || interaction.user;

    // โหลด/สร้างผู้ใช้ (กัน null)
    const user = await initUser(target);
    if (!user) {
      return interaction.reply({
        content:
          target.id === interaction.user.id
            ? '❌ You need a profile to view your inventory.'
            : `❌ ${target.username} does not have a profile yet.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // แปลง items → array ที่แสดงผลได้
    const inv = materializeInventory(user.items);

    if (inv.length === 0) {
      return interaction.reply({
        content:
          target.id === interaction.user.id
            ? '📦 Your inventory is empty.'
            : `📦 ${target.username}'s inventory is empty.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // เรียง: ไอเท็มที่รู้จักก่อน แล้วค่อยตามชื่อ
    inv.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    // สรุปรวมยอด
    const totals = {
      count: inv.reduce((a, b) => a + b.qty, 0),
      distinct: inv.length,
    };

    // แบ่งหน้า: 6 รายการ/หน้า
    const pages = chunk(inv, 6);
    let page = 0;

    const embed = buildPageEmbed(target.username, pages[page], page, pages.length, totals);
    const row = buildRowControls(pages.length <= 1);

    const msg = await interaction.reply({
      embeds: [embed],
      components: pages.length > 1 ? [row] : [],
      flags: MessageFlags.Ephemeral,
    });

    if (pages.length <= 1) return; // หน้าเดียวไม่ต้องตั้ง collector

    // เก็บ event เฉพาะเจ้าของ interaction + ผูกกับข้อความนี้
    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60_000,
      filter: (btn) =>
        btn.user.id === interaction.user.id && btn.message.id === msg.id,
    });

    collector.on('collect', async (btn) => {
      try {
        await btn.deferUpdate();
      } catch {
        return;
      }

      if (btn.customId === 'inv_close') {
        collector.stop('closed');
        return;
      }

      if (btn.customId === 'inv_prev') {
        page = (page - 1 + pages.length) % pages.length; // วนซ้าย
      } else if (btn.customId === 'inv_next') {
        page = (page + 1) % pages.length; // วนขวา
      }

      const newEmbed = buildPageEmbed(
        target.username,
        pages[page],
        page,
        pages.length,
        totals
      );
      try {
        await interaction.editReply({ embeds: [newEmbed], components: [row] });
      } catch {}
    });

    collector.on('end', async () => {
      try {
        await interaction.editReply({ components: [buildRowControls(true)] });
      } catch {}
    });
  },
};
