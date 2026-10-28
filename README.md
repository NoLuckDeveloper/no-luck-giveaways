# Mythic's Gathering Giveaway Bot

A Discord bot for the Mythic's Gathering server. It runs giveaways where **every
server member is automatically entered** — no buttons, no sign-ups, no DMs.
When a giveaway ends, it draws exactly 1 winner at random from all non-bot
members and announces the winner by tag in the channel.

## How it works

- **Timed giveaways** — `/giveaway start` with a prize and a duration. When the
  time runs out, the bot edits the giveaway post to show the winner and posts
  a public announcement tagging them.
- **Milestone giveaways** — `/giveaway milestone` with a prize and a member
  count target. The bot watches members join, and the moment the server's
  member count reaches or passes the target, it draws and announces. If the
  server is already at or past the target when you set it, it draws right away.
- **Every member is in the pool.** The draw reads the live member list, so
  people who joined after the giveaway started are still included. Bots can
  never win.
- **Winner announcements always name the prize**, exactly as you typed it in
  the command — for example: "Congratulations @winner, you won [prize]!"
- **No DMs, ever.** Winners are announced in the channel only.
- **Survives restarts.** Giveaways live in a small JSON file, and when
  the bot starts up it re-schedules any timed giveaways still running and
  immediately draws any milestone targets already reached.

## Commands

All commands are `/giveaway` subcommands. Starting, ending, and rerolling
require the **Manage Messages** permission (mods and admins). Listing is open
to every member.

| Command | What it does |
|---|---|
| `/giveaway start prize:<prize> duration:<1h, 24h, 7d…> [channel:<#channel>]` | Starts a timed giveaway. Duration is 10 seconds to 30 days. Defaults to the channel you ran it in. |
| `/giveaway milestone prize:<prize> target:<number> [channel:<#channel>]` | Starts a milestone giveaway that draws when the server hits `target` members. |
| `/giveaway list` | Lists active giveaways with their end times or milestone targets. |
| `/giveaway end message_id:<id>` | Ends a giveaway early and draws the winner now. The message ID is in the giveaway post's footer. |
| `/giveaway reroll message_id:<id>` | Draws a new winner for an ended giveaway. It prefers members who haven't already won that giveaway. |

## Setup — step by step

You only do this once. Nothing here goes through chat — tokens and IDs go
straight from Discord into Render.

### 1. Create the application

1. Go to **https://discord.com/developers** and sign in.
2. Click **New Application**, name it something like `Mythic's Gathering Giveaway`, and create it.
3. On the **General Information** page, copy the **Application ID** — that is
   your `CLIENT_ID`. Keep this tab open.

### 2. Get the bot token

1. In the left menu, click **Bot**.
2. Under **Privileged Gateway Intents**, turn **ON** "Server Members Intent".
   This is what lets the bot see members joining (for milestones) and read the
   member list (for the draw). For a bot in one small server this is just a
   toggle — no approval needed. Leave "Message Content Intent" off; this bot
   never reads messages.
3. Click **Reset Token**, then **Copy**. That is your `DISCORD_TOKEN`. Treat
   it like a password — never post it in Discord or send it to anyone.

### 3. Invite the bot to the server

1. In the left menu, click **OAuth2**, then **URL Generator**.
2. Under **Scopes**, check **bot** and **applications.commands**.
3. Under **Bot Permissions**, check **Send Messages**, **Embed Links**, and
   **Read Message History**.
4. Copy the generated URL at the bottom, open it in your browser, pick the
   **Mythic's Gathering** server, and authorize.

### 4. Get the server ID

1. In Discord, go to **User Settings → Advanced** and turn on **Developer Mode**.
2. Right-click the **Mythic's Gathering** server icon and choose **Copy Server ID**.
   That is your `GUILD_ID`.

### 5. Deploy on Render

1. Put these files at the root of a GitHub repo.
2. In Render, go to **New → Blueprint** and pick that repo. The included
   `render.yaml` creates a background worker (it stays awake around the clock
   so draws are never missed) with a small persistent disk for the database.
   Workers are not on Render's free tier — the starter plan is the one in the
   file.
3. When Render asks for environment variables, fill in:
   - `DISCORD_TOKEN` — the bot token from step 2.
   - `CLIENT_ID` — the application ID from step 1.
   - `GUILD_ID` — the server ID from step 4.
   
   (`GIVEAWAY_DB_PATH` and `NODE_VERSION` are already set in `render.yaml`.)
4. Deploy. In the logs you should see `Logged in as …` and
   `Registered /giveaway commands for guild …`. If a variable is missing, the
   bot stops with a plain message naming it instead of crashing.

### 6. Test it (takes about a minute)

1. In the server, run `/giveaway start prize:Test prize duration:1m`.
   (If the command doesn't show up yet, wait a minute — guild commands
   usually appear fast, but Discord can take a moment.)
2. The giveaway post appears, saying every server member is entered.
3. After a minute, the post edits to show the winner and a message appears
   tagging them, naming the prize.
4. Try `/giveaway list`, then end one early with `/giveaway end` and redraw
   with `/giveaway reroll`, using the message ID from the post's footer.

## Running it yourself (optional)

Requires Node 20 or newer:

```sh
npm install
DISCORD_TOKEN=… CLIENT_ID=… GUILD_ID=… node src/index.js
```

## Notes

- The bot only answers in the server named by `GUILD_ID`.
- The "pool size" on a giveaway post is Discord's member count for the server,
  which includes bots — but bots are always filtered out of the actual draw.
- If a giveaway post gets deleted before its draw, the bot still posts the
  winner announcement in the channel.
- If the bot is offline when a timed giveaway ends, it draws immediately on
  its next startup rather than skipping it.
