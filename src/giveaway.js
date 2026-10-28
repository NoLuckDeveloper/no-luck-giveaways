// Giveaway embeds, pool reads, and the draw itself.
// Pool rule: every non-bot member of the server, read live from Discord.
// Winners are announced by tag in the channel. This bot NEVER sends DMs.

const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { pickWinners } = require('./duration');

const GOLD = 0xFFD700;

function discordTimestamp(ms) {
  const seconds = Math.floor(ms / 1000);
  return { relative: `<t:${seconds}:R>`, full: `<t:${seconds}:F>` };
}

// The live pool: all non-bot member IDs in the guild.
async function fetchPool(guild) {
  const members = await guild.members.fetch();
  return members.filter((m) => !m.user.bot).map((m) => m.id);
}

function buildTimedEmbed(giveaway, poolSize, ended, winnerId) {
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x808080 : GOLD)
    .setTitle(ended ? '🎉 Giveaway Ended' : '🎉 Giveaway!')
    .addFields(
      { name: 'Prize', value: giveaway.prize, inline: false },
      { name: 'Entered', value: 'Every server member is entered automatically', inline: false },
      { name: 'Pool size', value: `${poolSize} members`, inline: true },
    );

  if (giveaway.ends_at) {
    const ts = discordTimestamp(giveaway.ends_at);
    embed.addFields({ name: 'Ends', value: `${ts.relative} (${ts.full})`, inline: true });
  }

  if (ended && winnerId) {
    embed.addFields({ name: 'Winner', value: `<@${winnerId}>`, inline: false });
  } else if (ended) {
    embed.addFields({ name: 'Winner', value: 'No eligible members', inline: false });
  }

  if (giveaway.message_id) {
    embed.setFooter({ text: `Message ID: ${giveaway.message_id} · Bots can't win` });
  } else {
    embed.setFooter({ text: 'Bots can\'t win' });
  }
  return embed;
}

function buildMilestoneEmbed(giveaway, currentCount, ended, winnerId) {
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x808080 : GOLD)
    .setTitle(ended ? '🎉 Giveaway Ended' : '🎉 Milestone Giveaway!')
    .addFields(
      { name: 'Prize', value: giveaway.prize, inline: false },
      { name: 'Milestone', value: `Draws when the server reaches **${giveaway.target} members**`, inline: false },
      { name: 'Members now', value: `${currentCount} members`, inline: true },
      { name: 'Entered', value: 'Every server member is entered automatically', inline: false },
    );

  if (ended && winnerId) {
    embed.addFields({ name: 'Winner', value: `<@${winnerId}>`, inline: false });
  } else if (ended) {
    embed.addFields({ name: 'Winner', value: 'No eligible members', inline: false });
  }

  if (giveaway.message_id) {
    embed.setFooter({ text: `Message ID: ${giveaway.message_id} · Bots can't win` });
  } else {
    embed.setFooter({ text: 'Bots can\'t win' });
  }
  return embed;
}

function buildEmbed(giveaway, poolSize, ended, winnerId) {
  if (giveaway.kind === 'milestone') {
    return buildMilestoneEmbed(giveaway, poolSize, ended, winnerId);
  }
  return buildTimedEmbed(giveaway, poolSize, ended, winnerId);
}

async function fetchGiveawayMessage(client, giveaway) {
  try {
    const channel = await client.channels.fetch(giveaway.channel_id);
    if (!channel || !channel.isTextBased()) return { channel, message: null };
    const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
    return { channel, message };
  } catch {
    return { channel: null, message: null };
  }
}

// Draws exactly 1 winner for a giveaway, updates its message, and announces
// the winner by tag in the channel. `reroll` marks the announcement as a reroll
// and prefers members who have not won this giveaway before.
// Returns the winner's user ID, or null if nobody was eligible.
async function drawGiveaway(client, giveaway, { reroll = false } = {}) {
  const guild = await client.guilds.fetch(giveaway.guild_id);
  const pool = await fetchPool(guild);

  let winnerId = null;
  if (pool.length > 0) {
    let candidates = pool;
    if (reroll) {
      const previous = new Set(db.listPreviousWinners(giveaway.id));
      const fresh = pool.filter((id) => !previous.has(id));
      if (fresh.length > 0) candidates = fresh;
    }
    [winnerId] = pickWinners(candidates, 1);
  }

  db.markEnded(giveaway.id);
  if (winnerId) db.recordWinners(giveaway.id, [winnerId]);

  const { channel, message } = await fetchGiveawayMessage(client, giveaway);
  const poolSize = guild.memberCount;
  if (message) {
    await message.edit({ embeds: [buildEmbed(giveaway, poolSize, true, winnerId)] }).catch(() => null);
  }

  if (channel && channel.isTextBased()) {
    if (winnerId) {
      const milestoneLine =
        giveaway.kind === 'milestone' && !reroll ? ` We hit **${giveaway.target} members**!` : '';
      const rerollLine = reroll ? ' Reroll!' : '';
      await channel.send(
        `🎉${rerollLine} Congratulations <@${winnerId}>! You won **${giveaway.prize}**!${milestoneLine}`,
      ).catch(() => null);
    } else {
      await channel.send(`🎉 The giveaway for **${giveaway.prize}** ended with no eligible members.`).catch(() => null);
    }
  }

  return winnerId;
}

// Checks every active milestone giveaway in a guild against the guild's
// current member count (guild.memberCount, the number Discord reports).
// Draws any whose target has been reached or passed. Returns the giveaways drawn.
async function checkMilestones(client, guild) {
  const drawn = [];
  const active = db.listActiveGiveaways(guild.id).filter((g) => g.kind === 'milestone');
  for (const giveaway of active) {
    if (guild.memberCount >= giveaway.target) {
      await drawGiveaway(client, giveaway);
      drawn.push(giveaway);
    }
  }
  return drawn;
}

module.exports = {
  fetchPool,
  buildEmbed,
  buildTimedEmbed,
  buildMilestoneEmbed,
  drawGiveaway,
  checkMilestones,
};
