// Simple JSON file store. Giveaways survive a bot restart.
// On Render, point GIVEAWAY_DB_PATH at the persistent disk (see render.yaml),
// otherwise restarts on an ephemeral filesystem will lose the data file.
//
// A JSON file is used instead of SQLite because the native SQLite module
// cannot build in this sandbox (its build step is blocked), and the bot's
// data is tiny — a handful of giveaways per server — so a file rewritten
// atomically on each change is more than enough. Writes are synchronous and
// atomic (temp file + rename) so a crash mid-write never corrupts the store.
//
// Multi-server: every giveaway and raffle row carries a guild_id, and every
// list/get call filters by it, so one server never sees another's giveaways
// or raffles. Rows have TWO identifiers:
//   - id: a global counter (nextGiveawayId / nextRaffleId), unique across
//     servers. Used only internally (timers, winner records, id-only
//     lookups) — callers always resolve the row through a guild-filtered
//     get first, so an internal id can never cross over.
//   - number: a per-guild sequence starting at 1 in each server. This is
//     the number users see ("Raffle #1", "Giveaway #2") and the number they
//     pass to commands. A raffle's number only ever means something inside
//     its own server.
//
// There is no entries table: every server member is automatically in the pool,
// so the pool is read live from Discord at draw time (non-bot members only).

const path = require('node:path');
const fs = require('node:fs');

const dbPath = process.env.GIVEAWAY_DB_PATH || path.join(__dirname, '..', 'data', 'giveaways.json');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function emptyStore() {
  return { nextGiveawayId: 1, giveaways: [], winners: [], nextRaffleId: 1, raffles: [], embedRefresh: { raffles: [], giveaways: [] } };
}

// Multi-server migration: rows saved before multi-server support may lack
// a guild_id. Every row the bot has written since launch carries guild_id,
// so in practice this backfills nothing — but if a legacy row is missing
// one, attribute it to the old home guild when GUILD_ID is still set in
// the environment (it is, on the existing Render service, from the
// single-server setup). Rows that still cannot be attributed are preserved
// in the file untouched and logged, rather than guessed at: they stay
// invisible to every server instead of leaking into the wrong one.
// Runs on every load, but is idempotent — once a row has a guild_id it is
// never touched again.
function migrate(store) {
  const homeGuildId = process.env.GUILD_ID || null;
  let backfilled = 0;
  let orphaned = 0;
  for (const row of [...store.giveaways, ...store.raffles]) {
    if (row.guild_id) continue;
    if (homeGuildId) {
      row.guild_id = homeGuildId;
      backfilled += 1;
    } else {
      orphaned += 1;
    }
  }
  if (backfilled > 0) {
    console.log(`Multi-server migration: attributed ${backfilled} legacy row(s) to home guild ${homeGuildId}.`);
  }
  if (orphaned > 0) {
    console.warn(
      `Multi-server migration: ${orphaned} row(s) have no guild_id and GUILD_ID is not set — ` +
      'they are preserved in the data file but invisible to every server. ' +
      'Set GUILD_ID to the old home server ID once and restart to attribute them.',
    );
  }
  return backfilled > 0;
}

// Per-server numbering migration: giveaways and raffles used to be numbered
// from one global counter, so a raffle started in a second server could
// show up as #8 when it was that server's first. Every row now also has a
// per-guild `number` starting at 1 in each server. Rows missing one are
// numbered by creation order within their guild (oldest first), filling
// the smallest unused numbers so existing numbers are never collided with.
// Idempotent — once a row has a number it is never touched again.
// Active rows whose posted embed shows the old number are recorded in
// store.embedRefresh so the bot can re-edit those posts once on startup.
function renumberPerGuild(store) {
  const refresh = { raffles: [], giveaways: [] };
  let changed = false;
  for (const [rows, key] of [[store.raffles, 'raffles'], [store.giveaways, 'giveaways']]) {
    const byGuild = new Map();
    for (const row of rows) {
      if (!row.guild_id) continue;
      if (!byGuild.has(row.guild_id)) byGuild.set(row.guild_id, []);
      byGuild.get(row.guild_id).push(row);
    }
    for (const group of byGuild.values()) {
      group.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      const used = new Set(group.filter((r) => typeof r.number === 'number').map((r) => r.number));
      let next = 1;
      for (const row of group) {
        if (typeof row.number === 'number') continue;
        while (used.has(next)) next += 1;
        row.number = next;
        used.add(next);
        changed = true;
        if (row.status === 'active' && row.message_id) refresh[key].push(row.id);
      }
    }
  }
  if (refresh.raffles.length > 0 || refresh.giveaways.length > 0) {
    const existing = store.embedRefresh || { raffles: [], giveaways: [] };
    store.embedRefresh = {
      raffles: [...new Set([...(existing.raffles || []), ...refresh.raffles])],
      giveaways: [...new Set([...(existing.giveaways || []), ...refresh.giveaways])],
    };
    console.log(
      `Per-server numbering migration: renumbered rows in place; ` +
      `${refresh.raffles.length + refresh.giveaways.length} active post(s) will have their embeds corrected on startup.`,
    );
  }
  return changed;
}

// Next display number for a new row in a guild: one past the highest
// number already used there (missing numbers fall back to 0, so a row
// that somehow lacks one can never break the sequence).
function nextNumberForGuild(rows, guildId) {
  return rows
    .filter((r) => r.guild_id === guildId)
    .reduce((max, r) => Math.max(max, typeof r.number === 'number' ? r.number : 0), 0) + 1;
}

function load() {
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    const store = JSON.parse(raw);
    if (!store || !Array.isArray(store.giveaways) || !Array.isArray(store.winners)) return emptyStore();
    if (typeof store.nextGiveawayId !== 'number') {
      store.nextGiveawayId = store.giveaways.reduce((max, g) => Math.max(max, g.id), 0) + 1;
    }
    // Raffles were added later — old stores won't have them yet.
    if (!Array.isArray(store.raffles)) store.raffles = [];
    if (typeof store.nextRaffleId !== 'number') {
      store.nextRaffleId = store.raffles.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    }
    const changed = migrate(store) || renumberPerGuild(store);
    if (changed) saveStore(store);
    return store;
  } catch {
    return emptyStore();
  }
}

let store = load();

function saveStore(data) {
  const tmpPath = `${dbPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, dbPath);
}

function save() {
  saveStore(store);
}

function createGiveaway({ guildId, channelId, kind, prize, endsAt, target, createdBy }) {
  const giveaway = {
    id: store.nextGiveawayId++,
    number: nextNumberForGuild(store.giveaways, guildId),
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

// Finds a giveaway by its per-server number — the number users see and
// pass to commands. Resolves within the guild only.
function getGiveawayByNumber(number, guildId) {
  const g = store.giveaways.find((row) => (row.number ?? row.id) === number && row.guild_id === guildId);
  return g ? { ...g } : undefined;
}

function getGiveawayByGlobalId(giveawayId) {
  const g = store.giveaways.find((row) => row.id === giveawayId);
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

// Ended giveaways in a guild, newest first — the candidates for a reroll
// when no id is given.
function listEndedGiveaways(guildId) {
  return store.giveaways
    .filter((g) => g.guild_id === guildId && g.status === 'ended')
    .sort((a, b) => (b.ended_at || b.created_at) - (a.ended_at || a.created_at))
    .map((g) => ({ ...g }));
}

// One-time startup list of renumbered active posts whose embeds still show
// the old number. Returns the lists and clears them (persisted), so the
// correction happens once.
function takeEmbedRefresh() {
  const pending = store.embedRefresh || { raffles: [], giveaways: [] };
  const raffles = Array.isArray(pending.raffles) ? pending.raffles : [];
  const giveaways = Array.isArray(pending.giveaways) ? pending.giveaways : [];
  if (raffles.length > 0 || giveaways.length > 0) {
    store.embedRefresh = { raffles: [], giveaways: [] };
    save();
  }
  return { raffles, giveaways };
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

// ---------------------------------------------------------------------------
// Claim-your-number raffles.
// A raffle is numbers 1..max_number for one prize. Entry is free — a member
// claims numbers first come first served, and may hold as many numbers as
// they like: claiming another free number ADDS to their holdings and keeps
// the numbers they already have. Claims are stored as an object mapping
// number (as a string key) to the claiming user's ID, so one user can appear
// next to several numbers. The draw picks a random CLAIMED number, so there
// is always a winner when at least one number is claimed — and holding more
// numbers means more chances.
// ---------------------------------------------------------------------------

function createRaffle({ guildId, channelId, prize, maxNumber, createdBy }) {
  const raffle = {
    id: store.nextRaffleId++,
    number: nextNumberForGuild(store.raffles, guildId),
    guild_id: guildId,
    channel_id: channelId,
    message_id: null,
    prize,
    max_number: maxNumber,
    status: 'active',
    claims: {},
    winner_number: null,
    winner_id: null,
    created_by: createdBy,
    created_at: Date.now(),
    ended_at: null,
  };
  store.raffles.push(raffle);
  save();
  return { ...raffle, claims: { ...raffle.claims } };
}

function getRaffleById(raffleId, guildId) {
  const r = store.raffles.find((row) => row.id === raffleId && row.guild_id === guildId);
  return r ? { ...r, claims: { ...r.claims } } : undefined;
}

// Internal lookup by the global id (used by the startup embed refresh).
function getRaffleByGlobalId(raffleId) {
  const r = store.raffles.find((row) => row.id === raffleId);
  return r ? { ...r, claims: { ...r.claims } } : undefined;
}

function listActiveRaffles(guildId) {
  return store.raffles
    .filter((r) => r.guild_id === guildId && r.status === 'active')
    .sort((a, b) => a.created_at - b.created_at)
    .map((r) => ({ ...r, claims: { ...r.claims } }));
}

function setRaffleMessageId(raffleId, messageId) {
  const r = store.raffles.find((row) => row.id === raffleId);
  if (r) {
    r.message_id = messageId;
    save();
  }
}

// Claims a number for a user. Returns { ok: true, alreadyHad } on success,
// or { ok: false, error } with a plain-language reason. Claiming a free
// number ADDS it to the user's holdings — numbers already held stay held.
// Re-claiming a number the user already holds is a no-op (alreadyHad).
function claimRaffleNumber(raffleId, userId, number) {
  const r = store.raffles.find((row) => row.id === raffleId);
  if (!r) return { ok: false, error: 'raffle not found' };
  if (r.status !== 'active') return { ok: false, error: 'that raffle is closed' };
  if (!Number.isInteger(number) || number < 1 || number > r.max_number) {
    return { ok: false, error: `pick a number from 1 to ${r.max_number}` };
  }
  const key = String(number);
  const holder = r.claims[key];
  if (holder && holder !== userId) {
    return { ok: false, error: `number ${number} is already taken` };
  }
  if (holder === userId) return { ok: true, alreadyHad: true };
  r.claims[key] = userId;
  save();
  return { ok: true, alreadyHad: false };
}

function markRaffleEnded(raffleId, winnerNumber, winnerId) {
  const r = store.raffles.find((row) => row.id === raffleId);
  if (r) {
    r.status = 'ended';
    r.winner_number = winnerNumber;
    r.winner_id = winnerId;
    r.ended_at = Date.now();
    save();
  }
}

function cancelRaffle(raffleId) {
  const r = store.raffles.find((row) => row.id === raffleId);
  if (r) {
    r.status = 'cancelled';
    r.ended_at = Date.now();
    save();
  }
}

module.exports = {
  createGiveaway,
  setMessageId,
  getGiveawayByMessage,
  getGiveawayByNumber,
  getGiveawayByGlobalId,
  listActiveGiveaways,
  listEndedGiveaways,
  listPendingGiveaways,
  takeEmbedRefresh,
  markEnded,
  recordWinners,
  listPreviousWinners,
  createRaffle,
  getRaffleById,
  getRaffleByGlobalId,
  listActiveRaffles,
  setRaffleMessageId,
  claimRaffleNumber,
  markRaffleEnded,
  cancelRaffle,
};
