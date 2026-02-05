# discordBetBot

A Discord bot for betting on friends' League of Legends games using the Riot API. Built with Node.js 20, discord.js v14, and SQLite.

## Features

- `/collect` — Collect 10,000 coins (2h rolling cooldown)
- `/adduser <GameName#TagLine>` — Track a League player for betting
- `/removeuser <GameName#TagLine>` — Stop tracking a player (also removes their auto-bets)
- `/bet <win|lose> <amount> [player]` — Bet on a tracked player's match (also available via buttons)
- `/autobet [player] [prediction] [amount]` — Auto-bet on a player every game
- `/give <@user> <amount>` — Give coins to another user
- `/baltop` — Leaderboard of top coin holders
- `/stats` — Your personal betting stats (W/L, streak, net profit, per-player record, achievements)
- `/history` — Your last 10 bets with outcomes
- `/achievements` — Achievement progress with progress bars
- `/rank` — Leaderboard of all tracked players' Solo/Duo ranks
- `/peak` — All-time peak Solo/Duo rank for each tracked player
- `/emoji <on|off>` — Toggle rank emojis on/off (for servers without custom emoji)
- `/bethere` — Set the current channel for betting notifications
- `/help` — List all commands
- **Auto-detect matches** — Polls Riot Spectator API and posts WIN/LOSE buttons when a tracked player enters a game
- **Team compositions** — Match detection shows both teams' champions and which side (Blue/Red) the tracked player is on
- **Post-game stats** — Match results show the tracked player's KDA, CS, damage, and game duration
- **Average lobby rank** — Shows the average Solo/Duo rank of players in the detected match
- **Custom rank icons** — Configurable Discord emoji for each rank tier
- **5-minute betting window** — Bets close 5 minutes after match detection
- **Asymmetric payouts** — WIN bets pay 1.5x, LOSE bets pay 3x (higher risk, higher reward)
- **Auto-settle bets** — When a match ends, payouts are calculated and results are announced
- **Betting streaks** — Consecutive correct bets build a streak shown in results and `/stats`
- **Coin gifting** — Transfer coins to other users with `/give`
- **Auto-bet** — Users can set recurring bets that fire automatically on match detection
- **Daily win streak** — Match results show the player's daily W/L when they're winning (>50%)
- **Peak rank tracking** — Highest rank is recorded after each win
- **Auto-cleanup** — Match detected and betting closed messages are deleted when the match ends
- **Parley bets** — ~17.5% of matches get a prop bet (over/under or yes/no) with 2x payout. Stats: kills, deaths, KDA, CS, vision score, game length, first blood, triple kill
- **Achievements** — Milestone unlocks for bets placed (10/50/100/500/1k), bets won (10/50/100/1k), and win streaks (5/10/20/50/100), announced in match results and shown in `/stats`
- **Bet history** — `/history` shows your last 10 bets with outcomes and payouts
- **Net profit** — `/stats` shows total profit/loss (total won minus total wagered)
- **Per-player record** — `/stats` shows your W/L and amount wagered per tracked player
- **PUUID auto-refresh** — PUUIDs are re-fetched on startup when rotating Riot API keys

## Self-Hosting Guide

Anyone can run their own instance of this bot. You'll need your own Discord bot token and Riot API key (both are free).

### Step 1: Get a Discord Bot Token

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name, and create it
3. Go to the **Bot** tab and click **Reset Token** — copy and save this token
4. Under **Privileged Gateway Intents**, you don't need any special intents
5. Go to **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Read Message History`, `Manage Messages`
6. Copy the generated URL and open it in your browser to invite the bot to your server

### Step 2: Get a Riot API Key

1. Go to [developer.riotgames.com](https://developer.riotgames.com/) and sign in with your Riot account
2. Your **Development API Key** is shown on the dashboard — copy it

> **Note:** Development keys expire every 24 hours and need to be regenerated. For a permanent key, you can [register a production app](https://developer.riotgames.com/app-type), but the development key works fine for personal use.

### Step 3: Install and Run

```bash
git clone https://github.com/nivaiges/discordBetBot.git
cd discordBetBot
npm install
cp .env.example .env
```

Edit `.env` with your keys:

```
DISCORD_TOKEN=your_discord_bot_token
RIOT_API_KEY=your_riot_api_key
RIOT_REGION=na1
LOG_LEVEL=info
```

Set `RIOT_REGION` to your server's platform code:

| Region | Code |
|---|---|
| North America | `na1` |
| EU West | `euw1` |
| EU Nordic & East | `eun1` |
| Korea | `kr` |
| Japan | `jp1` |
| Brazil | `br1` |
| Oceania | `oc1` |
| Latin America North | `la1` |
| Latin America South | `la2` |
| Turkey | `tr1` |
| Russia | `ru` |

Then start the bot:

```bash
npm start
```

For development with auto-restart on file changes:

```bash
npm run start:watch
```

### Step 4: First-Time Setup in Discord

1. Use `/bethere` in the channel where you want betting notifications
2. Use `/adduser YourName#TAG` to start tracking a player
3. When the tracked player enters a ranked game, the bot will automatically post betting buttons

## Updating the Bot

If you downloaded the bot as a ZIP or copied the files manually (no `.git` folder), you'll need to set up git tracking first before you can pull updates.

### If you don't have a `.git` folder

```bash
cd discordBetBot
git init
git remote add origin https://github.com/nivaiges/discordBetBot.git
git fetch origin
git reset origin/main
git checkout -- .
npm install
```

This connects your local copy to the repo without overwriting your `.env` or `bot.db` — your config and database are preserved.

### If you already have `.git` set up

```bash
cd discordBetBot
git pull
npm install
```

Then restart the bot. New database columns are added automatically on startup — no data is lost.

### On Raspberry Pi (systemd)

```bash
cd discordBetBot
git pull
npm install
sudo systemctl restart discord-bet-bot
```

## Raspberry Pi Deployment

### Quick Setup

```bash
git clone https://github.com/nivaiges/discordBetBot.git
cd discordBetBot
chmod +x setup-pi.sh
./setup-pi.sh
```

This single script installs Node.js 20, build tools, npm dependencies, creates `.env` from template, and sets up a systemd service with auto-restart on crash and reboot.

After the script runs, edit your `.env` with your keys, then:

```bash
sudo systemctl restart discord-bet-bot
```

### Manual Setup

1. Clone to your Pi
2. Run `npm install` (requires `build-essential` for native SQLite compilation)
3. Copy and fill in `.env`
4. Install the systemd service:

```bash
sudo cp discord-bet-bot.service /etc/systemd/system/
sudo systemctl enable --now discord-bet-bot
```

### Useful Commands

```bash
sudo systemctl status discord-bet-bot     # Check status
sudo journalctl -u discord-bet-bot -f     # View logs
sudo systemctl restart discord-bet-bot    # Restart
sudo systemctl stop discord-bet-bot       # Stop
```

The bot will auto-restart on crash (10s delay) or reboot.

## Configuration

Adjustable values in `config.js`:

| Setting | Default | Description |
|---|---|---|
| `collectAmount` | 10,000 | Coins per collect |
| `collectCooldownMs` | 2 hours | Time between collects |
| `pollIntervalMs` | 60,000ms | How often to check for active games |
| `bettingWindowMs` | 300,000ms | Time to place bets after match detection |
| `payoutMultiplier` | 1.5 | Payout multiplier for correct WIN bets |
| `losePayoutMultiplier` | 3 | Payout multiplier for correct LOSE bets |
| `parleyChance` | 0.175 | Chance of parley bet per match (17.5%) |
| `parleyPayoutMultiplier` | 2 | Payout multiplier for correct parley bets |
| `commandCooldownMs` | 5,000ms | Per-user rate limit between commands |

### Custom Rank Emoji

To show rank icons in bot messages, upload rank images as custom emoji in your Discord server, then fill in the IDs in `config.js`:

```js
rankEmoji: {
  IRON: '<:Iron:123456789>',
  BRONZE: '<:Bronze:123456789>',
  // ...
},
```

To get an emoji ID: type `\:emojiname:` in Discord and send — it shows `<:name:ID>`.

## Riot API Notes

The bot uses two types of Riot API endpoints:

| Endpoint Type | Example Host | Used For |
|---|---|---|
| Platform (region) | `na1.api.riotgames.com` | Spectator, League |
| Regional (continent) | `americas.api.riotgames.com` | Account, Match history |

The bot automatically maps your `RIOT_REGION` to the correct regional endpoint. If you rotate your Riot API key, just update `.env` and restart — PUUIDs are refreshed automatically on startup.
