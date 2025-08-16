// commands/profile.js
// PostgreSQL-compatible Profile Command (polished)
// - Uses initUser(user, db) to ensure row exists
// - Handles daily timestamp stored in either ms or sec
// - Levels up if XP exceeds requirement (atomic update)
// - Uses numeric colors (no name strings)
// - Thai comments explain sections

const { EmbedBuilder, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getXPNeeded, generateProgressBar } = require('../utils/levelUtils');
const { initUser } = require('../utils/initUser');

const COLORS = {
  RED:    0xEF4444,
  BLUE:   0x3B82F6,
  GREEN:  0x22C55E,
  PURPLE: 0x8B5CF6,
  GOLD:   0xF59E0B,
  GRAY:   0x94A3B8,
};

const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

module.exports = {
  name: 'profile',
  description: "Check your or another user's profile",
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription("Check your or another user's profile")
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to check')
        .setRequired(false)
    ),

  async execute(interaction, db) {
    try {
      const targetUser = interaction.options.getUser('user') || interaction.user;

      // กัน bot
      if (targetUser.bot) {
        return interaction.reply({
          content: '🤖 Bots do not have profiles.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ให้แน่ใจว่ามีแถวใน DB และอ่านค่าใหม่ล่าสุด
      let user = await initUser(targetUser, db);
      if (!user) {
        const snap = await db.query('SELECT * FROM users WHERE user_id = $1', [targetUser.id]);
        user = snap.rows[0];
      }
      if (!user) {
        return interaction.reply({
          content: `${targetUser.username} doesn't have a profile yet. Try \`/daily\` to start!`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // ---- Level & XP handling (เลเวลอัปอัตโนมัติถ้า XP เกิน) ----
      let lvl = Number(user.level || 1);
      let xp  = Number(user.xp || 0);
      let grew = false;

      // level up loop (รองรับหลายเลเวลในครั้งเดียว)
      while (xp >= getXPNeeded(lvl)) {
        xp -= getXPNeeded(lvl);
        lvl += 1;
        grew = true;
      }

      if (grew) {
        // อัปเดตแบบอะตอมมิก
        await db.query(
          'UPDATE users SET level = $1, xp = $2 WHERE user_id = $3',
          [lvl, xp, targetUser.id]
        );
        user.level = lvl;
        user.xp = xp;
      }

      // ---- Embed color by level bracket ----
      const colorMap = [COLORS.RED, COLORS.BLUE, COLORS.GREEN, COLORS.PURPLE, COLORS.GOLD, COLORS.GRAY];
      const colorIdx = Math.min(Math.floor((Number(user.level || 1)) / 50), colorMap.length - 1);
      const embedColor = colorMap[colorIdx];

      // ---- Progress bar ----
      const xpNeeded = getXPNeeded(Number(user.level || 1));
      const progressBar = generateProgressBar(Number(user.xp || 0), xpNeeded);
      const progressPercent = Math.floor(Math.min((Number(user.xp || 0) / xpNeeded) * 100, 100));

      // ---- Daily cooldown (รองรับ last_daily เป็น ms หรือ sec) ----
      const rawDaily = Number(user.last_daily || 0);
      const isMs = rawDaily > 10 ** 12; // ถ้าใหญ่กว่า ~ Nov 2001 ถือว่าเป็น ms
      const lastDailyMs = isMs ? rawDaily : rawDaily * 1000;
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      let dailyCooldown = 'Not claimed yet';
      if (rawDaily) {
        const next = lastDailyMs + ONE_DAY_MS;
        dailyCooldown = Date.now() < next ? `<t:${Math.floor(next / 1000)}:R>` : '✅ Available now';
      }

      // ---- Title badges by level ----
      const titleMap = [
        { level: 200, title: '<:HentaiRofl:1393018895170011216> **Godly**' },
        { level: 150, title: '<:lvl150:1392202346842427504>' },
        { level: 100, title: '<:lvl100:1392202334502654123>' },
        { level: 50,  title: '<:lvl50:1392202317691883520>' },
        { level: 20,  title: '<:lvl20:1392202304266178600>' },
        { level: 10,  title: '<:lvl10:1392202115476099235>' },
        { level: 5,   title: '<:lvl5:1392202075047460966>' },
        { level: 1,   title: '<:level1:1392201947678773300>' },
      ];
      const userTitle = (titleMap.find(t => (user.level || 1) >= t.level)?.title) || '🎖️ Novice';

      // ---- Marriage status ----
      const marriageStatus = user.married_to
        ? `<a:60225flyingheartspinkx02:1392179494562824295> Married to <@${user.married_to}>`
        : '<:froggy_heartbroken:1392200178219352305> Not married';

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${targetUser.username}'s Profile`)
        .setColor(embedColor)
        .addFields(
          { name: 'Title', value: `${userTitle}`, inline: true },
          { name: 'Level', value: `🏅 ${fmt(user.level || 1)}`, inline: true },
          { name: 'XP', value: `<:stars:1392200379281834084> ${fmt(user.xp || 0)} / ${fmt(xpNeeded)}`, inline: true },
          { name: 'Coins', value: `<a:PixelCoin:1392196932926967858> ${fmt(user.money)}`, inline: true },
          { name: 'Bank', value: `🏦 ${fmt(user.bank)} / ${fmt(user.bank_limit)}`, inline: true },
          { name: 'Job Multiplier', value: `🛠️ x${(1 + Number(user.job_level || 1) * 0.05).toFixed(2)}`, inline: true },
          { name: 'Progress', value: `${progressBar} \`${progressPercent}%\``, inline: false },
          { name: 'Daily Cooldown', value: `${dailyCooldown}`, inline: true },
          { name: 'Marriage', value: `${marriageStatus}`, inline: true },
        )
        .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
        .setFooter({ text: targetUser.username, iconURL: targetUser.displayAvatarURL({ size: 64 }) })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error('profile error:', err);
      return interaction.reply({
        content: '⚠️ Something went wrong while fetching that profile.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  },
};
