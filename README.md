# discordBetBot

A Discord bot for betting on friends' League of Legends games using the Riot API. Built with Node.js 20, discord.js v14, and SQLite.

## Features

- `/collect` — Collect 10,000 coins daily (24h rolling cooldown)
- `/adduser <GameName#TagLine>` — Track a League player for betting
- `/bet <win|lose> <amount> [player]` — Bet on a tracked player's match (also available via buttons)
- `/baltop` — Leaderboard of top coin holders
- `/stats` — Your personal betting stats (W/L, wagered, won)
- `/rank` — Leaderboard of all tracked players' Solo/Duo ranks
- `/bethere` — Set the current channel for betting notifications
- **Auto-detect matches** — Polls Riot Spectator API and posts WIN/LOSE buttons when a tracked player enters a game
- **Average lobby rank** — Shows the average Solo/Duo rank of players in the detected match
- **3-minute betting window** — Bets close 3 minutes after match detection
- **Auto-settle bets** — When a match ends, payouts are calculated (1.5x for correct bets) and results are announced
- **Daily W/L tracking** — Match results show each player's win/loss record for the day
- **Auto-cleanup** — Match detected and betting closed messages are deleted when the match ends
- **Parley bets** — 10% of matches get an over/under stat bet (kills/deaths/KDA) with 2x payout
- **PUUID auto-refresh** — PUUIDs are re-fetched on startup when rotating Riot API keys

## Setup

### Prerequisites

- Node.js 20+
- A [Discord bot token](https://discord.com/developers/applications)
- A [Riot API key](https://developer.riotgames.com/)

### Install

```bash
git clone <repo-url>
cd discordBetBot
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` with your secrets:

```
DISCORD_TOKEN=your_discord_bot_token
RIOT_API_KEY=your_riot_api_key
RIOT_REGION=na1
LOG_LEVEL=info
```

### Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Under **OAuth2 URL Generator**, select scopes: `bot`, `applications.commands`
3. Under **Bot Permissions**, select: `Send Messages`, `Embed Links`, `Read Message History`, `Manage Messages`
4. Use the generated URL to invite the bot to your server

### Run

```bash
npm start
```

For development with auto-restart on file changes:

```bash
npm run start:watch
```

### Run Tests

```bash
npm test
```

## Raspberry Pi Deployment

### Quick Setup

```bash
git clone <repo-url>
cd discordBetBot
chmod +x setup-pi.sh
./setup-pi.sh
```

This single script installs Node.js 20, build tools, npm dependencies, creates `.env` from template, and sets up a systemd service with auto-restart on crash and reboot.

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

## Riot API Region Routing

The bot uses two types of Riot API endpoints:

| Endpoint Type | Example Host | Used For |
|---|---|---|
| Platform (region) | `na1.api.riotgames.com` | Spectator, League |
| Regional (continent) | `americas.api.riotgames.com` | Account, Match history |

Set `RIOT_REGION` in `.env` to your platform code (e.g. `na1`, `euw1`, `kr`). The bot automatically maps it to the correct regional endpoint.

## Configuration

Adjustable values in `config.js`:

| Setting | Default | Description |
|---|---|---|
| `collectAmount` | 10,000 | Coins per daily collect |
| `collectCooldownMs` | 24 hours | Time between collects |
| `pollIntervalMs` | 60,000ms | How often to check for active games |
| `bettingWindowMs` | 180,000ms | Time to place bets after match detection |
| `payoutMultiplier` | 1.5 | Payout multiplier for correct bets |
| `parleyChance` | 0.1 | Chance of parley bet per match (10%) |
| `parleyPayoutMultiplier` | 2 | Payout multiplier for correct parley bets |
| `commandCooldownMs` | 5,000ms | Per-user rate limit between commands |
