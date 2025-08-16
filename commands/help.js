// commands/help.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');

module.exports = {
  name: 'help',
  description: 'Show all commands or details for a specific command',
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all commands or details for a specific command')
    .addStringOption(opt =>
      opt
        .setName('command')
        .setDescription('Get detailed help for a specific command (by name)')
        .setRequired(false)
    ),

  async execute(interaction) {
    try {
      const cmdName = interaction.options.getString('command');
      const commandsMap = interaction.client.commands; // filled by your loader
      if (!commandsMap || commandsMap.size === 0) {
        return interaction.reply({
          content: 'No commands are currently loaded.',
          ephemeral: true,
        });
      }

      // ---------- Specific command help ----------
      if (cmdName) {
        const key = cmdName.toLowerCase();
        const found =
          commandsMap.get(key) ||
          [...commandsMap.values()].find(
            c => (c.data?.name || c.name || '').toLowerCase() === key
          );

        if (!found) {
          return interaction.reply({
            content: `Command \`${cmdName}\` not found. Use \`/help\` to see the full list.`,
            ephemeral: true,
          });
        }

        const name = found.data?.name || found.name || cmdName;
        const desc =
          found.data?.description ||
          found.description ||
          'No description provided.';
        const usage = found.usage
          ? Array.isArray(found.usage)
            ? found.usage.join('\n')
            : String(found.usage)
          : `/${name}`;
        const examples = found.examples
          ? Array.isArray(found.examples)
            ? found.examples.join('\n')
            : String(found.examples)
          : null;

        const embed = new EmbedBuilder()
          .setTitle(`ℹ️ Help: /${name}`)
          .setColor(0x5865f2)
          .setDescription(desc)
          .addFields(
            { name: 'Usage', value: `\`${usage}\`` },
            ...(examples
              ? [{ name: 'Examples', value: '```' + examples + '```' }]
              : [])
          )
          .setThumbnail(interaction.client.user.displayAvatarURL({ size: 128 }))
          .setFooter({
            text: `${interaction.user.tag}`,
            iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
          })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // ---------- All commands list ----------
      const list = [...commandsMap.values()]
        .map(c => ({
          name: c.data?.name || c.name,
          desc: c.data?.description || c.description || '—',
        }))
        .filter(x => !!x.name)
        .sort((a, b) => a.name.localeCompare(b.name));

      const lines = list.map(x => `• **/${x.name}** — ${x.desc}`);
      const chunks = [];
      let buf = '';
      for (const line of lines) {
        if ((buf + '\n' + line).length > 1024) {
          chunks.push(buf);
          buf = line;
        } else {
          buf = buf ? `${buf}\n${line}` : line;
        }
      }
      if (buf) chunks.push(buf);

      const embed = new EmbedBuilder()
        .setTitle('📚 Command List')
        .setColor(0x5865f2)
        .setDescription(
          `Use \`/help command:<name>\` to get details about a specific command\n` +
            `Example: \`/help command:ping\``
        )
        .addFields(
          ...chunks.map((chunk, idx) => ({
            name: idx === 0 ? 'Available Commands' : '\u200b',
            value: chunk,
          }))
        )
        .setThumbnail(interaction.client.user.displayAvatarURL({ size: 128 }))
        .setFooter({
          text: `${interaction.user.tag}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
        })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (err) {
      console.error('help.js error:', err);
      const names = [...(interaction.client.commands?.keys() || [])]
        .map(n => `/${n}`)
        .join(', ');
      const content =
        names || 'No commands found. Add files to the commands/ folder first.';
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content }).catch(() => {});
      }
      return interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  },
};
