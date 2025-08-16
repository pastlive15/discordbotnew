// events/interactionCreate.js
// Central interaction handler (slash-commands + Big Heist button)
// Description (EN):
// - Runs slash commands with robust error handling
// - Handles a "Big Vault Heist" button with concurrency safety
// - Uses ephemeral flags for user-facing errors
//
// #คอมเมนต์ภาษาไทย: โค้ดนี้ทำหน้าที่เป็นจุดรวมรับ interaction ทั้งหมด
// #รองรับทั้งคำสั่ง Slash และปุ่ม Big Heist พร้อมกันผิดพลาดซ้ำ/คลิกแข่งกันด้วย Set + DB row lock

const { Events, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');
const { isBigHeistActive } = require('./messageCreate'); // ปรับ path ให้ถูกกับโปรเจคของคุณ

// กันกดซ้ำบน "ข้อความเดียวกัน" ของปุ่ม Big Heist
// ใช้ message.id เป็นกุญแจ ป้องกันหลายคนกดทันทีพร้อมกันในระดับแอพ
const claimedHeistByMessage = new Set();

/**
 * Run a command and catch errors uniformly.
 * #ไทย: ฟังก์ชันเล็กๆ ช่วยจัดการ try/catch และตอบกลับผู้ใช้เวลา error
 */
async function runCommandSafe(interaction, db, bot) {
  const name = interaction.commandName;
  const command = bot?.commands?.get(name);
  if (!command) {
    console.warn(`⚠️ Unknown command: /${name}`);
    return interaction.reply({ content: '⚠️ Unknown command.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  try {
    await command.execute(interaction, db);
  } catch (err) {
    console.error(`❌ Error executing /${name}:`, err);
    // พยายามตอบกลับแบบสวยงาม (ถ้ายังไม่ตอบ)
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({
        content: '⚠️ Something went wrong while executing that command.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } else {
      // ถ้าเคยตอบแล้ว ให้ส่ง follow-up
      await interaction.followUp({
        content: '⚠️ Something went wrong while executing that command.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
}

module.exports = {
  name: Events.InteractionCreate,

  /**
   * @param {import('discord.js').Interaction} interaction
   * @param {import('discord.js').Client} bot
   * @param {import('pg').Pool} db
   */
  async execute(interaction, bot, db) {
    try {
      // --- Slash commands ---
      if (interaction.isChatInputCommand()) {
        // #ไทย: เรียกคำสั่งแบบปลอดภัย
        return await runCommandSafe(interaction, db, bot);
      }

      // --- Big Vault Heist Button ---
      if (interaction.isButton() && interaction.customId === 'vaultrob_bigheist') {
        // #ไทย: ตรวจว่า event ยัง active ไหม
        if (!isBigHeistActive?.()) {
          return interaction.reply({ content: '❌ This Big Heist has expired.', flags: MessageFlags.Ephemeral });
        }

        // #ไทย: กันกดซ้ำบนข้อความเดียวกันในระดับแอพ
        const msgId = interaction.message?.id;
        if (!msgId) {
          return interaction.reply({ content: '⚠️ Invalid heist message.', flags: MessageFlags.Ephemeral });
        }
        if (claimedHeistByMessage.has(msgId)) {
          return interaction.reply({ content: '⚠️ Someone already claimed this Big Vault Heist!', flags: MessageFlags.Ephemeral });
        }

        // #ไทย: ตั้งธงไว้ก่อน (optimistic) แล้วคุมซ้ำซ้อนใน DB อีกชั้น
        claimedHeistByMessage.add(msgId);

        // #ไทย: ทำงานในทรานแซกชัน + row lock ที่ BOT_BANK เพื่อป้องกันชนกันข้าม process/shard
        const VAULT_ID = 'BOT_BANK';
        const user = await initUser(interaction.user); // สร้าง row ถ้ายังไม่มี
        await initUser({ id: VAULT_ID, username: 'Bot Vault' });

        try {
          await db.query('BEGIN');

          // Lock vault row
          const { rows: vaultRows } = await db.query(
            `SELECT user_id, money FROM users WHERE user_id = $1 FOR UPDATE`,
            [VAULT_ID]
          );
          const vault = vaultRows[0];
          const vaultAmount = Number(vault?.money || 0);

          if (!isBigHeistActive?.()) {
            await db.query('ROLLBACK');
            return interaction.reply({ content: '❌ This Big Heist has expired.', flags: MessageFlags.Ephemeral });
          }

          if (vaultAmount < 10_000) {
            await db.query('ROLLBACK');
            return interaction.reply({ content: '🏦 The vault is nearly empty — nothing worth stealing!', flags: MessageFlags.Ephemeral });
          }

          // #ไทย: 20% - 30% แบบสุ่ม
          const stealPercent = 0.20 + Math.random() * 0.10;
          const rawStolen = Math.floor(vaultAmount * stealPercent);

          // กันค่าประหลาด
          const stolenAmount = Math.max(1, Math.min(rawStolen, vaultAmount));

          // Update user (no lock user row; balance update is idempotent here)
          await db.query(`UPDATE users SET money = money + $1 WHERE user_id = $2`, [stolenAmount, interaction.user.id]);
          // Update vault
          await db.query(`UPDATE users SET money = money - $1 WHERE user_id = $2`, [stolenAmount, VAULT_ID]);

          await db.query('COMMIT');

          // #ไทย: แสดงผลสำเร็จ และปิดปุ่ม
          const embed = new EmbedBuilder()
            .setTitle('💥 Big Vault Heist Success!')
            .setColor(0xF59E0B)
            .setDescription(
              `**${interaction.user.username}** pulled off the **Big Vault Heist**!\n\n` +
              `💰 Stolen: **${stolenAmount.toLocaleString()} coins**\n` +
              `📈 Multiplier: **${(stealPercent * 100).toFixed(2)}%**`
            )
            .setTimestamp();

          // update() จะ edit ข้อความเดิมของปุ่ม (แทนการ reply ใหม่)
          return interaction.update({ embeds: [embed], components: [] });
        } catch (err) {
          console.error('❌ Big Heist tx error:', err);
          try { await db.query('ROLLBACK'); } catch {}
          // ยกเลิกธงให้คนอื่นลองใหม่ได้ ถ้าล้มเหลวกลางทาง
          claimedHeistByMessage.delete(msgId);
          return interaction.reply({ content: '⚠️ Heist failed due to an internal error. Try again.', flags: MessageFlags.Ephemeral });
        }
      }
    } catch (outerErr) {
      console.error('❌ Interaction handler error:', outerErr);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Unexpected error.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },
};
