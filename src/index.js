// Mythic's Gathering giveaway bot. Also runs claim-your-number raffles
// (/raffle) — free entry, one number per person, draw picks a random
// claimed number. See README.md for both command sets.
// Env vars (never put secrets in code):
//   DISCORD_TOKEN — bot token from discord.com/developers
//   CLIENT_ID     — application ID from discord.com/developers
//   GUILD_ID      — the Mythic's Gathering server ID (guild commands, fast updates)
//   GIVEAWAY_DB_PATH (optional) — JSON data file location, default ./data/giveaways.json
//
// Intents: Guilds + GuildMembers. GuildMembers ("Server Members Intent" in the
// Developer Portal) is what lets the bot see member joins for milestone
// giveaways and read the member list for the draw. It is not a privileged
// approval-gated intent for a bot in a single small server — just flip the
// toggle on. No message-content intent is needed: the bot never reads messages.

const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const db = require('./db');
const { commandData, handleGiveawayCommand } = require('./commands');
const { raffleCommandData, handleRaffleCommand } = require('./raffle-commands');
const { drawGiveaway, checkMilestones } = require('./giveaway');
const { drawRaffle } = require('./raffle');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}. Set it and start the bot again (see README.md).`);
    process.exit(1);
  }
  return value;
}

const token = requireEnv('DISCORD_TOKEN');
const clientId = requireEnv('CLIENT_ID');
const guildId = requireEnv('GUILD_ID');

// Active timed-giveaway timers, keyed by giveaway row id.
const timers = new Map();
// Active timed-raffle timers, keyed by raffle row id (separate map —
// raffle ids and giveaway ids are independent sequences).
const raffleTimers = new Map();

function scheduleTimedDraw(client, giveaway) {
  const delay = giveaway.ends_at - Date.now();
  if (delay <= 0) {
    // The bot was down past the end time — draw right away on startup.
    drawGiveaway(client, giveaway).catch((err) => console.error(`Draw failed for giveaway ${giveaway.id}:`, err));
    return;
  }
  timers.set(giveaway.id, setTimeout(() => {
    timers.delete(giveaway.id);
    drawGiveaway(client, giveaway).catch((err) => console.error(`Draw failed for giveaway ${giveaway.id}:`, err));
  }, delay));
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: [commandData.toJSON(), raffleCommandData.toJSON()],
  });
  console.log(`Registered /giveaway and /raffle commands for guild ${guildId}.`);
}

function scheduleTimedRaffleDraw(client, raffle) {
  const delay = raffle.ends_at - Date.now();
  if (delay <= 0) {
    // The bot was down past the end time — draw right away on startup.
    // With no claims the draw closes the raffle and announces no winner.
    drawRaffle(client, raffle).catch((err) => console.error(`Raffle draw failed for raffle ${raffle.id}:`, err));
    return;
  }
  raffleTimers.set(raffle.id, setTimeout(() => {
    raffleTimers.delete(raffle.id);
    drawRaffle(client, raffle).catch((err) => console.error(`Raffle draw failed for raffle ${raffle.id}:`, err));
  }, delay));
}

async function resumePending(client) {
  const pending = db.listPendingGiveaways().filter((g) => g.guild_id === guildId);
  for (const giveaway of pending) {
    if (giveaway.kind === 'milestone') {
      // Milestones are checked on joins and on startup, below.
      continue;
    }
    scheduleTimedDraw(client, giveaway);
  }
  // If the server already hit a milestone target while the bot was down,
  // draw those immediately instead of waiting for the next join.
  try {
    const guild = await client.guilds.fetch(guildId);
    await checkMilestones(client, guild);
  } catch (err) {
    console.error('Milestone check on startup failed:', err);
  }
  console.log(`Resumed ${pending.length} pending giveaway(s).`);
  // Timed raffles still open: re-schedule their draws (or draw immediately
  // if the bot was down past the end time).
  const pendingRaffles = db.listPendingRaffles().filter((r) => r.guild_id === guildId);
  for (const raffle of pendingRaffles) {
    if (raffle.ends_at) scheduleTimedRaffleDraw(client, raffle);
  }
  console.log(`Resumed ${pendingRaffles.length} pending raffle(s).`);
}

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}.`);
    try {
      await registerCommands();
    } catch (err) {
      console.error('Command registration failed:', err);
    }
    await resumePending(client);
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.guildId === guildId) {
        if (interaction.commandName === 'giveaway') {
          await handleGiveawayCommand(interaction, timers);
        } else if (interaction.commandName === 'raffle') {
          await handleRaffleCommand(interaction, raffleTimers);
        }
        return;
      }
      if (interaction.isChatInputCommand()) {
        await interaction.reply({ content: 'This bot only runs in its home server.', ephemeral: true });
      }
    } catch (err) {
      console.error('Interaction failed:', err);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong running that command.', ephemeral: true }).catch(() => null);
      }
    }
  });

  // Milestone trigger: a member joined. guild.memberCount is the number
  // Discord reports for the server — the same number Jake sees.
  client.on('guildMemberAdd', async (member) => {
    if (member.guild.id !== guildId) return;
    try {
      await checkMilestones(client, member.guild);
    } catch (err) {
      console.error('Milestone check on member join failed:', err);
    }
  });

  await client.login(token);
}

main().catch((err) => {
  console.error(`Bot failed to start: ${err.message}`);
  process.exit(1);
});
