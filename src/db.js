// Simple JSON file store. Giveaways survive a bot restart.
// On Render, point GIVEAWAY_DB_PATH at the persistent disk (see render.yaml),
// otherwise restarts on an ephemeral filesystem will lose the data file.
//
// A JSON file is used instead of SQLite because the native SQLite module
// cannot build in this sandbox (its build step is blocked), and the bot's
// data is tiny — a handful of giveaways for one server — so a file rewritten
// atomically on each change is more than enough. Writes are synchronous and
// atomic (temp file + rename) so a crash mid-write never corrupts the store.
//
// There is no entries table: every server member is automatically in the pool,
// so the pool is read live from Discord at draw time (non-bot members only).

const path = require('node:path');
const fs = require('node:fs');

const dbPath = process.env.GIVEAWAY_DB_PATH || path.join(__dirname, '..', 'data', 'giveaways.json');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function emptyStore() {
  return { nextGiveawayId: 1, giveaways: [], winners: [] };
}

function load() {
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    const store = JSON.parse(raw);
    if (!store || !Array.isArray(store.giveaways) || !Array.isArray(store.winners)) return emptyStore();
    if (typeof store.nextGiveawayId !== 'number') {
      store.nextGiveawayId = store.giveaways.reduce((max, g) => Math.max(max, g.id), 0) + 1;
    }
    return store;
  } catch {
    return emptyStore();
  }
}

let store = load();

function save() {
  const tmpPath = `${dbPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, dbPath);
}

function createGiveaway({ guildId, channelId, kind, prize, endsAt, target, createdBy }) {
  const giveaway = {
    id: store.nextGiveawayId++,
    guild_id: guildId,
    channel_id: channelId,
    message_id: null,
    kind,
    prize,
    ends_at: endsAt ?? null,
    target: target ?? null,
    status: 'active',
    created_by: createdBy,
    created_at: Date.now(),
    ended_at: null,
  };
  store.giveaways.push(giveaway);
  save();
  return { ...giveaway };
}

function setMessageId(giveawayId, messageId) {
  const g = store.giveaways.find((row) => row.id === giveawayId);
  if (g) {
    g.message_id = messageId;
    save();
  }
}

function getGiveawayByMessage(messageId, guildId) {
  const g = store.giveaways.find((row) => row.message_id === messageId && row.guild_id === guildId);
  return g ? { ...g } : undefined;
}

function listActiveGiveaways(guildId) {
  return store.giveaways
    .filter((g) => g.guild_id === guildId && g.status === 'active')
    .sort((a, b) => a.created_at - b.created_at)
    .map((g) => ({ ...g }));
}

function listPendingGiveaways() {
  return store.giveaways
    .filter((g) => g.status === 'active')
    .sort((a, b) => a.created_at - b.created_at)
    .map((g) => ({ ...g }));
}

function markEnded(giveawayId) {
  const g = store.giveaways.find((row) => row.id === giveawayId);
  if (g) {
    g.status = 'ended';
    g.ended_at = Date.now();
    save();
  }
}

function recordWinners(giveawayId, userIds) {
  const existing = store.winners.filter((w) => w.giveaway_id === giveawayId);
  const drawNo = existing.reduce((max, w) => Math.max(max, w.draw_no), 0) + 1;
  for (const userId of userIds) {
    if (!existing.some((w) => w.user_id === userId && w.draw_no === drawNo)) {
      store.winners.push({ giveaway_id: giveawayId, user_id: userId, draw_no: drawNo });
    }
  }
  save();
  return drawNo;
}

function listPreviousWinners(giveawayId) {
  return store.winners.filter((w) => w.giveaway_id === giveawayId).map((w) => w.user_id);
}

module.exports = {
  createGiveaway,
  setMessageId,
  getGiveawayByMessage,
  listActiveGiveaways,
  listPendingGiveaways,
  markEnded,
  recordWinners,
  listPreviousWinners,
};
