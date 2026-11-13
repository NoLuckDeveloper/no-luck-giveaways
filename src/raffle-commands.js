// Slash command definitions and handlers for /raffle (claim-your-number).
// Subcommands: start, claim, board, draw, cancel.
// start / draw / cancel require Manage Messages (mods and admins).
// claim and board are open to every server member.
// Free entry only: no paid numbers, no money, no virtual currency.
// The draw picks a random CLAIMED number, so there is always a winner when
// at least one number is claimed. No DMs anywhere in this bot.

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const db = require('./db');
const { buildRaffleEmbed, drawRaffle, claimedNumbers } = require('./raffle');

const MAX_NUMBER_CAP = 1000;

const raffleCommandData = new SlashCommandBuilder()
  .setName('raffle')
  .setDescription('Claim-your-number raffles — free entry, one number per person')
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Start a number raffle (free entry — no paid numbers)')
      .addStringOption((opt) => opt.setName('prize').setDescription('What the winner gets').setRequired(true))
      .addIntegerOption((opt) =>
        opt
          .setName('max-number')
          .setDescription('Highest number — members claim from 1 to this number')
          .setRequired(true)
          .setMinValue(2)
          .setMaxValue(MAX_NUMBER_CAP),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('claim')
      .setDescription('Claim a free number in the open raffle')
      .addIntegerOption((opt) =>
        opt.setName('number').setDescription('The number you want to claim').setRequired(true).setMinValue(1),
      )
      .addIntegerOption((opt) =>
        opt.setName('id').setDescription('Raffle number (only needed if more than one raffle is open)').setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('board')
      .setDescription('Show who holds each claimed number and which numbers are still open')
      .addIntegerOption((opt) =>
        opt.setName('id').setDescription('Raffle number (only needed if more than one raffle is open)').setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('draw')
      .setDescription('Draw the winning number from the claimed numbers')
      .addIntegerOption((opt) =>
        opt.setName('id').setDescription('Raffle number (only needed if more than one raffle is open)').setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel an open raffle with no winner')
      .addIntegerOption((opt) =>
        opt.setName('id').setDescription('Raffle number (only needed if more than one raffle is open)').setMinValue(1),
      ),
  );

function needsManageMessages(interaction) {
  const perms = interaction.memberPermissions;
  return perms && perms.has(PermissionFlagsBits.ManageMessages);
}

// Picks the raffle an id-less command refers to: the given id, or the only
// open raffle when exactly one exists. Returns { raffle } or { error }.
function resolveRaffle(interaction) {
  const id = interaction.options.getInteger('id');
  const active = db.listActiveRaffles(interaction.guild.id);
  if (id !== null && id !== undefined) {
    const raffle = active.find((r) => r.id === id);
    if (!raffle) return { error: `No open raffle #${id} in this server.` };
    return { raffle };
  }
  if (active.length === 0) return { error: 'No open raffle in this server right now.' };
  if (active.length > 1) {
    const ids = active.map((r) => `#${r.id} (${r.prize})`).join(', ');
    return { error: `More than one raffle is open — say which one: ${ids}. Add the id to the command.` };
  }
  return { raffle: active[0] };
}

async function refreshRafflePost(client, raffle) {
  try {
    const channel = await client.channels.fetch(raffle.channel_id);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(raffle.message_id).catch(() => null);
    if (!message) return;
    await message.edit({ embeds: [buildRaffleEmbed(raffle, false)] }).catch(() => null);
  } catch {
    // The post may have been deleted — claims still stand in the store.
  }
}

async function handleStart(interaction) {
  if (!needsManageMessages(interaction)) {
    return interaction.reply({ content: 'You need the Manage Messages permission to start a raffle.', ephemeral: true });
  }
  const prize = interaction.options.getString('prize');
  const maxNumber = interaction.options.getInteger('max-number');
  const channel = interaction.channel;
  const guild = interaction.guild;

  const raffle = db.createRaffle({
    guildId: guild.id,
    channelId: channel.id,
    prize,
    maxNumber,
    createdBy: interaction.user.id,
  });

  let message;
  try {
    message = await channel.send({ embeds: [buildRaffleEmbed(raffle, false)] });
  } catch (err) {
    return interaction.reply({
      content: `I couldn't post in <#${channel.id}>. Check I have Send Messages and Embed Links there. (${err.message})`,
      ephemeral: true,
    });
  }

  db.setRaffleMessageId(raffle.id, message.id);
  raffle.message_id = message.id;
  await message.edit({ embeds: [buildRaffleEmbed(raffle, false)] }).catch(() => null);

  return interaction.reply({
    content: `Raffle #${raffle.id} started in <#${channel.id}> for **${prize}** — numbers 1 to ${maxNumber}, free entry, one number per person — a mod draws it with /raffle draw when ready. Members claim with /raffle claim.`,
    ephemeral: true,
  });
}

async function handleClaim(interaction) {
  const { raffle, error } = resolveRaffle(interaction);
  if (error) return interaction.reply({ content: error, ephemeral: true });
  const number = interaction.options.getInteger('number');
  const result = db.claimRaffleNumber(raffle.id, interaction.user.id, number);
  if (!result.ok) {
    return interaction.reply({ content: `Couldn't claim that: ${result.error}.`, ephemeral: true });
  }
  // Keep the raffle post's board current.
  const fresh = db.getRaffleById(raffle.id, interaction.guild.id);
  if (fresh) await refreshRafflePost(interaction.client, fresh);

  // The list just filled up: announce in the channel that a mod can draw.
  // Announcement only — the draw stays manual and mod-only. Only a claim
  // that adds a new number can fill the list; a re-claim of the same number
  // or a move leaves the count unchanged, so it never re-announces.
  if (
    fresh &&
    !result.alreadyHad &&
    (result.movedFrom === null || result.movedFrom === undefined) &&
    claimedNumbers(fresh).length >= fresh.max_number
  ) {
    try {
      const channel = await interaction.client.channels.fetch(fresh.channel_id);
      if (channel && channel.isTextBased()) {
        await channel
          .send(
            `🎟️ Raffle #${fresh.id} is full — all ${fresh.max_number} numbers are claimed! A mod can draw the winner with \`/raffle draw\`.`,
          )
          .catch(() => null);
      }
    } catch {
      // The claim stands even if the announcement can't be posted.
    }
  }

  if (result.alreadyHad) {
    return interaction.reply({ content: `You already hold number **${number}** in raffle #${raffle.id}.`, ephemeral: true });
  }
  if (result.movedFrom !== null && result.movedFrom !== undefined) {
    return interaction.reply({
      content: `Moved your claim in raffle #${raffle.id}: number **${result.movedFrom}** is free again, and **${number}** is now yours.`,
      ephemeral: true,
    });
  }
  return interaction.reply({ content: `You're in raffle #${raffle.id} — number **${number}** is yours. Good luck!`, ephemeral: true });
}

async function handleBoard(interaction) {
  const { raffle, error } = resolveRaffle(interaction);
  if (error) return interaction.reply({ content: error, ephemeral: true });
  const claimed = claimedNumbers(raffle);
  const openCount = raffle.max_number - claimed.length;
  const lines = [`**Raffle #${raffle.id} — ${raffle.prize}** (numbers 1–${raffle.max_number}, ${claimed.length} taken, ${openCount} open)`];
  if (claimed.length > 0) {
    lines.push('', ...claimed.map((n) => `• ${n} — <@${raffle.claims[String(n)]}>`));
  } else {
    lines.push('', 'No numbers claimed yet.');
  }
  if (raffle.max_number <= 100 && openCount > 0) {
    const open = [];
    for (let n = 1; n <= raffle.max_number; n += 1) {
      if (!raffle.claims[String(n)]) open.push(n);
    }
    lines.push('', `Still open: ${open.join(', ')}`);
  }
  // Discord caps a message at 2000 characters — trim a long board.
  let text = lines.join('\n');
  if (text.length > 1900) text = `${text.slice(0, 1900)}…`;
  return interaction.reply({ content: text, ephemeral: true });
}

async function handleDraw(interaction) {
  if (!needsManageMessages(interaction)) {
    return interaction.reply({ content: 'You need the Manage Messages permission to draw a raffle.', ephemeral: true });
  }
  const { raffle, error } = resolveRaffle(interaction);
  if (error) return interaction.reply({ content: error, ephemeral: true });
  const claimed = claimedNumbers(raffle);
  if (claimed.length === 0) {
    return interaction.reply({
      content: `Raffle #${raffle.id} has no claimed numbers, so there is nothing to draw. Wait for claims, or cancel it with /raffle cancel.`,
      ephemeral: true,
    });
  }
  const result = await drawRaffle(interaction.client, raffle);
  return interaction.reply({
    content: result
      ? `Raffle #${raffle.id} drawn — number **${result.winnerNumber}** won, that's <@${result.winnerId}>.`
      : 'The draw found no claimed numbers.',
    ephemeral: true,
  });
}

async function handleCancel(interaction) {
  if (!needsManageMessages(interaction)) {
    return interaction.reply({ content: 'You need the Manage Messages permission to cancel a raffle.', ephemeral: true });
  }
  const { raffle, error } = resolveRaffle(interaction);
  if (error) return interaction.reply({ content: error, ephemeral: true });
  db.cancelRaffle(raffle.id);
  try {
    const channel = await interaction.client.channels.fetch(raffle.channel_id);
    if (channel && channel.isTextBased()) {
      const message = await channel.messages.fetch(raffle.message_id).catch(() => null);
      if (message) {
        await message.edit({ embeds: [buildRaffleEmbed({ ...raffle, status: 'cancelled' }, true)] }).catch(() => null);
      }
    }
  } catch {
    // Post may be gone — the raffle is cancelled in the store either way.
  }
  return interaction.reply({ content: `Raffle #${raffle.id} for **${raffle.prize}** was cancelled — no winner.`, ephemeral: true });
}

async function handleRaffleCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'start') return handleStart(interaction);
  if (sub === 'claim') return handleClaim(interaction);
  if (sub === 'board') return handleBoard(interaction);
  if (sub === 'draw') return handleDraw(interaction);
  if (sub === 'cancel') return handleCancel(interaction);
  return interaction.reply({ content: 'Unknown raffle command.', ephemeral: true });
}

module.exports = { raffleCommandData, handleRaffleCommand };
