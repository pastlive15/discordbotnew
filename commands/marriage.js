// commands/marriage.js
// PostgreSQL-compatible Marriage Command (enhanced + race-safe + polished card)
// Features: marry, divorce, status, claim (daily couple bonus + shared streak), settitle, card (image)
// Requires: npm i @napi-rs/canvas
//
// #คอมเมนต์ไทย: ปรับแต่งให้ทุก action ปลอดภัยต่อ race condition และ UX เป็นมิตรขึ้น

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  AttachmentBuilder,
  MessageFlags
} = require('discord.js');
const { initUser } = require('../utils/initUser');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const ONE_DAY = 86_400_000; // ms

// ---- Font registration (UI + Title) ----
// #คอมเมนต์: เลือกฟอนต์ตัวแรกที่หาเจอ เพื่อกันพังในเครื่องที่ไม่มีไฟล์
function registerFirstFont(candidates) {
  for (const { path: p, name } of candidates) {
    try {
      if (fs.existsSync(p)) {
        GlobalFonts.registerFromPath(p, name);
        return name;
      }
    } catch { /* ignore */ }
  }
  return null;
}
// Title font
const TITLE_FONT_FAMILY =
  registerFirstFont([
    { path: path.join(process.cwd(), 'assets/fonts/Valentine Cute.ttf'), name: 'Valentine Cute' },
    { path: path.join(process.cwd(), 'assets/fonts/Inter-Bold.ttf'),     name: 'Inter Bold' }
  ]) || 'Arial';
// UI font
const UI_FONT_FAMILY =
  registerFirstFont([
    { path: path.join(process.cwd(), 'assets/fonts/Inter-Regular.ttf'),  name: 'Inter' },
    { path: path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf'),     name: 'DejaVu Sans' },
    { path: path.join(process.cwd(), 'assets/fonts/OpenSans-Regular.ttf'), name: 'Open Sans' }
  ]) || 'Arial';

// --- Colors ---
const COLOR = {
  RED:   0xED4245,
  GREEN: 0x57F287,
  GRAY:  0x99AAB5,
  AQUA:  0x1ABC9C,
  PINK:  0xFFC0CB
};

// Economy curve (คู่รักรับเท่ากันต่อวันตามสตรีค)
function coupleReward(streak) {
  const base = 250 + 50 * Math.min(streak, 15);
  return base;
}

// แปลง ms → "in 3h 14m"
function inTime(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!h && !m) parts.push(`${ss}s`);
  return parts.join(' ');
}

async function getUserRow(db, userId, fields = '*') {
  const res = await db.query(`SELECT ${fields} FROM users WHERE user_id = $1`, [userId]);
  return res.rows[0] || null;
}

module.exports = {
  name: 'marriage',
  description: 'Propose, claim couple rewards, set a title, or divorce',
  data: new SlashCommandBuilder()
    .setName('marriage')
    .setDescription('Propose, claim couple rewards, set a title, or divorce')
    .addSubcommand(cmd =>
      cmd.setName('marry')
        .setDescription('Propose to someone')
        .addUserOption(opt =>
          opt.setName('user').setDescription('The person you want to marry').setRequired(true)
        )
    )
    .addSubcommand(cmd =>
      cmd.setName('divorce').setDescription('End your current marriage')
    )
    .addSubcommand(cmd =>
      cmd.setName('status').setDescription('Show your marriage status, streak, and title')
    )
    .addSubcommand(cmd =>
      cmd.setName('claim').setDescription('Claim the daily couple bonus (shared streak)')
    )
    .addSubcommand(cmd =>
      cmd.setName('settitle')
        .setDescription('Set your couple title (either partner can set)')
        .addStringOption(opt =>
          opt.setName('title').setDescription('Cute couple title (max 40 chars)').setMaxLength(40).setRequired(true)
        )
    )
    .addSubcommand(cmd =>
      cmd.setName('card')
        .setDescription('Generate a couple profile card image')
        .addUserOption(opt =>
          opt.setName('user').setDescription('Optionally show for another member (defaults to you)').setRequired(false)
        )
    ),

  async execute(interaction, db) {
    const sub = interaction.options.getSubcommand(false);
    if (!sub) {
      const usage = new EmbedBuilder()
        .setColor(COLOR.GRAY)
        .setTitle('💍 Marriage Command')
        .setDescription(
          'Use one of the subcommands:\n' +
          '• **/marriage marry** `user:@someone`\n' +
          '• **/marriage status**\n' +
          '• **/marriage claim**\n' +
          '• **/marriage settitle** `title:<text>`\n' +
          '• **/marriage card** `[user:@someone]`\n' +
          '• **/marriage divorce**'
        );
      return interaction.reply({ embeds: [usage], flags: MessageFlags.Ephemeral });
    }

    const actor = interaction.user;
    const actorId = actor.id;
    const now = Date.now();

    // ให้แน่ใจว่ามีโปรไฟล์ก่อน
    await initUser(actor);
    const user = await getUserRow(db, actorId);

    // ---------- /marriage marry ----------
    if (sub === 'marry') {
      const target = interaction.options.getUser('user');
      if (!target || target.bot) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(COLOR.RED).setDescription("🤖 You can't marry a bot.")],
          flags: MessageFlags.Ephemeral
        });
      }
      if (target.id === actorId) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(COLOR.RED).setDescription("❌ You can't marry yourself.")],
          flags: MessageFlags.Ephemeral
        });
      }
      await initUser(target);

      // เช็คสถานะปัจจุบัน (ป้องกันสแปม)
      const a = await getUserRow(db, actorId, 'married_to');
      const b = await getUserRow(db, target.id, 'married_to');
      if (a?.married_to || b?.married_to) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(COLOR.RED).setDescription('💔 One of you is already married.')],
          flags: MessageFlags.Ephemeral
        });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('accept_marry').setLabel('💍 Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('decline_marry').setLabel('❌ Decline').setStyle(ButtonStyle.Danger)
      );

      const proposalEmbed = new EmbedBuilder()
        .setTitle('💘 Marriage Proposal')
        .setDescription(`**${actor.username}** wants to marry **${target.username}**. Do you accept?`)
        .setColor(COLOR.PINK);

      await interaction.reply({ content: `<@${target.id}>`, embeds: [proposalEmbed], components: [row] });

      const msg = await interaction.fetchReply();
      const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 20_000 });

      collector.on('collect', async i => {
        if (i.user.id !== target.id) {
          return i.reply({ content: "This proposal isn't for you.", flags: MessageFlags.Ephemeral });
        }

        if (i.customId === 'accept_marry') {
          await db.query('BEGIN');
          try {
            // #คอมเมนต์: กันแต่งงานซ้ำ/แย่งกันด้วย WHERE married_to IS NULL
            const upd1 = await db.query(
              `UPDATE users
               SET married_to = $1,
                   couple_streak = 0,
                   couple_last_claim = 0,
                   couple_anniv = $2
               WHERE user_id = $3 AND married_to IS NULL
               RETURNING user_id`,
              [target.id, now, actorId]
            );
            const upd2 = await db.query(
              `UPDATE users
               SET married_to = $1,
                   couple_streak = 0,
                   couple_last_claim = 0,
                   couple_anniv = $2
               WHERE user_id = $3 AND married_to IS NULL
               RETURNING user_id`,
              [actorId, now, target.id]
            );

            if (upd1.rowCount !== 1 || upd2.rowCount !== 1) {
              await db.query('ROLLBACK');
              return i.update({
                embeds: [new EmbedBuilder().setColor(COLOR.RED).setDescription('⚠️ Marriage failed: one party is no longer available.')],
                components: []
              });
            }

            await db.query('COMMIT');

            const marriedEmbed = new EmbedBuilder()
              .setTitle('💍 Married!')
              .setDescription(`**${actor.username}** and **${target.username}** are now married! 💕`)
              .setColor(COLOR.GREEN);

            return i.update({ embeds: [marriedEmbed], components: [] });
          } catch (e) {
            await db.query('ROLLBACK');
            console.error('marry accept error:', e);
            return i.update({ embeds: [new EmbedBuilder().setColor(COLOR.RED).setDescription('⚠️ Something went wrong.')], components: [] });
          }
        } else {
          const declinedEmbed = new EmbedBuilder()
            .setColor(COLOR.RED)
            .setDescription(`💔 **${target.username}** declined the proposal.`);
          return i.update({ embeds: [declinedEmbed], components: [] });
        }
      });

      collector.on('end', collected => {
        if (collected.size === 0) {
          const timeoutEmbed = new EmbedBuilder().setColor(COLOR.GRAY).setDescription('⏰ Proposal timed out.');
          interaction.editReply({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
        }
      });
      return;
    }

    // ---------- /marriage divorce ----------
    if (sub === 'divorce') {
      if (!user?.married_to) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(COLOR.RED).setDescription("❌ You're not married to anyone.")],
          flags: MessageFlags.Ephemeral
        });
      }

      const partnerId = user.married_to;
      const partner = await getUserRow(db, partnerId, 'username');

      await db.query('BEGIN');
      try {
        await db.query('UPDATE users SET married_to = NULL, couple_title = NULL WHERE user_id = $1', [actorId]);
        await db.query('UPDATE users SET married_to = NULL, couple_title = NULL WHERE user_id = $1', [partnerId]);
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        console.error('divorce error:', e);
        return interaction.reply({ content: '⚠️ Something went wrong.', flags: MessageFlags.Ephemeral });
      }

      const divorceEmbed = new EmbedBuilder()
        .setColor(COLOR.RED)
        .setTitle('💔 Divorce')
        .setDescription(`You have divorced **${partner?.username || 'your partner'}**.`);
      return interaction.reply({ embeds: [divorceEmbed] });
    }

    // ---------- /marriage status ----------
    if (sub === 'status') {
      const spouseId = user?.married_to;
      const u = await getUserRow(db, actorId, 'couple_streak, couple_last_claim, couple_anniv, couple_title, married_to');
      const embed = new EmbedBuilder().setColor(COLOR.AQUA).setTitle('💞 Marriage Status').setTimestamp();

      if (!spouseId) {
        embed.setDescription('You are currently **not married**.');
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      const spouse = await getUserRow(db, spouseId, 'username, couple_streak, couple_last_claim, couple_anniv, couple_title');
      const streak = Math.max(Number(u.couple_streak || 0), Number(spouse?.couple_streak || 0));
      const last = Math.max(Number(u.couple_last_claim || 0), Number(spouse?.couple_last_claim || 0));
      const anniv = Math.max(Number(u.couple_anniv || 0), Number(spouse?.couple_anniv || 0));
      const title = u.couple_title || spouse?.couple_title || '—';

      const nextIn = last ? Math.max(0, (last + ONE_DAY) - now) : 0;
      const annivDate = anniv ? `<t:${Math.floor(anniv / 1000)}:D>` : '—';

      embed.setDescription(`**Spouse:** ${spouse?.username ? `**${spouse.username}**` : `\`${spouseId}\``}`)
        .addFields(
          { name: 'Title', value: `${title}`, inline: true },
          { name: 'Streak', value: `${streak} days`, inline: true },
          { name: 'Next Claim', value: nextIn ? `in ${inTime(nextIn)}` : 'now', inline: true },
          { name: 'Anniversary', value: annivDate, inline: true }
        );
      return interaction.reply({ embeds: [embed] });
    }

    // ---------- /marriage claim ----------
    if (sub === 'claim') {
      if (!user?.married_to) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(COLOR.RED).setDescription("❌ You aren't married.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const partnerId = user.married_to;
      const a = await getUserRow(db, actorId, 'couple_streak, couple_last_claim, married_to, username');
      const b = await getUserRow(db, partnerId, 'couple_streak, couple_last_claim, username');
      if (!b) {
        return interaction.reply({ content: '⚠️ Your partner record is missing. Ask an admin to check the DB.', flags: MessageFlags.Ephemeral });
      }

      const last = Math.max(Number(a?.couple_last_claim || 0), Number(b?.couple_last_claim || 0));
      const nowClaimable = last === 0 || (now - last) >= ONE_DAY;
      if (!nowClaimable) {
        const nextIn = (last + ONE_DAY) - now;
        return interaction.reply({ content: `⏳ Too soon! You can claim again **in ${inTime(nextIn)}**.`, flags: MessageFlags.Ephemeral });
      }

      const within2Days = last === 0 || (now - last) <= (2 * ONE_DAY);
      const newStreak = within2Days ? Math.max(Number(a.couple_streak || 0), Number(b.couple_streak || 0)) + 1 : 1;
      const reward = coupleReward(newStreak);

      await db.query('BEGIN');
      try {
        await db.query(
          `UPDATE users
             SET couple_streak = $2,
                 couple_last_claim = $3,
                 money = money + $4
           WHERE user_id = $1`,
          [actorId, newStreak, now, reward]
        );
        await db.query(
          `UPDATE users
             SET couple_streak = $2,
                 couple_last_claim = $3,
                 money = money + $4
           WHERE user_id = $1`,
          [partnerId, newStreak, now, reward]
        );
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        console.error('couple claim error:', e);
        return interaction.reply({ content: '⚠️ Something went wrong.', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setColor(COLOR.GREEN)
        .setTitle('💞 Couple Daily Claimed')
        .setDescription(`You and **${b.username}** claimed the couple daily!`)
        .addFields(
          { name: 'Streak', value: `${newStreak} days`, inline: true },
          { name: 'Reward (each)', value: `🪙 ${reward}`, inline: true },
          { name: 'Next Claim', value: 'in 24h', inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // ---------- /marriage settitle ----------
    if (sub === 'settitle') {
      const raw = interaction.options.getString('title', true).trim();
      const cleaned = raw.replace(/\s+/g, ' ');
      if (cleaned.replace(/[\s\u2013\u2014\u2015\u2212-]/g, '').length === 0) {
        return interaction.reply({ content: '⚠️ Title can’t be only dashes or spaces.', flags: MessageFlags.Ephemeral });
      }
      if (!user?.married_to) {
        return interaction.reply({ content: '❌ You must be married to set a couple title.', flags: MessageFlags.Ephemeral });
      }

      const partnerId = user.married_to;
      await db.query('BEGIN');
      try {
        await db.query('UPDATE users SET couple_title = $2 WHERE user_id = $1', [actorId, cleaned]);
        await db.query('UPDATE users SET couple_title = $2 WHERE user_id = $1', [partnerId, cleaned]);
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        console.error('settitle error:', e);
        return interaction.reply({ content: '⚠️ Something went wrong.', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setColor(COLOR.AQUA)
        .setTitle('💖 Title Set')
        .setDescription(`Your couple title is now: **${cleaned}**`)
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // ---------- /marriage card ----------
    if (sub === 'card') {
      const target = interaction.options.getUser('user') || actor;
      await initUser(target);

      const u = await getUserRow(db, target.id, 'username, married_to, couple_streak, couple_last_claim, couple_anniv, couple_title');
      if (!u?.married_to) {
        return interaction.reply({
          content: `❌ ${target.id === actorId ? 'You are' : `${target.username} is`} not married.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const partnerUser = await interaction.client.users.fetch(u.married_to).catch(() => null);
      const partner = await getUserRow(db, u.married_to, 'username, couple_title, couple_streak, couple_anniv, couple_last_claim');

      const titleRaw = (u.couple_title || partner?.couple_title || '').trim();
      const showTitle = titleRaw.replace(/[\s\u2013\u2014\u2015\u2212-]/g, '').length > 0;

      const streak = Math.max(Number(u.couple_streak || 0), Number(partner?.couple_streak || 0));
      const anniv  = Math.max(Number(u.couple_anniv || 0), Number(partner?.couple_anniv || 0));
      const last   = Math.max(Number(u.couple_last_claim || 0), Number(partner?.couple_last_claim || 0));
      const nextInMs = last ? Math.max(0, (last + ONE_DAY) - now) : 0;

      const leftURL =
        target.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }) ||
        target.defaultAvatarURL || defaultAvatarFromId(target.id);
      const rightURL =
        partnerUser?.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }) ||
        partnerUser?.defaultAvatarURL || defaultAvatarFromId(u.married_to);

      // Canvas
      const W = 1000, H = 380;
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext('2d');

      // Background: gradient + vignette + bokeh + subtle noise
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#ffe0ee');
      bg.addColorStop(1, '#d6e8ff');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      drawVignette(ctx, W, H, 0.18);
      drawBokeh(ctx, W, H);
      drawNoise(ctx, W, H, 0.02);

      // Glass panel
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.18)';
      ctx.shadowBlur = 22;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      const r = 30;
      roundRect(ctx, 22, 22, W - 44, H - 44, r);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Heart watermark
      ctx.globalAlpha = 0.16;
      drawHeart(ctx, W/2, H/2 - 10, 150);
      ctx.globalAlpha = 1;

      // Avatars
      const leftImg  = await safeLoad(leftURL);
      const rightImg = await safeLoad(rightURL);
      drawAvatarWithRing(ctx, leftImg, 150, H/2, 98);
      drawAvatarWithRing(ctx, rightImg, W - 150, H/2, 98);

      // Title badge
      if (showTitle) {
        drawBadge(ctx, W/2, 70, 640, 56);
        ctx.fillStyle = '#222';
        ctx.font = `700 34px "${TITLE_FONT_FAMILY}"`;
        drawCenteredClamp(ctx, titleRaw, W/2, 73, 560);
      }

      // Central info
      ctx.fillStyle = '#111827';
      ctx.font = `700 34px "${UI_FONT_FAMILY}"`;
      ctx.textAlign = 'center';
      ctx.fillText(`Streak: ${streak} day${streak === 1 ? '' : 's'}`, W/2, 150);
      ctx.font = `400 26px "${UI_FONT_FAMILY}"`;
      const annivText = anniv ? new Date(anniv).toDateString() : '—';
      ctx.fillText(`Anniversary: ${annivText}`, W/2, 185);

      // Chips
      const cy = H - 110;
      drawChip(ctx, W/2 - 330, cy, 210, 40, '🔥 Streak', `${streak} day${streak === 1 ? '' : 's'}`);
      drawChip(ctx, W/2 - 100, cy, 320, 40, '🎉 Anniversary', annivText);
      drawChip(ctx, W/2 + 240, cy, 210, 40, '⏱️ Claim', nextInMs ? `in ${inTime(nextInMs)}` : 'now');

      // Progress bar (แก้พารามิเตอร์ให้ตรง signature)
      const elapsed = Math.max(0, now - last);
      const pct = Math.max(0, Math.min(1, elapsed / ONE_DAY));
      drawProgressBar(ctx, W/2 - 270, H - 58, 540, 20, pct, '#ff7bb0');

      // Names
      ctx.fillStyle = '#111827';
      ctx.font = `700 30px "${UI_FONT_FAMILY}"`;
      drawCenteredClamp(ctx, `${target.username}`, 150, H/2 + 130, 240);
      drawCenteredClamp(ctx, `${partner?.username || partnerUser?.username || u.married_to}`, W - 150, H/2 + 130, 240);

      // Attachment
      const buffer = canvas.toBuffer('image/png');
      const file = new AttachmentBuilder(buffer, { name: 'couple_card.png' });

      const embed = new EmbedBuilder()
        .setColor(COLOR.PINK)
        .setTitle('💞 Couple Profile Card')
        .setDescription(
          `**${target.username}**  💖  **${partner?.username || partnerUser?.username || 'Partner'}**` +
          (showTitle ? `\nTitle: **${titleRaw}**` : '')
        )
        .setImage('attachment://couple_card.png')
        .setTimestamp();

      return interaction.reply({ embeds: [embed], files: [file] });
    }

    // Fallback
    return interaction.reply({ content: '⚠️ Unknown subcommand.', flags: MessageFlags.Ephemeral });
  }
};

// ---------- Drawing helpers ----------
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawCenteredClamp(ctx, text, cx, y, maxWidth) {
  ctx.textAlign = 'center';
  const ellipsis = '…';
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, cx, y);
    return;
  }
  let t = text;
  while (t.length > 1 && ctx.measureText(t + ellipsis).width > maxWidth) t = t.slice(0, -1);
  ctx.fillText(t + ellipsis, cx, y);
}

function defaultAvatarFromId(userId) {
  try {
    const variant = Number((BigInt(userId) % 6n));
    return `https://cdn.discordapp.com/embed/avatars/${variant}.png`;
  } catch {
    return 'https://cdn.discordapp.com/embed/avatars/0.png';
  }
}

async function safeLoad(url) {
  try { return await loadImage(url); }
  catch { return await loadImage('https://i.imgur.com/0Z8FQh8.png'); } // tiny fallback
}

function drawAvatarWithRing(ctx, img, cx, cy, radius) {
  const ringGrad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  ringGrad.addColorStop(0, '#ff8ccf');
  ringGrad.addColorStop(1, '#89b8ff');
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 8, 0, Math.PI * 2);
  ctx.strokeStyle = ringGrad;
  ctx.lineWidth = 8;
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;
  ctx.stroke();
  ctx.shadowColor = 'transparent';

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, cx - radius, cy - radius, radius * 2, radius * 2);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawHeart(ctx, x, y, size) {
  const s = size;
  ctx.save();
  ctx.fillStyle = '#ff5fa0';
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.25);
  ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.25);
  ctx.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.85, x, y + s);
  ctx.bezierCurveTo(x, y + s * 0.85, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.25);
  ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBadge(ctx, cx, y, w, h) {
  const x = cx - w / 2;
  const grad = ctx.createLinearGradient(x, y - h/2, x + w, y + h/2);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#ffe9f3');
  ctx.fillStyle = grad;
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 2;
  roundRect(ctx, x, y - h/2, w, h, h/2);
  ctx.fill();
  ctx.stroke();
}

function drawChip(ctx, x, y, w, h, label, value) {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, h/2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#6b7280';
  ctx.font = `600 14px "${UI_FONT_FAMILY}"`;
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 14, y + h/2 - 2);

  ctx.fillStyle = '#111827';
  ctx.font = `700 16px "${UI_FONT_FAMILY}"`;
  ctx.textAlign = 'right';
  ctx.fillText(value, x + w - 14, y + h/2 - 2);
}

function drawProgressBar(ctx, x, y, w, h, pct, fillColor) {
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  roundRect(ctx, x, y, w, h, h/2);
  ctx.fill();

  const width = Math.max(0, Math.min(w, Math.round(w * pct)));
  if (width > 0) {
    const grad = ctx.createLinearGradient(x, y, x + width, y);
    grad.addColorStop(0, fillColor);
    grad.addColorStop(1, '#ffd1e6');
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, width, h, h/2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, h/2);
  ctx.stroke();
}

function drawBokeh(ctx, W, H) {
  const dots = 18;
  for (let i = 0; i < dots; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 30 + Math.random() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = Math.random() > 0.5 ? '#ffb3d9' : '#b3d1ff';
    g.addColorStop(0, `${c}66`);
    g.addColorStop(1, `${c}00`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawVignette(ctx, W, H, strength = 0.2) {
  const v = ctx.createRadialGradient(W/2, H/2, Math.min(W, H) * 0.3, W/2, H/2, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function drawNoise(ctx, W, H, alpha = 0.025) {
  const n = createCanvas(W, H);
  const nctx = n.getContext('2d');
  const img = nctx.createImageData(W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i+1] = img.data[i+2] = v;
    img.data[i+3] = Math.floor(alpha * 255);
  }
  nctx.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = 'overlay';
  ctx.drawImage(n, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}
