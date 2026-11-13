// Claim-your-number raffle embeds and the draw itself.
// Free entry only: a member claims one number (1..max_number), first come
// first served. The draw picks a random CLAIMED number, so there is always a
// winner when at least one number is claimed. Winners are announced by tag
// in the channel. This bot NEVER sends DMs.

const { EmbedBuilder } = require('discord.js');
const db = require('./db');

const BLUE = 0x3498db;

function discordTimestamp(ms) {
  const seconds = Math.floor(ms / 1000);
  return { relative: `<t:${seconds}:R>`, full: `<t:${seconds}:F>` };
}

function claimedNumbers(raffle) {
  return Object.keys(raffle.claims)
    .map(Number)
    .sort((a, b) => a - b);
}

function buildRaffleEmbed(raffle, ended) {
  const claimed = claimedNumbers(raffle);
  const title = raffle.status === 'cancelled'
    ? '🎟️ Raffle Cancelled'
    : ended
      ? '🎟️ Raffle Ended'
      : '🎟️ Number Raffle!';
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x808080 : BLUE)
    .setTitle(title)
    .addFields(
      { name: 'Prize', value: raffle.prize, inline: false },
      { name: 'Numbers', value: `Pick a number from **1 to ${raffle.max_number}** — free, one per person`, inline: false },
      { name: 'Claimed', value: `${claimed.length} of ${raffle.max_number} numbers taken`, inline: true },
    );

  if (raffle.ends_at && !ended) {
    const ts = discordTimestamp(raffle.ends_at);
    embed.addFields({ name: 'Draws', value: `${ts.relative} (${ts.full})`, inline: true });
  } else if (!ended) {
    embed.addFields({ name: 'Draws', value: 'When a mod runs `/raffle draw`', inline: true });
  }

  if (claimed.length > 0) {
    const lines = claimed.map((n) => `${n} — <@${raffle.claims[String(n)]}>`);
    // Embed field values cap at 1024 characters — truncate a long board.
    let text = lines.join('\n');
    if (text.length > 1000) {
      text = `${text.slice(0, 1000)}…`;
    }
    embed.addFields({ name: 'Board', value: text, inline: false });
  } else if (!ended) {
    embed.addFields({ name: 'Board', value: 'No numbers claimed yet — be the first!', inline: false });
  }

  if (ended && raffle.status === 'cancelled') {
    embed.addFields({ name: 'Winner', value: 'Cancelled — no winner', inline: false });
  } else if (ended && raffle.winner_id) {
    embed.addFields({
      name: 'Winner',
      value: `<@${raffle.winner_id}> with number **${raffle.winner_number}**`,
      inline: false,
    });
  } else if (ended) {
    embed.addFields({ name: 'Winner', value: 'No numbers were claimed', inline: false });
  }

  embed.setFooter({
    text: `Raffle #${raffle.id}${raffle.message_id ? ` · Message ID: ${raffle.message_id}` : ''} · Free entry — no money, no paid numbers`,
  });
  return embed;
}

async function fetchRaffleMessage(client, raffle) {
  try {
    const channel = await client.channels.fetch(raffle.channel_id);
    if (!channel || !channel.isTextBased()) return { channel, message: null };
    const message = await channel.messages.fetch(raffle.message_id).catch(() => null);
    return { channel, message };
  } catch {
    return { channel: null, message: null };
  }
}

// Draws the raffle: picks one random CLAIMED number and announces its holder
// as the winner. Returns { winnerNumber, winnerId }, or null when no number
// was claimed (the raffle is still closed with no winner). Callers that draw
// on a mod's command should refuse the null case first; the timed auto-draw
// closes the raffle and announces that nobody claimed a number.
async function drawRaffle(client, raffle) {
  const claimed = claimedNumbers(raffle);
  const { channel, message } = await fetchRaffleMessage(client, raffle);

  if (claimed.length === 0) {
    db.markRaffleEnded(raffle.id, null, null);
    const ended = { ...raffle, status: 'ended', winner_number: null, winner_id: null };
    if (message) {
      await message.edit({ embeds: [buildRaffleEmbed(ended, true)] }).catch(() => null);
    }
    if (channel && channel.isTextBased()) {
      await channel
        .send(`🎟️ The raffle for **${raffle.prize}** ended with no numbers claimed, so there is no winner.`)
        .catch(() => null);
    }
    return null;
  }

  const winnerNumber = claimed[Math.floor(Math.random() * claimed.length)];
  const winnerId = raffle.claims[String(winnerNumber)];

  db.markRaffleEnded(raffle.id, winnerNumber, winnerId);
  const ended = { ...raffle, status: 'ended', winner_number: winnerNumber, winner_id: winnerId };
  if (message) {
    await message.edit({ embeds: [buildRaffleEmbed(ended, true)] }).catch(() => null);
  }
  if (channel && channel.isTextBased()) {
    await channel
      .send(`🎟️ Congratulations <@${winnerId}>! Number **${winnerNumber}** was drawn — you won **${raffle.prize}**!`)
      .catch(() => null);
  }
  return { winnerNumber, winnerId };
}

module.exports = {
  claimedNumbers,
  buildRaffleEmbed,
  fetchRaffleMessage,
  drawRaffle,
};
