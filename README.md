# LoLBetBot

A Discord bot for betting on friends' League of Legends games using the Riot API. Built with Node.js 20, discord.js v14, SQLite, and `@napi-rs/canvas` for local chart rendering.

## Slash Commands

### Currency & Stats
- `/collect` — Collect 10,000 coins (2 h rolling cooldown)
- `/give <@user> <amount>` — Transfer coins to another user
- `/baltop` — Coin-balance leaderboard
- `/stats` — Personal betting stats (W/L, streak, net profit, per-player record, achievements) plus a **cumulative profit chart** from your full bet history
- `/history` — Last 10 bets with outcomes and payouts
- `/achievements` — Achievement progress bars

### Tracked Players
- `/adduser <GameName#TagLine>` — Add a tracked player
- `/removeuser <GameName#TagLine>` — Stop tracking
- `/rank` — Current Solo/Duo ranks of all tracked players + record + peak-recovery distance
- `/peak` — All-time peak Solo/Duo rank per tracked player
- `/records [season]` — Historical peak ranks from past seasons (populated by `season-reset.js`)
- `/lp [player]` — **LP history graph** with tier bands, division markers, and win/loss point colors
- `/duo` — Duo W/L records (auto-tracked when two tracked players are on the same team)

### Betting
- `/bet <win|lose> <amount> [player]` — Bet on a tracked player's match (also available via buttons on match-detected embeds)
- `/autobet [player] [prediction] [amount]` — Auto-bet on a player every game; persistent until cleared

### Admin / Settings
- `/bethere` — Set the current channel for betting notifications
- `/emoji <on|off>` — Toggle rank emoji display
- `/help` — List all commands

## What the Bot Does Automatically

- **Match detection** — Polls Riot Spectator-V5 every 60 s for tracked players. When one enters a ranked game it posts a Match Detected embed with both team comps, the average lobby rank, and three buttons: 🟢 WIN, 🔴 LOSE, and 🟡 **Auto-bet** (sets up a recurring bet on this player via a modal)
- **Parlay generation** — ~17.5 % of matches roll a 2- to 4-leg prop bet (over/under or yes/no). Stats: kills, deaths, KDA, CS, vision score, game length, first blood, triple kill, **won lane**. Payout = 2ⁿ for an n-leg parlay
- **Auto-bets fire on next match** — Persistent across games until explicitly cleared with `/autobet … clear:True`
- **5-minute betting window** — Bets close 5 min after match detection; the embed gets edited to "BETTING CLOSED"
- **Remake handling** — Riot's `gameEndedInEarlySurrender` flag triggers a full bet refund with no W/L recorded
- **Auto-settle bets** — On match end the bot calls Match-V5, calculates payouts (WIN pays 1.5×, LOSE pays 3×, parlay pays 2ⁿ), updates user stats and achievements
- **Daily W/L** — Match results show the player's today's record, with 🔥 when above 50 %. Resets at local midnight (not UTC)
- **Won lane** — At match end, the bot compares gold@14 vs the role opponent and increments `lane_wins` / `lane_losses` per tracked player. Shown in Match Over as 🛣️ Won Lane / Lost Lane
- **Peak rank tracking** — Updates after every match; `/rank` shows distance from peak

### Match Over Gold Chart

Every Match Over message comes with a 520×200 PNG chart of the **team gold lead** over time:

- **Single line** with blue area-fill where the team was ahead, red where they were behind, switching at the y = 0 crossing
- **Peak callouts** — pill labels for max lead and max deficit (`+5.4k @ 22m` / `-2.8k @ 8m`)
- **Objective pins** — real Riot minimap icons (loaded from `assets/objectives/`) for **Baron**, **Rift Herald**, **Void Grubs**, **all six elemental dragons** (Ocean / Mountain / Cloud / Infernal / Hextech / Chemtech), and **Dragon Soul** (the 4th elemental of a team). Pin color = blue if the tracked team got it, red if the enemy. Pin position flips to the bottom of the plot when the line is below zero at that minute, with a dashed guide line spanning the chart
- **Kill X-stacks** — for every kill the tracked player gets, an X anchored at the y = 0 baseline. Multikills within 10 s collapse into one column that stacks `XX` / `XXX` / `XXXX` / `XXXXX` vertically, with colors escalating yellow → orange → red → purple → hot pink for single → penta. The stack direction flips down when the player is behind at that moment
- **💾 Save** and **📌 Keep in Chat** buttons — see *Save / Keep* below

### LP Graph (`/lp`)

Per-player LP history rendered locally. Captures a snapshot on every match-end peak check and on every `/rank` call (skips duplicates when LP/tier hasn't changed). Renders:

- Single line plotting **absolute LP** so promotions across divisions read as a continuous climb
- **Tier bands** drawn as faint colored zones with labels (Iron through Master+); always extends the visible range to include at least half of the tier band below the player, so a Master player can see how far above Diamond they are
- **Tier boundary lines** — dashed horizontal markers at each promotion threshold
- **Per-point W/L colors** — green when LP rose from the previous entry, red when it fell, blue for the first point
- Peak callout with the tier+rank+LP at the high point, "now: …" callout at the current point

### Profit Chart (`/stats`)

Cumulative net profit over your full bet history, signed-line chart with the same blue/red fill split at zero. Pulls from `bets` and `parley_bets` (cancelled bets ignored).

## Save / Keep (allowlisted)

Two buttons appear under every Match Over chart:

- **💾 Save** — writes the PNG to `saved-graphs/<user-id>/<match-id>.png` on the bot host
- **📌 Keep in Chat** — re-posts the chart as a standalone chat message captioned `📌 Kept by <user>`. The re-posted message isn't tracked, so it survives the auto-clear when the next match starts. Gets removed at the next nightly cleanup

Both buttons are gated by `config.saveGraphAllowedUserIds` — only the listed Discord user IDs can click them; everyone else gets an ephemeral "not allowed" reply.

## Message Lifecycle & Cleanup

- The bot edits the Match Detected embed to "BETTING CLOSED" when the window expires
- It deletes the match-detected, betting-closed, and any auto-bet notification messages when the match ends
- It deletes the previous Match Over embed when the same player enters their next game
- **Nightly cleanup** — at 12:01 AM local time the bot deletes its own messages from the past 3 days in the configured channel, skipping anything tied to an in-progress match
- **Manual cleanup** — `node cleanup-recent.js [--dry-run] [days=3]` runs the same logic on demand

## Season Reset

When a new ranked season starts:

```bash
node season-reset.js "2026 Season 1"
```

Snapshots every tracked player's current `peak_tier / peak_rank / peak_lp` into `peak_records` tagged with that season label, then clears tracked-player peaks, daily W/L, user betting stats, duo pair W/L, and lane W/L. Coin balances and bet history are preserved. `/records season:2026 Season 1` then displays the frozen snapshot.

## Self-Hosting

You need your own Discord bot token and Riot API key (both free).

### Discord Bot Token

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** tab → **Reset Token** → copy
2. OAuth2 → URL Generator → scopes `bot` + `applications.commands`, permissions `Send Messages`, `Embed Links`, `Read Message History`, `Manage Messages` (Manage Messages is required for the nightly bulk cleanup)
3. Open the generated URL to invite the bot

### Riot API Key

[developer.riotgames.com](https://developer.riotgames.com/) → sign in → copy the **Development API Key** shown on the dashboard.

> Development keys expire every 24 h and need regenerating. For longer-lived keys, register a production app.

### Install and Run

```bash
git clone https://github.com/nivaiges/LoLBetBot.git
cd LoLBetBot
npm install
cp .env.example .env
```

Edit `.env`:

```
DISCORD_TOKEN=your_discord_bot_token
RIOT_API_KEY=your_riot_api_key
RIOT_REGION=na1
LOG_LEVEL=info
```

Region codes:

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

Start the bot:

```bash
npm start          # production
npm run start:watch # dev with file-change auto-restart
```

### First-Time Setup in Discord

1. `/bethere` in the channel you want notifications in
2. `/adduser YourName#TAG` for each tracked player
3. When a tracked player queues into a ranked game, the bot posts betting buttons

## Updating

```bash
cd LoLBetBot
git pull
npm install
```

Then restart the bot. New schema columns and tables auto-migrate on startup — no data loss.

On Raspberry Pi:

```bash
sudo systemctl restart discord-bet-bot
```

If you cloned without `.git`:

```bash
cd LoLBetBot
git init
git remote add origin https://github.com/nivaiges/LoLBetBot.git
git fetch origin
git reset origin/main
git checkout -- .
npm install
```

Your `.env`, `bot.db`, and `saved-graphs/` are preserved.

## Raspberry Pi

```bash
git clone https://github.com/nivaiges/LoLBetBot.git
cd LoLBetBot
chmod +x setup-pi.sh
./setup-pi.sh
```

Installs Node 20, build tools, npm deps, scaffolds `.env`, and registers a systemd service with crash-restart. Edit `.env` then:

```bash
sudo systemctl restart discord-bet-bot
sudo systemctl status discord-bet-bot
sudo journalctl -u discord-bet-bot -f   # live logs
```

## Configuration

`config.js`:

| Setting | Default | Description |
|---|---|---|
| `collectAmount` | 10,000 | Coins per `/collect` |
| `collectCooldownMs` | 7,200,000 (2 h) | Time between collects |
| `pollIntervalMs` | 60,000 (1 min) | How often to check Spectator-V5 |
| `bettingWindowMs` | 300,000 (5 min) | Bet window after match detection |
| `payoutMultiplier` | 1.5 | WIN bet payout |
| `losePayoutMultiplier` | 3 | LOSE bet payout |
| `parleyChance` | 0.175 | Probability of a parlay per match |
| `parleyPayoutMultiplier` | 2 | Per-leg multiplier (total = 2ⁿ for n legs) |
| `commandCooldownMs` | 5,000 | Per-user rate limit |
| `saveGraphAllowedUserIds` | `Set([...])` | Discord user IDs allowed to use 💾 Save / 📌 Keep buttons |

### Custom Rank Emoji

Upload rank icons as custom emoji in your Discord server, then fill in `config.js`:

```js
rankEmoji: {
  IRON: '<:Iron:123456789>',
  BRONZE: '<:Bronze:123456789>',
  // ...
},
```

Get an emoji ID by typing `\:emojiname:` in Discord and sending the message.

### Objective Icons

`assets/objectives/*.png` ships with this repo — minimap icons for Baron, Rift Herald, Void Grubs, all six elemental dragons, and the Elder Dragon (used as the Soul marker). Sourced from Community Dragon. Drop your own PNGs at the same paths to override.

## Files Excluded From the Repo

`.gitignore` keeps the following out:
- `node_modules/`, `.env`
- `*.db`, `*.db-shm`, `*.db-wal` — SQLite + WAL files
- `logs/` — runtime log output
- `sounds/` — voice-channel join sound files (named after Discord user IDs, personal)
- `saved-graphs/` — user-saved Match Over PNGs
- `.claude/` — Claude Code local state

## Riot API Notes

The bot uses two endpoint groups:

| Type | Example host | Used for |
|---|---|---|
| Platform (region) | `na1.api.riotgames.com` | Spectator-V5, League-V4 |
| Regional (continent) | `americas.api.riotgames.com` | Account-V1, Match-V5, Match-V5 Timeline |

The platform code from `RIOT_REGION` auto-maps to the correct regional endpoint. If you rotate your API key, just update `.env` and restart — PUUIDs are re-fetched on startup so the bot keeps working with the new key.
