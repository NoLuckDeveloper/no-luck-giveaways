// One-time correction after the per-server numbering migration: active
// posts that were renumbered still show the old (global) number in their
// embed footer. Re-edit each one so it shows its per-server number. The
// list is consumed (and cleared) by db.takeEmbedRefresh, so this only ever
// runs once per renumbering. Posts that are gone or can't be fetched are
// skipped — the stored numbers are correct either way, and ended posts
// keep their original footers as history.

const db = require('./db');
const { buildRaffleEmbed, fetchRaffleMessage } = require('./raffle');
const { buildEmbed, fetchGiveawayMessage } = require('./giveaway');

async function refreshRenumberedEmbeds(client) {
  const pending = db.takeEmbedRefresh();
  const raffleIds = pending.raffles || [];
  const giveawayIds = pending.giveaways || [];
  if (raffleIds.length === 0 && giveawayIds.length === 0) return 0;
  let updated = 0;
  for (const id of raffleIds) {
    const raffle = db.getRaffleByGlobalId(id);
    if (!raffle || raffle.status !== 'active' || !raffle.message_id) continue;
    const { message } = await fetchRaffleMessage(client, raffle);
    if (message) {
      await message.edit({ embeds: [buildRaffleEmbed(raffle, false)] }).catch(() => null);
      updated += 1;
    }
  }
  for (const id of giveawayIds) {
    const giveaway = db.getGiveawayByGlobalId(id);
    if (!giveaway || giveaway.status !== 'active' || !giveaway.message_id) continue;
    const { message } = await fetchGiveawayMessage(client, giveaway);
    if (message) {
      const guild = await client.guilds.fetch(giveaway.guild_id).catch(() => null);
      await message
        .edit({ embeds: [buildEmbed(giveaway, guild ? guild.memberCount : 0, false, null)] })
        .catch(() => null);
      updated += 1;
    }
  }
  console.log(`Renumbered embeds refreshed: ${updated} post(s) updated to show per-server numbers.`);
  return updated;
}

module.exports = { refreshRenumberedEmbeds };
