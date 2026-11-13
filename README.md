# Mythic's Gathering Giveaway Bot

A Discord bot that runs giveaways where **every server member is automatically
entered** — no buttons, no sign-ups, no DMs. When a giveaway ends, it draws
exactly 1 winner at random from all non-bot members and announces the winner
by tag in the channel.

It works in **every server it is added to** — same bot, same token, one invite
link per server. Giveaways, raffles, and winners are kept separate per server:
one server never sees or draws another server's giveaways or raffles.
**Numbers are per server too**: each server's giveaways and raffles number
from #1 in that server, and numbers are never reused — if giveaway #1 ends,
the next giveaway in that server is #2. A number only ever means something
inside its own server.

It also runs **claim-your-number raffles** (`/raffle`): a mod starts a raffle
for a prize with numbers 1 to N, members claim free numbers — as many as
they like — and the draw picks a random *claimed* number — so there is always
a winner when at least one number is claimed.

**Free entry only, everywhere.** Giveaways enter every member automatically,
raffle numbers are free, and there is no money, no paid entry, and no virtual
currency anywhere in this bot. Paid-entry raffles are not allowed — on
Discord or under Texas law — so this bot will never take payment for a number.

## How it works

### Giveaways

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
- **Giveaways are numbered per server** — the first giveaway in a server is
  #1, the next is #2, and numbers are never reused. The number is shown in
  the giveaway post and in `/giveaway list`. End or reroll one by its number
  (`/giveaway end id:2`) or by its message ID — either way it only ever
  refers to a giveaway in the server you ran the command in.
- **Survives restarts.** Giveaways live in a small JSON file, and when
  the bot starts up it re-schedules any timed giveaways still running and
  immediately draws any milestone targets already reached.

### Number raffles

- **Claim numbers** — `/raffle start` with a prize and a max number
  (e.g. 50 for numbers 1–50). Members claim free numbers with
  `/raffle claim` — as many as they like, first come, first served: a taken
  number is rejected. Claiming another number adds to your holdings; the
  numbers you already hold stay yours.
- **The board stays current** — the raffle post updates after every claim, and
  `/raffle board` shows who holds each claimed number and which numbers are
  still open.
- **The draw picks a random claimed number** — never an unclaimed one, so a
  raffle with at least one claim always has a winner. A mod draws with
  `/raffle draw` — raffles never draw on their own. A draw with zero claims
  is refused.
- **When the last number is claimed** the bot announces in the raffle
  channel that the list is full and a mod can draw the winner with
  `/raffle draw`. The announcement only — the draw stays manual and mod-only.
- **Raffles survive restarts** just like giveaways — they live in the same
  JSON file, and an open raffle just stays open until a mod draws it or
  cancels it.
- **Raffle numbers are per server** (#1, #2, …) shown in every raffle post
  and reply — the first raffle in a server is #1, and numbers are never
  reused. When only one raffle is open you can leave the number off a
  command; when several are open, the command asks you to say which one.
  A number only ever refers to a raffle in the server you ran the command
  in — open raffles in other servers never block a claim, board, or draw.

## Commands

### Giveaways

All commands are `/giveaway` subcommands. Starting, ending, and rerolling
require the **Manage Messages** permission (mods and admins). Listing is open
to every member.

| Command | What it does |
|---|---|
| `/giveaway start prize:<prize> duration:<1h, 24h, 7d…> [channel:<#channel>]` | Starts a timed giveaway. Duration is 10 seconds to 30 days. Defaults to the channel you ran it in. |
| `/giveaway milestone prize:<prize> target:<number> [channel:<#channel>]` | Starts a milestone giveaway that draws when the server hits `target` members. |
| `/giveaway list` | Lists active giveaways with their numbers, end times or milestone targets. |
| `/giveaway end [id:<giveaway #>] [message_id:<id>]` | Ends a giveaway early and draws the winner now. Give the number from the post (or the message ID from its footer). With neither, the bot lists this server's active giveaways so you can pick one. |
| `/giveaway reroll [id:<giveaway #>] [message_id:<id>]` | Draws a new winner for an ended giveaway. It prefers members who haven't already won that giveaway. With neither, the bot lists this server's ended giveaways so you can pick one. |

### Number raffles

All commands are `/raffle` subcommands. Starting, drawing, and cancelling
require the **Manage Messages** permission (mods and admins). Claiming and
the board are open to every member. Entry is always free.

| Command | What it does |
|---|---|
| `/raffle start prize:<prize> max-number:<N>` | Starts a number raffle, numbers 1 to N. No timer, no auto-draw — a mod draws it with `/raffle draw` when ready. |
| `/raffle claim number:<N> [id:<raffle #>]` | Claims a free number in the open raffle. Claim as many as you like — each new claim adds to your holdings. A taken number is rejected. |
| `/raffle board [id:<raffle #>]` | Shows who holds each claimed number and which numbers are still open. |
| `/raffle draw [id:<raffle #>]` | Draws the winning number from the claimed numbers and announces the winner. Refused when nobody has claimed a number. |
| `/raffle cancel [id:<raffle #>]` | Cancels an open raffle with no winner. |

The `id` is the raffle's number in that server (#1, #2, …), shown in every
raffle post and reply. Leave it off when only one raffle is open; the bot
asks for it when several are open. Numbers start at #1 in each server and
are never reused.

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
   member list (for the draw). For a bot in under 100 servers this is just a
   toggle — no approval needed. Leave "Message Content Intent" off; this bot
   never reads messages.
3. Click **Reset Token**, then **Copy**. That is your `DISCORD_TOKEN`. Treat
   it like a password — never post it in Discord or send it to anyone.

### 3. Invite the bot to a server

1. In the left menu, click **OAuth2**, then **URL Generator**.
2. Under **Scopes**, check **bot** and **applications.commands**.
3. Under **Bot Permissions**, check **Send Messages**, **Embed Links**, and
   **Read Message History**.
4. Copy the generated URL at the bottom, open it in your browser, pick a
   server you manage, and authorize. **Use the same link for every server** —
   the bot works in each one it is added to, with giveaways and raffles kept
   separate per server.
5. The `/giveaway` and `/raffle` commands are registered globally, so they
   appear in every server the bot is in. Discord can take up to about an
   hour to show them in a newly added server — if they don't show up right
   away, wait a bit before re-checking.

### 4. Deploy on Render

1. Put these files at the root of a GitHub repo.
2. In Render, go to **New → Blueprint** and pick that repo. The included
   `render.yaml` creates a background worker (it stays awake around the clock
   so draws are never missed) with a small persistent disk for the database.
   Workers are not on Render's free tier — the starter plan is the one in the
   file.
3. When Render asks for environment variables, fill in:
   - `DISCORD_TOKEN` — the bot token from step 2.
   - `CLIENT_ID` — the application ID from step 1.

   (`GIVEAWAY_DB_PATH` and `NODE_VERSION` are already set in `render.yaml`.)
   There is no `GUILD_ID` anymore — it is not needed. If it is still set in
   Render from the old single-server setup, it is ignored.
4. Deploy. In the logs you should see `Logged in as …` and
   `Registered /giveaway and /raffle commands globally.`. If a variable is missing, the
   bot stops with a plain message naming it instead of crashing.

### 5. Test it (takes about a minute)

1. In the server, run `/giveaway start prize:Test prize duration:1m`.
   (If the command doesn't show up yet, wait — global commands can take up
   to about an hour to appear in a newly added server.)
2. The giveaway post appears, saying every server member is entered.
3. After a minute, the post edits to show the winner and a message appears
   tagging them, naming the prize.
4. Try `/giveaway list`, then end one early with `/giveaway end id:1` and
   redraw with `/giveaway reroll id:1` (or use the message ID from the
   post's footer instead of the number).

### 6. Test a raffle

1. Run `/raffle start prize:Test raffle max-number:5`.
2. Claim a number with `/raffle claim number:3` — the raffle post's board
   updates to show your claim. Try claiming a second number to see both of
   your numbers on the board, and `/raffle board` to see the full board.
3. Claim numbers until the list fills — when the last number is claimed the
   bot announces in the channel that the list is full.
4. Draw the winner with `/raffle draw` — the bot announces the winner by tag.

## Running it yourself (optional)

Requires Node 20 or newer:

```sh
npm install
DISCORD_TOKEN=… CLIENT_ID=… node src/index.js
```

## Notes

- The bot works in every server it is added to. Giveaways, raffles, entries,
  and winners are kept separate per server — `/giveaway list` and
  `/raffle board` only ever show that server's own giveaways and raffles,
  and a draw only ever picks from that server's members or claimed numbers.
  Giveaway and raffle numbers are per server too: each server's sequence
  starts at #1 and numbers are never reused, so an old post or message
  always refers to the same giveaway or raffle.
- The "pool size" on a giveaway post is Discord's member count for the server,
  which includes bots — but bots are always filtered out of the actual draw.
- If a giveaway post gets deleted before its draw, the bot still posts the
  winner announcement in the channel.
- If the bot is offline when a timed giveaway ends, it draws immediately on
  its next startup rather than skipping it.
