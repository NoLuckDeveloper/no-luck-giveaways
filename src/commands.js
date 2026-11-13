// Slash command definitions and handlers for /giveaway.
// Subcommands: start, milestone, list, end, reroll.
// start / milestone / end / reroll require Manage Messages (mods and admins).
// list is open to every server member. No DMs anywhere in this bot.

const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const db = require('./db');
const { parseDuration } = require('./duration');
const { buildEmbed, drawGiveaway } = require('./giveaway');

const commandData = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Run server giveaways — every member is entered automatically')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Start a timed giveaway (1 winner, every member entered)')
      .addStringOption((opt) => opt.setName('prize').setDescription('What the winner gets').setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName('duration')
          .setDescription('How long it runs, e.g. 1h, 24h, 7d (10 seconds to 30 days)')
          .setRequired(true),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to post in (defaults to this channel)')
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('milestone')
      .setDescription('Start a giveaway that draws when the server hits a member count')
      .addStringOption((opt) => opt.setName('prize').setDescription('What the winner gets').setRequired(true))
      .addIntegerOption((opt) =>
        opt.setName('target').setDescription('Member count that triggers the draw, e.g. 100').setRequired(true).setMinValue(1),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to post in (defaults to this channel)')
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List active giveaways in this server'))
  .addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('End a giveaway early and draw the winner now')
      .addIntegerOption((opt) =>
        opt.setName('id').setDescription('Giveaway number in this server (shown in the post)').setMinValue(1),
      )
      .addStringOption((opt) =>
        opt.setName('message_id').setDescription('Message ID of the giveaway (shown in its footer)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reroll')
      .setDescription('Draw a new winner for an ended giveaway')
      .addIntegerOption((opt) =>
        opt.setName('id').setDescription('Giveaway number in this server (shown in the post)').setMinValue(1),
      )
      .addStringOption((opt) =>
        opt.setName('message_id').setDescription('Message ID of the giveaway (shown in its footer)'),
      ),
  );

function needsManageMessages(interaction) {
  const perms = interaction.memberPermissions;
  return perms && perms.has(PermissionFlagsBits.ManageMessages);
}

// The number users see and pass to commands: the per-server giveaway
// number. Falls back to the internal id for any row that somehow lacks one.
function giveawayNo(giveaway) {
  return giveaway.number ?? giveaway.id;
}

// Picks the giveaway an end/reroll refers to: the given per-server number,
// or the message ID — either way it only ever resolves inside the current
// server. With neither given, the reply lists this server's candidates
// (active ones for end, ended ones for reroll) so the user can pick.
// Open giveaways in other servers never appear or block anything here.
// Returns { giveaway } or { error }.
function resolveGiveaway(interaction, wantStatus) {
  const id = interaction.options.getInteger('id');
  const messageId = interaction.options.getString('message_id');
  if (id !== null && id !== undefined) {
    const giveaway = db.getGiveawayByNumber(id, interaction.guild.id);
    if (!giveaway) return { error: `No giveaway #${id} in this server.` };
    return { giveaway };
  }
  if (messageId) {
    const giveaway = db.getGiveawayByMessage(messageId, interaction.guild.id);
    if (!giveaway) return { error: `No giveaway found with message ID \`${messageId}\` in this server.` };
    return { giveaway };
  }
  const list =
    wantStatus === 'ended'
      ? db.listEndedGiveaways(interaction.guild.id)
      : db.listActiveGiveaways(interaction.guild.id);
  if (list.length === 0) {
    return {
      error:
        wantStatus === 'ended'
          ? 'No ended giveaways in this server to reroll.'
          : 'No active giveaways in this server right now.',
    };
  }
  const lines = list.map((g) => `#${giveawayNo(g)} (${g.prize})`).join(', ');
  return { error: `Say which giveaway: ${lines}. Add the id to the command.` };
}

async function handleStart(interaction, timers) {
  if (!needsManageMessages(interaction)) {
    return interaction.reply({ content: 'You need the Manage Messages permission to start a giveaway.', ephemeral: true });
  }
  const prize = interaction.options.getString('prize');
  const durationText = interaction.options.getString('duration');
  const durationMs = parseDuration(durationText);
  if (durationMs === null) {
    return interaction.reply({
      content: 'That duration doesn\'t work. Use something like 1h, 24h, or 7d (between 10 seconds and 30 days).',
      ephemeral: true,
    });
  }
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const guild = interaction.guild;
  const endsAt = Date.now() + durationMs;

  const giveaway = db.createGiveaway({
    guildId: guild.id,
    channelId: channel.id,
    kind: 'timed',
    prize,
    endsAt,
    createdBy: interaction.user.id,
  });

  let message;
  try {
    message = await channel.send({ embeds: [buildEmbed(giveaway, guild.memberCount, false, null)] });
  } catch (err) {
    return interaction.reply({
      content: `I couldn't post in <#${channel.id}>. Check I have Send Messages and Embed Links there. (${err.message})`,
      ephemeral: true,
    });
  }

  db.setMessageId(giveaway.id, message.id);
  giveaway.message_id = message.id;
  await message.edit({ embeds: [buildEmbed(giveaway, guild.memberCount, false, null)] }).catch(() => null);

  timers.set(giveaway.id, setTimeout(() => {
    timers.delete(giveaway.id);
    drawGiveaway(interaction.client, { ...giveaway, message_id: message.id }).catch((err) =>
      console.error(`Draw failed for giveaway ${giveaway.id}:`, err),
    );
  }, durationMs));

  return interaction.reply({
    content: `Giveaway #${giveawayNo(giveaway)} started in <#${channel.id}> for **${prize}** — draws in ${durationText}. Every server member is entered.`,
    ephemeral: true,
  });
}

async function handleMilestone(interaction) {
  if (!needsManageMessages(interaction)) {
    return interaction.reply({ content: 'You need the Manage Messages permission to start a giveaway.', ephemeral: true });
  }
  const prize = interaction.options.getString('prize');
  const target = interaction.options.getInteger('target');
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const guild = interaction.guild;

  const giveaway = db.createGiveaway({
    guildId: guild.id,
    channelId: channel.id,
    kind: 'milestone',
    prize,
    target,
    createdBy: interaction.user.id,
  });

  let message;
  try {
    message = await channel.send({ embeds: [buildEmbed(giveaway, guild.memberCount, false, null)] });
  } catch (err) {
    return interaction.reply({
      content: `I couldn't post in <#${channel.id}>. Check I have Send Messages and Embed Links there. (${err.message})`,
      ephemeral: true,
    });
  }

  db.setMessageId(giveaway.id, message.id);
  giveaway.message_id = message.id;
  await message.edit({ embeds: [buildEmbed(giveaway, guild.memberCount, false, null)] }).catch(() => null);

  // Already at or past the target? Draw immediately instead of waiting.
  if (guild.memberCount >= target) {
    await drawGiveaway(interaction.client, giveaway);
    return interaction.reply({
      content: `The server is already at ${guild.memberCount} members, so milestone giveaway #${giveawayNo(giveaway)} for **${prize}** drew right away.`,
      ephemeral: true,
    });
  }

  return interaction.reply({
    content: `Milestone giveaway #${giveawayNo(giveaway)} started in <#${channel.id}> for **${prize}** — it draws the moment the server reaches ${target} members.`,
    ephemeral: true,
  });
}

async function handleList(interaction) {
  const active = db.listActiveGiveaways(interaction.guild.id);
  if (active.length === 0) {
    return interaction.reply({ content: 'No active giveaways right now.', ephemeral: true });
  }
  const guild = interaction.guild;
  const lines = active.map((g) => {
    if (g.kind === 'milestone') {
      return `• **#${giveawayNo(g)} ${g.prize}** — milestone: draws at ${g.target} members (now ${guild.memberCount}) — <#${g.channel_id}> — ID \`${g.message_id || '?'}\``;
    }
    const ends = `<t:${Math.floor(g.ends_at / 1000)}:R>`;
    return `• **#${giveawayNo(g)} ${g.prize}** — ends ${ends} — <#${g.channel_id}> — ID \`${g.message_id || '?'}\``;
  });
  return interaction.reply({ content: `Active giveaways:\n${lines.join('\n')}`, ephemeral: true });
}

async function handleEnd(interaction, timers) {
  if (!needsManageMessages(interaction)) {
    return interaction.reply({ content: 'You need the Manage Messages permission to end a giveaway.', ephemeral: true });
  }
  const { giveaway, error } = resolveGiveaway(interaction, 'active');
  if (error) return interaction.reply({ content: error, ephemeral: true });
  if (giveaway.status !== 'active') {
    return interaction.reply({ content: `Giveaway #${giveawayNo(giveaway)} already ended. Use /giveaway reroll to draw a new winner.`, ephemeral: true });
  }
  if (timers.has(giveaway.id)) {
    clearTimeout(timers.get(giveaway.id));
    timers.delete(giveaway.id);
  }
  const winnerId = await drawGiveaway(interaction.client, giveaway);
  return interaction.reply({
    content: winnerId
      ? `Giveaway #${giveawayNo(giveaway)} ended early — winner: <@${winnerId}>.`
      : `Giveaway #${giveawayNo(giveaway)} ended early, but there were no eligible members.`,
    ephemeral: true,
  });
}

async function handleReroll(interaction) {
  if (!needsManageMessages(interaction)) {
    return interaction.reply({ content: 'You need the Manage Messages permission to reroll a giveaway.', ephemeral: true });
  }
  const { giveaway, error } = resolveGiveaway(interaction, 'ended');
  if (error) return interaction.reply({ content: error, ephemeral: true });
  if (giveaway.status !== 'ended') {
    return interaction.reply({ content: `Giveaway #${giveawayNo(giveaway)} is still running. Use /giveaway end to draw it first.`, ephemeral: true });
  }
  const winnerId = await drawGiveaway(interaction.client, giveaway, { reroll: true });
  return interaction.reply({
    content: winnerId
      ? `Giveaway #${giveawayNo(giveaway)} rerolled — new winner: <@${winnerId}>.`
      : `Giveaway #${giveawayNo(giveaway)} rerolled, but there were no eligible members.`,
    ephemeral: true,
  });
}

async function handleGiveawayCommand(interaction, timers) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'start') return handleStart(interaction, timers);
  if (sub === 'milestone') return handleMilestone(interaction);
  if (sub === 'list') return handleList(interaction);
  if (sub === 'end') return handleEnd(interaction, timers);
  if (sub === 'reroll') return handleReroll(interaction);
  return interaction.reply({ content: 'Unknown giveaway command.', ephemeral: true });
}

module.exports = { commandData, handleGiveawayCommand };
