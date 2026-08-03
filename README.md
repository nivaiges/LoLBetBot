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
- `/adduser <GameName#TagLine>` — Add a tracked player (**owner-only**; hard-coded Discord ID gate)
- `/removeuser <GameName#TagLine>` — Stop tracking
- `/rank` — Rank Ladder card: 9-player ladder sorted by absolute LP, showing tier emblem, current + peak, progress bar to next tier (live Master → GM / GM → Challenger cutoffs), weekly LP delta, and 👑 / 🥀 for first/last place
- `/peak` — All-time peak Solo/Duo rank per tracked player
- `/records [season]` — Historical peak ranks from past seasons (populated by `season-reset.js`)
- `/lp [player]` — **LP Profile card**: profile icon + level, big rank emblem, faded top-champion splash background, Current/Peak/Win-Rate/Games stat tiles, progress bar with `X LP to <NEXT>`, and an LP-history chart with tier-color line segments (green up / red down) and rank-label Y-axis
- `/lpc <player1> <player2> ...` — Compare multiple players' LP histories on a single chart
- `/predict10 [player]` — 10-game win-count prediction (5× / 2× / 0.5× payout based on how close you are)
- `/predictions` — List your open 10-game predictions
- `/duo` — Duo W/L records (auto-tracked when two tracked players are on the same team)

### Betting
- `/bet <win|lose> <amount> [player]` — Bet on a tracked player's match (also available via buttons on match-detected embeds)
- `/autobet [player] [prediction] [amount]` — Auto-bet on a player every game; persistent until cleared

### Admin / Settings
- `/bethere` — Set the current channel for betting notifications
- `/emoji <on|off>` — Toggle rank emoji display
- `/autodelete <on|off>` — Toggle whether the bot auto-deletes its own Match Detected / Match Over messages on the next match (default ON; turn OFF to keep a running history channel)
- `/help` — List all commands

## What the Bot Does Automatically

- **Match detection** — Polls Riot Spectator-V5 every 60 s for tracked players. When one enters a game the bot posts a **Match Detected card** (rendered PNG, no embed): blue/red team panels with champion avatars ringed by the player's tier color, mini-crest rank pill under each name, lane icon overlay, a ban strip per team, and the tracked player highlighted with a gold ring + italic gold name. Duos in the same match get **one shared card** that highlights both partners (not two duplicate posts)
- **Betting buttons** — 🟢 WIN, 🔴 LOSE, 🟡 **Auto-bet**, and (when available) a 🎰 **Parlay** button. There's also a 🔗 u.gg multisearch link that opens all 10 players side-by-side
- **Lane inference** — Team composition is ordered TOP → JUNGLE → MIDDLE → BOTTOM → UTILITY via Meraki play-rate optimization; the **smite carrier is hard-pinned to JUNGLE** so meta-flex picks (e.g. jungle Garen) can't be misassigned
- **Parlay V2** — ~17.5 % of matches roll a 2- to 4-leg prop bet. **Role-aware pool** of 18 legs (kills, deaths, assists, KDA, CS, gold, damage dealt/taken, vision, wards placed/killed, KP%, multi-kills, first blood, triple kill, won lane, win, game length) with per-role line ranges — supports get wards/vision/assists in the right ranges, junglers get elevated kill lines, ADCs get CS but not damage-taken, etc. **Parlay is a side-bet**: you must place a WIN or LOSE first before the parlay modal opens
- **Auto-bets fire on next match** — Persistent across games until explicitly cleared with `/autobet … clear:True`
- **The House** — automated rank-skill bettor that places a 1,000 🪙 bet on every match based on team-average LP delta; confidence % shown on the bet line
- **Moneyline odds** — The House's `pWin` also drives the per-bet multiplier. WIN pays `(1 − houseEdge) / pWin`, LOSE pays `(1 − houseEdge) / (1 − pWin)`, both clamped to `[min, max]` (see config). The 5 % `houseEdge` is disclosed on the Match Detected card ("_includes 5% house edge_") — favorite side pays less, underdog pays more. Multipliers are **locked in at bet placement**, stored per-bet, and used at settle time — retuning odds later never changes an already-placed bet's payout
- **5-minute betting window** — Bets close 5 min after match detection; buttons are stripped (or the whole Match Detected message replaced, depending on `/autodelete`)
- **Remake handling** — Riot's `gameEndedInEarlySurrender` flag triggers a full bet refund with no W/L recorded
- **Untracked-queue silent cancel** — Only Solo/Duo, Flex, Norms, ARAM, Clash, Quickplay, ARURF, OFA, URF are treated as "real" matches. Anything else (e.g. new ranked-5s mode Riot ships mid-season) still posts Match Detected so people see the game, but at match end the bot silently refunds bets and deletes the message — no Match Over post, no W/L recorded
- **Auto-settle bets** — On match end the bot calls Match-V5, calculates payouts using the multiplier locked in at bet placement (moneyline; parlay still pays 2ⁿ), updates user stats and achievements
- **Daily W/L** — Match results show the player's today's record, with 🔥 when above 50 %. Resets at local midnight (not UTC)
- **Won lane** — At match end, the bot compares gold@14 vs the role opponent and increments `lane_wins` / `lane_losses` per tracked player. Shown in Match Over as ✓ Won Lane / ✕ Lost Lane with the gold-diff number
- **Peak rank tracking** — Updates after every match; `/rank` shows distance from peak
- **Rate-limit handling** — Global semaphore caps in-flight Riot requests at 10; 429 responses trigger auto-retry with `Retry-After` sleep + a shared cooldown so other in-flight requests short-circuit until Riot recovers. Commands surface a canonical "⏳ Riot API is rate-limiting us" message when hit
- **Apex-tier cutoffs** — Master/GM/Challenger promotion thresholds are computed from the live ladder (top 300 → Challenger, next 700 → GM). Fetches Master + GM + Challenger endpoints (~2 MB total) once per region and caches for 6 hours; used by `/rank` and `/lp` to show accurate "X LP to Grandmaster" text

### Match Over — 3-panel layout

Every Match Over message ships **three attachments** that Discord auto-arranges as one big-on-left + two-stacked-on-right grid:

1. **Splash card** (main, portrait) — per tracked player: faded champion splash art background (Community Dragon's centered variant so the face always lands in frame), avatar with tier-color ring, big colored KDA (green/grey/red/grey/blue), CS · DMG · KP% stats, Today: XW YL 🔥 daily record, ✓/✕ Won Lane with gold-diff. Duos stack two splash cards vertically inside the same image. Below the card: **BETS SETTLED** (House + top 2 user bets by amount), an optional PARLAY block, and the **GOLD GRAPH** — a full-width chart of team gold lead over time with:
   - Blue area-fill above zero (ahead), red below (behind)
   - Peak callouts for max lead + max deficit (`+5.4k @ 22m` / `-2.8k @ 8m`)
   - **Objective pins** — real Riot minimap icons (`assets/objectives/`) for Baron, Rift Herald, Void Grubs, all six elemental dragons, and Dragon Soul. Blue if the tracked team got it, red if the enemy. Pin flips to the bottom of the plot when the line is below zero at that minute
   - **Kill X-stacks** — one X per tracked-player kill, anchored to the y=0 baseline; multikills within 10s collapse into a `XX`/`XXX`/`XXXX`/`XXXXX` column colored yellow→orange→red→purple→hot pink for single→penta
2. **Scoreboard panel** (top-right) — full 10-player table grouped by team, with the **live-scoreboard visual language**: primary keystone rune + secondary rune path stacked, summoner spells (D+F) stacked, champion avatar with a level-pip, then columns for K/D/A (colored), CS, DMG, KP%, Gold, and the 7 item slots (Data Dragon item icons)
3. **Impact chart** (bottom-right) — vertical triple-bar chart for all 10 players: **Damage · CC Score · Vision Score**, normalized to lobby-max per metric so the tallest bar per color is the leader. Small gold ▼ marker above each metric's leader; tracked player's column has a gold-tinted background stripe

- **📌 Keep in Chat** button — re-posts the composite as a standalone message that survives the auto-clear (see *Save / Keep* below)

### LP Profile card (`/lp`)

Full profile card per player. Captures an LP snapshot on every match end + `/rank` call (skips duplicates when LP/tier hasn't changed). Layout:

- **Header** — profile icon with tier-color ring + summoner-level badge, big `RiotID#TAG`, mini-crest + `TIER DIVISION` label, and the player's **top-champion splash art** faded into the right half of the header (Champion Mastery-V4, cached 1 h per player)
- **Stat tiles** — Current LP (with mini-crest), Peak LP (with mini-crest for the peak tier), Win Rate donut (green/red) + `W L` breakdown
- **Progress bar** — tier-color bar filled to `lp / next_threshold`, with `X LP to <NEXT_TIER>` on the right. Uses live apex cutoffs for Master → GM and GM → Challenger; "Awaiting promo" when a Master player's LP already exceeds the live GM cutoff
- **LP History chart** — line plotting absolute LP so promotions read as a continuous climb, with:
  - **Rank-label Y-axis** for sub-master ticks (`D4`, `D3`, `E1`, …) and `MAS X` raw LP once you cross 2800
  - **Tier-color background bands** so you can see at a glance which division a data point sits in
  - **Dashed reference lines** at the Master threshold and the live apex cutoff
  - **Per-segment line colors** — green segment when LP rose, red when it fell
  - **Dots only at peaks and pits** — windowed local-extremum detection so long histories don't get dotted at every game
  - **End-of-line callout** with the current rank + LP (e.g. `D4 45 LP`, `MAS 575 LP`)

### Rank Ladder (`/rank`)

Card-based ladder sorted by absolute LP (highest first). Each row shows:
- Rank number (👑 for #1 with a gold accent, plain number for the rest; 🥀 prefix on the last-place row)
- Summoner profile icon
- Player name + "Peak: `<TIER>`" subtitle (or "CURRENT PEAK!" in gold when they're at their all-time peak)
- Tier emblem (source-cropped so the crest fills the slot cleanly, no wing squish)
- `TIER DIVISION` label + big LP + progress bar to next tier with `X LP to Y` text (next-tier name colored with that tier's color — GM in red, Challenger in gold, etc.)
- Weekly LP delta (↑ green / ↓ red) computed from the earliest lp_history entry within the past 7 days

### Profit Chart (`/stats`)

Cumulative net profit over your full bet history, signed-line chart with the same blue/red fill split at zero. Pulls from `bets` and `parley_bets` (cancelled bets ignored).

## Save / Keep (allowlisted)

Two buttons appear under every Match Over chart:

- **💾 Save** — writes the PNG to `saved-graphs/<user-id>/<match-id>.png` on the bot host
- **📌 Keep in Chat** — re-posts the chart as a standalone chat message captioned `📌 Kept by <user>`. The re-posted message isn't tracked, so it survives the auto-clear when the next match starts. Gets removed at the next nightly cleanup

Both buttons are gated by `config.saveGraphAllowedUserIds` — only the listed Discord user IDs can click them; everyone else gets an ephemeral "not allowed" reply.

## Message Lifecycle & Cleanup

- The bot **strips the betting buttons** off the Match Detected message when the 5-minute window closes (edit in place — no delete + resend)
- With `/autodelete on` (default): deletes the Match Detected + previous Match Over messages when the same player enters their next game
- With `/autodelete off`: keeps every Match Detected / Match Over in the channel as a persistent history log (per-guild setting, stored in `guild_settings.auto_delete_enabled`)
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
| `houseEdge` | 0.05 | Vig baked into every moneyline multiplier (5% house cut) |
| `minWinMultiplier` / `maxWinMultiplier` | 1.2 / 3.0 | Floor/ceiling on WIN payouts |
| `minLoseMultiplier` / `maxLoseMultiplier` | 1.5 / 5.0 | Floor/ceiling on LOSE payouts |
| `payoutMultiplier` | 1.5 | Legacy WIN payout — fallback only for pre-moneyline bets |
| `losePayoutMultiplier` | 3 | Legacy LOSE payout — fallback only for pre-moneyline bets |
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
- `assets/champions/`, `assets/profile-icons/`, `assets/ranks/`, `assets/ranks-mini/`, `assets/lanes/`, `assets/splash/`, `assets/items/`, `assets/summoner-spells/`, `assets/runes/` — auto-downloaded Data Dragon / Community Dragon caches. Populated lazily on first use; safe to delete at any time (they refetch)
- `data/` — Meraki play-rate cache (used by lane inference)

## Riot API Notes

The bot uses two endpoint groups:

| Type | Example host | Used for |
|---|---|---|
| Platform (region) | `na1.api.riotgames.com` | Spectator-V5, League-V4 entries + apex ladders, Summoner-V4, Champion-Mastery-V4 |
| Regional (continent) | `americas.api.riotgames.com` | Account-V1, Match-V5, Match-V5 Timeline |

The platform code from `RIOT_REGION` auto-maps to the correct regional endpoint. If you rotate your API key, just update `.env` and restart — PUUIDs are re-fetched on startup so the bot keeps working with the new key.

**Rate limiting** — one global semaphore caps concurrent Riot fetches at 10. 429 responses trigger auto-retry with `Retry-After` sleep + a shared cooldown so other in-flight requests short-circuit until Riot recovers. Cached call sites: apex ladders (6h per region), top champion (1h per player), Data Dragon champion metadata (once per bot start).

## Asset CDNs

Icon assets are lazy-fetched from Data Dragon or Community Dragon on first use and cached locally under `assets/`. See [src/utils/](src/utils/) for the fetchers:

| Util | Source | Cached to |
|---|---|---|
| `championIcons.js` | Data Dragon `img/champion/<Name>.png` | `assets/champions/` |
| `championSplash.js` | Community Dragon centered splash | `assets/splash/` |
| `itemIcons.js` | Data Dragon `img/item/<id>.png` | `assets/items/` |
| `laneIcons.js` | Community Dragon position-selector | `assets/lanes/` |
| `profileIcons.js` | Data Dragon `img/profileicon/<id>.png` | `assets/profile-icons/` |
| `rankEmblems.js` | Community Dragon ranked-emblem + mini-crest | `assets/ranks/` + `assets/ranks-mini/` |
| `runeIcons.js` | Community Dragon perks + perkstyles + summoner-spells | `assets/runes/` + `assets/summoner-spells/` |
