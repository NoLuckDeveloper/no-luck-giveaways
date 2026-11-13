// Mythic's Gathering giveaway bot. Also runs claim-your-number raffles
// (/raffle) — free entry, one number per person, draw picks a random
// claimed number. See README.md for both command sets.
//
// Multi-server: the bot works in every server it is added to. Commands are
// registered globally, and giveaways, raffles, and winners are kept separate
// per server (see db.js).
// Env vars (never put secrets in code):
//   DISCORD_TOKEN — bot token from discord.com/developers
//   CLIENT_ID     — application ID from discord.com/developers
//   GIVEAWAY_DB_PATH (optional) — JSON data file location, default ./data/giveaways.json
//
// There is no GUILD_ID: commands are registered globally, so the bot works
// in any server it is invited to.
//
// Intents: Guilds + GuildMembers. GuildMembers ("Server Members Intent" in the
// Developer Portal) is what lets the bot see member joins for milestone
// giveaways and read the member list for the draw. It is not a privileged
// approval-gated intent for a bot in under 100 servers — just flip the
// toggle on. No message-content intent is needed: the bot never reads messages.

const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const db = require('./db');
const { commandData, handleGiveawayCommand } = require('./commands');
const { raffleCommandData, handleRaffleCommand } = require('./raffle-commands');
const { drawGiveaway, checkMilestones } = require('./giveaway');

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
// GUILD_ID is intentionally not read: it is no longer needed. If it is set
// in the environment (e.g. left over from the single-server setup), it is
// ignored — except by the one-time data migration in db.js, which uses it
// only to attribute legacy rows that were saved without a guild_id.

// Active timed-giveaway timers, keyed by giveaway row id.
const timers = new Map();

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
  // Global commands: they appear in every server the bot is added to.
  // Discord can take up to about an hour to show them in a newly added
  // server, so don't re-register guild copies — that would duplicate them.
  await rest.put(Routes.applicationCommands(clientId), {
    body: [commandData.toJSON(), raffleCommandData.toJSON()],
  });
  console.log('Registered /giveaway and /raffle commands globally.');
}

async function resumePending(client) {
  // Timed giveaways still running in ANY server get their draw re-scheduled.
  // Rows without a guild_id (legacy, unmigrated) cannot be drawn — they were
  // logged by the migration in db.js and are skipped here.
  const pending = db.listPendingGiveaways();
  let resumed = 0;
  for (const giveaway of pending) {
    if (giveaway.kind === 'milestone') {
      // Milestones are checked on joins and on startup, below.
      continue;
    }
    if (!giveaway.guild_id) {
      console.warn(`Skipping pending giveaway ${giveaway.id} (${giveaway.prize}): no guild_id.`);
      continue;
    }
    scheduleTimedDraw(client, giveaway);
    resumed += 1;
  }
  // If any server already hit a milestone target while the bot was down,
  // draw those immediately instead of waiting for the next join.
  let guildCount = 0;
  let milestoneDraws = 0;
  try {
    const guilds = await client.guilds.fetch();
    guildCount = guilds.size;
    for (const [guildId] of guilds) {
      try {
        const guild = await client.guilds.fetch(guildId);
        const drawn = await checkMilestones(client, guild);
        milestoneDraws += drawn.length;
      } catch (err) {
        console.error(`Milestone check on startup failed for guild ${guildId}:`, err);
      }
    }
  } catch (err) {
    console.error('Could not list guilds for the startup milestone check:', err);
  }
  console.log(`Resumed ${resumed} pending timed giveaway(s) across ${guildCount} server(s); ${milestoneDraws} milestone(s) drawn on startup.`);
  // Raffles need no resume: they have no timers — an open raffle just stays
  // open until a mod draws or cancels it.
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
      if (interaction.isChatInputCommand() && (interaction.commandName === 'giveaway' || interaction.commandName === 'raffle')) {
        if (!interaction.guildId) {
          await interaction.reply({ content: 'Giveaways and raffles only work in a server, not in DMs.', ephemeral: true });
          return;
        }
        if (interaction.commandName === 'giveaway') {
          await handleGiveawayCommand(interaction, timers);
        } else {
          await handleRaffleCommand(interaction);
        }
      }
    } catch (err) {
      console.error('Interaction failed:', err);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong running that command.', ephemeral: true }).catch(() => null);
      }
    }
  });

  // Milestone trigger: a member joined, in any server the bot is in.
  // guild.memberCount is the number Discord reports for the server — the
  // same number Jake sees.
  client.on('guildMemberAdd', async (member) => {
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
