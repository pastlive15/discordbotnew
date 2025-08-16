// commands/vault.js
// Vault viewer (uses taxUtils source of truth)
// Description (EN): View how much tax money is stored in the bot's virtual vault.
//
// #คอมเมนต์(TH):
// - ใช้ getVaultBalance() แทนการเรียก initUser() เพื่ออ่านยอดคลังภาษีจากจุดเดียว
// - คืนค่าเป็น embed สวย ๆ และกันเคส DB ว่าง

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getVaultBalance } = require('../utils/taxUtils'); // ต้องมีฟังก์ชันนี้ตามที่เรารีแฟกเตอร์ไว้

const COLORS = {
  GOLD: 0xf1c40f,
  GRAY: 0x99aab5,
};

const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

module.exports = {
  name: 'vault',
  description: 'Check how much tax money is stored in the bot vault',
  data: new SlashCommandBuilder()
    .setName('vault')
    .setDescription("View the bank's stored taxes"),

  async execute(interaction) {
    try {
      // อ่านยอดจาก taxUtils (atomic source of truth)
      const total = await getVaultBalance(); // number

      const embed = new EmbedBuilder()
        .setTitle('🏦 Vault Balance')
        .setColor(total > 0 ? COLORS.GOLD : COLORS.GRAY)
        .setDescription(
          total > 0
            ? `The bank has collected **${fmt(total)}** coins in tax revenue.`
            : `The vault is currently **empty**.`
        )
        .setFooter({ text: 'Collected from all users via transaction taxes' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error('vault command error:', err);
      return interaction.reply({
        content: '⚠️ Failed to read the vault balance. Please try again later.',
        ephemeral: true,
      });
    }
  },
};
