// commands/ping.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  version: djsVersion,
} = require('discord.js');

module.exports = {
  name: 'ping',
  description: "Check the bot's latency",
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription("Check the bot's latency"),

  async execute(interaction) {
    try {
      const started = Date.now();
      // ตอบทันทีเพื่อกัน timeout และใช้เป็นจุดอ้างอิงเวลา
      await interaction.deferReply();

      const ws = Math.round(interaction.client.ws.ping);
      const rtt = Date.now() - started;

      // uptime ของบอท (ms -> hh:mm:ss)
      const uptimeMs = interaction.client.uptime ?? 0;
      const h = Math.floor(uptimeMs / 3600000);
      const m = Math.floor((uptimeMs % 3600000) / 60000);
      const s = Math.floor((uptimeMs % 60000) / 1000);
      const uptime = `${h.toString().padStart(2, '0')}:${m
        .toString()
        .padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

      // สีตามระดับ latency
      const color =
        ws < 100 ? 0x22c55e : ws < 250 ? 0xeab308 : 0xef4444; // green / amber / red

      const botUser = interaction.client.user;
      const embed = new EmbedBuilder()
        .setTitle('🏓 Pong!')
        .setColor(color)
        .setThumbnail(botUser.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: '📶 Round-trip', value: `\`${rtt}ms\``, inline: true },
          { name: '🛰️ WebSocket', value: `\`${ws}ms\``, inline: true },
          { name: '⏱️ Uptime', value: `\`${uptime}\``, inline: true },
          {
            name: '🧩 Runtime',
            value: `Node \`${process.versions.node}\` · discord.js \`${djsVersion}\``,
            inline: false,
          },
        )
        .setTimestamp()
        .setFooter({
          text: `${interaction.user.tag}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
        });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      // fallback แบบข้อความล้วนในกรณี embed ล้มเหลว
      const ws = Math.round(interaction.client.ws.ping);
      const msg = `Pong! WS: ${ws}ms`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
      }
    }
  },
};
