import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'bot.db');

const db = new Database(DB_PATH);

// Performance: WAL mode is faster for concurrent reads + single writer (our polling loop)
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema migration on startup ──────────────────────────────────────────────

function migrate() {
  logger.info('Running database migrations');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      guild_id   TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      coins      INTEGER NOT NULL DEFAULT 0,
      last_collect_at TEXT,
      correct    INTEGER NOT NULL DEFAULT 0,
      incorrect  INTEGER NOT NULL DEFAULT 0,
      total_wagered INTEGER NOT NULL DEFAULT 0,
      total_won     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, discord_id)
    );

    CREATE TABLE IF NOT EXISTS tracked_players (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      riot_tag   TEXT NOT NULL,
      puuid      TEXT NOT NULL,
      region     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(guild_id, puuid)
    );

    CREATE TABLE IF NOT EXISTS active_matches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id       TEXT NOT NULL,
      puuid          TEXT NOT NULL,
      match_id       TEXT NOT NULL,
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      state          TEXT NOT NULL DEFAULT 'active',
      UNIQUE(guild_id, match_id)
    );

    CREATE TABLE IF NOT EXISTS bets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id    TEXT NOT NULL,
      discord_id  TEXT NOT NULL,
      match_id    TEXT NOT NULL,
      puuid       TEXT NOT NULL,
      prediction  TEXT NOT NULL CHECK(prediction IN ('win', 'lose')),
      amount      INTEGER NOT NULL CHECK(amount > 0),
      placed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      outcome     TEXT CHECK(outcome IN ('correct', 'incorrect') OR outcome IS NULL),
      UNIQUE(guild_id, match_id, discord_id)
    );

    CREATE TABLE IF NOT EXISTS parley_bets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id    TEXT NOT NULL,
      discord_id  TEXT NOT NULL,
      match_id    TEXT NOT NULL,
      prediction  TEXT NOT NULL CHECK(prediction IN ('over', 'under')),
      amount      INTEGER NOT NULL CHECK(amount > 0),
      placed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      outcome     TEXT CHECK(outcome IN ('correct', 'incorrect') OR outcome IS NULL),
      UNIQUE(guild_id, match_id, discord_id)
    );

    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id    TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Add emoji toggle to guild_settings
  const gsCols = db.prepare("PRAGMA table_info('guild_settings')").all().map(c => c.name);
  if (!gsCols.includes('emoji_enabled')) {
    db.exec(`ALTER TABLE guild_settings ADD COLUMN emoji_enabled INTEGER NOT NULL DEFAULT 1`);
  }

  // Add parley columns to active_matches if missing
  const cols = db.prepare("PRAGMA table_info('active_matches')").all().map(c => c.name);
  if (!cols.includes('parley_stat')) {
    db.exec(`ALTER TABLE active_matches ADD COLUMN parley_stat TEXT`);
    db.exec(`ALTER TABLE active_matches ADD COLUMN parley_line REAL`);
  }
  if (!cols.includes('message_id')) {
    db.exec(`ALTER TABLE active_matches ADD COLUMN message_id TEXT`);
  }
  if (!cols.includes('close_message_id')) {
    db.exec(`ALTER TABLE active_matches ADD COLUMN close_message_id TEXT`);
  }

  // Add daily win/loss tracking to tracked_players
  const tpCols = db.prepare("PRAGMA table_info('tracked_players')").all().map(c => c.name);
  if (!tpCols.includes('daily_wins')) {
    db.exec(`ALTER TABLE tracked_players ADD COLUMN daily_wins INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE tracked_players ADD COLUMN daily_losses INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE tracked_players ADD COLUMN daily_reset_date TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_bets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id    TEXT NOT NULL,
      discord_id  TEXT NOT NULL,
      puuid       TEXT NOT NULL,
      prediction  TEXT NOT NULL CHECK(prediction IN ('win', 'lose')),
      amount      INTEGER NOT NULL CHECK(amount > 0),
      UNIQUE(guild_id, discord_id, puuid)
    );
  `);

  // Add betting streak columns to users
  const userCols = db.prepare("PRAGMA table_info('users')").all().map(c => c.name);
  if (!userCols.includes('current_streak')) {
    db.exec(`ALTER TABLE users ADD COLUMN current_streak INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE users ADD COLUMN best_streak INTEGER NOT NULL DEFAULT 0`);
  }

  if (!tpCols.includes('peak_tier')) {
    db.exec(`ALTER TABLE tracked_players ADD COLUMN peak_tier TEXT`);
    db.exec(`ALTER TABLE tracked_players ADD COLUMN peak_rank TEXT`);
    db.exec(`ALTER TABLE tracked_players ADD COLUMN peak_lp INTEGER`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS achievements (
      guild_id    TEXT NOT NULL,
      discord_id  TEXT NOT NULL,
      achievement TEXT NOT NULL,
      unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, discord_id, achievement)
    );
  `);
}

// ── Query helpers ────────────────────────────────────────────────────────────

export function ensureUser(guildId, discordId) {
  db.prepare(`
    INSERT OR IGNORE INTO users (guild_id, discord_id)
    VALUES (?, ?)
  `).run(guildId, discordId);
  return db.prepare('SELECT * FROM users WHERE guild_id = ? AND discord_id = ?').get(guildId, discordId);
}

export function getUser(guildId, discordId) {
  return db.prepare('SELECT * FROM users WHERE guild_id = ? AND discord_id = ?').get(guildId, discordId);
}

export function updateCollect(guildId, discordId, newCoins, now) {
  db.prepare(`
    UPDATE users SET coins = ?, last_collect_at = ?, updated_at = datetime('now')
    WHERE guild_id = ? AND discord_id = ?
  `).run(newCoins, now, guildId, discordId);
}

export function addCoins(guildId, discordId, amount) {
  db.prepare(`
    UPDATE users SET coins = coins + ?, updated_at = datetime('now')
    WHERE guild_id = ? AND discord_id = ?
  `).run(amount, guildId, discordId);
}

export function deductCoins(guildId, discordId, amount) {
  db.prepare(`
    UPDATE users SET coins = coins - ?, total_wagered = total_wagered + ?, updated_at = datetime('now')
    WHERE guild_id = ? AND discord_id = ?
  `).run(amount, amount, guildId, discordId);
}

// Tracked players
export function addTrackedPlayer(guildId, riotTag, puuid, region) {
  return db.prepare(`
    INSERT OR IGNORE INTO tracked_players (guild_id, riot_tag, puuid, region)
    VALUES (?, ?, ?, ?)
  `).run(guildId, riotTag, puuid, region);
}

export function getTrackedPlayers(guildId) {
  return db.prepare('SELECT * FROM tracked_players WHERE guild_id = ?').all(guildId);
}

export function getAllTrackedPlayers() {
  return db.prepare('SELECT * FROM tracked_players').all();
}

export function getTrackedPlayerByTag(guildId, riotTag) {
  return db.prepare('SELECT * FROM tracked_players WHERE guild_id = ? AND riot_tag = ? COLLATE NOCASE').get(guildId, riotTag);
}

export function updateTrackedPlayerPuuid(id, puuid) {
  return db.prepare('UPDATE tracked_players SET puuid = ? WHERE id = ?').run(puuid, id);
}

export function removeTrackedPlayer(guildId, riotTag) {
  const player = db.prepare('SELECT * FROM tracked_players WHERE guild_id = ? AND riot_tag = ? COLLATE NOCASE').get(guildId, riotTag);
  if (!player) return null;
  db.prepare('DELETE FROM auto_bets WHERE guild_id = ? AND puuid = ?').run(guildId, player.puuid);
  db.prepare('DELETE FROM tracked_players WHERE id = ?').run(player.id);
  return player;
}

export function transferCoins(guildId, fromId, toId, amount) {
  const sender = ensureUser(guildId, fromId);
  if (sender.coins < amount) return false;
  db.prepare('UPDATE users SET coins = coins - ?, updated_at = datetime(\'now\') WHERE guild_id = ? AND discord_id = ?').run(amount, guildId, fromId);
  ensureUser(guildId, toId);
  db.prepare('UPDATE users SET coins = coins + ?, updated_at = datetime(\'now\') WHERE guild_id = ? AND discord_id = ?').run(amount, guildId, toId);
  return true;
}

// Active matches
export function upsertActiveMatch(guildId, puuid, matchId) {
  return db.prepare(`
    INSERT OR IGNORE INTO active_matches (guild_id, puuid, match_id)
    VALUES (?, ?, ?)
  `).run(guildId, puuid, matchId);
}

export function getActiveMatch(guildId, puuid) {
  return db.prepare(`
    SELECT * FROM active_matches WHERE guild_id = ? AND puuid = ? AND state = 'active'
  `).get(guildId, puuid);
}

export function getActiveMatchByMatchId(guildId, matchId) {
  return db.prepare(`
    SELECT * FROM active_matches WHERE guild_id = ? AND match_id = ? AND state = 'active'
  `).get(guildId, matchId);
}

export function getAllActiveMatches() {
  return db.prepare("SELECT * FROM active_matches WHERE state = 'active'").all();
}

export function markMatchFinished(guildId, matchId) {
  db.prepare(`
    UPDATE active_matches SET state = 'finished', last_checked_at = datetime('now')
    WHERE guild_id = ? AND match_id = ?
  `).run(guildId, matchId);
}

export function touchMatch(id) {
  db.prepare("UPDATE active_matches SET last_checked_at = datetime('now') WHERE id = ?").run(id);
}

// Bets
export function placeBet(guildId, discordId, matchId, puuid, prediction, amount) {
  return db.prepare(`
    INSERT INTO bets (guild_id, discord_id, match_id, puuid, prediction, amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, discordId, matchId, puuid, prediction, amount);
}

export function getUserBetOnMatch(guildId, discordId, matchId) {
  return db.prepare(`
    SELECT * FROM bets WHERE guild_id = ? AND discord_id = ? AND match_id = ?
  `).get(guildId, discordId, matchId);
}

export function updateBet(betId, prediction, amount) {
  return db.prepare(`
    UPDATE bets SET prediction = ?, amount = ? WHERE id = ? AND outcome IS NULL
  `).run(prediction, amount, betId);
}

export function getUnresolvedBetsByMatch(guildId, matchId) {
  return db.prepare(`
    SELECT * FROM bets WHERE guild_id = ? AND match_id = ? AND outcome IS NULL
  `).all(guildId, matchId);
}

export function resolveBet(betId, outcome) {
  db.prepare(`
    UPDATE bets SET outcome = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(outcome, betId);
}

export function updateUserStats(guildId, discordId, correct, amountWon) {
  if (correct) {
    db.prepare(`
      UPDATE users SET correct = correct + 1, coins = coins + ?, total_won = total_won + ?,
        current_streak = current_streak + 1,
        best_streak = MAX(best_streak, current_streak + 1),
        updated_at = datetime('now')
      WHERE guild_id = ? AND discord_id = ?
    `).run(amountWon, amountWon, guildId, discordId);
  } else {
    db.prepare(`
      UPDATE users SET incorrect = incorrect + 1, current_streak = 0, updated_at = datetime('now')
      WHERE guild_id = ? AND discord_id = ?
    `).run(guildId, discordId);
  }
}

// Leaderboard
export function getTopUsers(guildId, limit = 10) {
  return db.prepare(`
    SELECT * FROM users WHERE guild_id = ? ORDER BY coins DESC LIMIT ?
  `).all(guildId, limit);
}

// Guild settings
export function setGuildChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO guild_settings (guild_id, channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = ?, updated_at = datetime('now')
  `).run(guildId, channelId, channelId);
}

export function getGuildChannel(guildId) {
  const row = db.prepare('SELECT channel_id FROM guild_settings WHERE guild_id = ?').get(guildId);
  return row?.channel_id || null;
}

export function isEmojiEnabled(guildId) {
  const row = db.prepare('SELECT emoji_enabled FROM guild_settings WHERE guild_id = ?').get(guildId);
  return row ? row.emoji_enabled === 1 : true; // default on
}

export function setEmojiEnabled(guildId, enabled) {
  const row = db.prepare('SELECT guild_id FROM guild_settings WHERE guild_id = ?').get(guildId);
  if (row) {
    db.prepare('UPDATE guild_settings SET emoji_enabled = ?, updated_at = datetime(\'now\') WHERE guild_id = ?').run(enabled ? 1 : 0, guildId);
  } else {
    db.prepare('INSERT INTO guild_settings (guild_id, channel_id, emoji_enabled) VALUES (?, \'\', ?)').run(guildId, enabled ? 1 : 0);
  }
}

// Parley
export function setMatchParley(guildId, matchId, stat, line) {
  db.prepare(`
    UPDATE active_matches SET parley_stat = ?, parley_line = ?
    WHERE guild_id = ? AND match_id = ?
  `).run(stat, line, guildId, matchId);
}

export function getMatchParley(guildId, matchId) {
  return db.prepare(`
    SELECT parley_stat, parley_line FROM active_matches
    WHERE guild_id = ? AND match_id = ?
  `).get(guildId, matchId);
}

export function placeParleyBet(guildId, discordId, matchId, prediction, amount) {
  return db.prepare(`
    INSERT INTO parley_bets (guild_id, discord_id, match_id, prediction, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, discordId, matchId, prediction, amount);
}

export function getUserParleyBetOnMatch(guildId, discordId, matchId) {
  return db.prepare(`
    SELECT * FROM parley_bets WHERE guild_id = ? AND discord_id = ? AND match_id = ?
  `).get(guildId, discordId, matchId);
}

export function getUnresolvedParleyBetsByMatch(guildId, matchId) {
  return db.prepare(`
    SELECT * FROM parley_bets WHERE guild_id = ? AND match_id = ? AND outcome IS NULL
  `).all(guildId, matchId);
}

export function resolveParleyBet(betId, outcome) {
  db.prepare(`
    UPDATE parley_bets SET outcome = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(outcome, betId);
}

// Message tracking
export function setMatchMessageId(guildId, matchId, messageId) {
  db.prepare('UPDATE active_matches SET message_id = ? WHERE guild_id = ? AND match_id = ?').run(messageId, guildId, matchId);
}

export function setMatchCloseMessageId(guildId, matchId, messageId) {
  db.prepare('UPDATE active_matches SET close_message_id = ? WHERE guild_id = ? AND match_id = ?').run(messageId, guildId, matchId);
}

export function getMatchMessages(guildId, matchId) {
  return db.prepare('SELECT message_id, close_message_id FROM active_matches WHERE guild_id = ? AND match_id = ?').get(guildId, matchId);
}

// Daily win/loss tracking
export function recordDailyResult(guildId, puuid, won) {
  const today = new Date().toISOString().slice(0, 10);
  const player = db.prepare('SELECT daily_reset_date FROM tracked_players WHERE guild_id = ? AND puuid = ?').get(guildId, puuid);
  if (player?.daily_reset_date !== today) {
    db.prepare('UPDATE tracked_players SET daily_wins = 0, daily_losses = 0, daily_reset_date = ? WHERE guild_id = ? AND puuid = ?').run(today, guildId, puuid);
  }
  if (won) {
    db.prepare('UPDATE tracked_players SET daily_wins = daily_wins + 1 WHERE guild_id = ? AND puuid = ?').run(guildId, puuid);
  } else {
    db.prepare('UPDATE tracked_players SET daily_losses = daily_losses + 1 WHERE guild_id = ? AND puuid = ?').run(guildId, puuid);
  }
}

export function getDailyRecord(guildId, puuid) {
  const today = new Date().toISOString().slice(0, 10);
  const player = db.prepare('SELECT daily_wins, daily_losses, daily_reset_date FROM tracked_players WHERE guild_id = ? AND puuid = ?').get(guildId, puuid);
  if (!player || player.daily_reset_date !== today) return { wins: 0, losses: 0 };
  return { wins: player.daily_wins, losses: player.daily_losses };
}

// Peak rank tracking
export function updatePeakRank(guildId, puuid, tier, rank, lp, rankValue) {
  const player = db.prepare('SELECT peak_tier, peak_rank, peak_lp FROM tracked_players WHERE guild_id = ? AND puuid = ?').get(guildId, puuid);
  if (!player) return;
  // Calculate current peak value for comparison
  const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
  const DIVISIONS = ['IV', 'III', 'II', 'I'];
  let peakValue = 0;
  if (player.peak_tier) {
    const ti = TIERS.indexOf(player.peak_tier);
    const di = DIVISIONS.indexOf(player.peak_rank || 'I');
    peakValue = (ti >= 7 ? ti * 4 : ti * 4 + di) * 100 + (player.peak_lp || 0);
  }
  const currentValue = (rankValue) * 100 + lp;
  if (currentValue > peakValue) {
    db.prepare('UPDATE tracked_players SET peak_tier = ?, peak_rank = ?, peak_lp = ? WHERE guild_id = ? AND puuid = ?').run(tier, rank, lp, guildId, puuid);
  }
}

export function getPeakRanks(guildId) {
  return db.prepare('SELECT riot_tag, peak_tier, peak_rank, peak_lp FROM tracked_players WHERE guild_id = ?').all(guildId);
}

// Auto-bets
export function setAutoBet(guildId, discordId, puuid, prediction, amount) {
  return db.prepare(`
    INSERT INTO auto_bets (guild_id, discord_id, puuid, prediction, amount)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, discord_id, puuid) DO UPDATE SET prediction = ?, amount = ?
  `).run(guildId, discordId, puuid, prediction, amount, prediction, amount);
}

export function removeAutoBet(guildId, discordId, puuid) {
  return db.prepare('DELETE FROM auto_bets WHERE guild_id = ? AND discord_id = ? AND puuid = ?').run(guildId, discordId, puuid);
}

export function getAutoBets(guildId, discordId) {
  return db.prepare('SELECT ab.*, tp.riot_tag FROM auto_bets ab JOIN tracked_players tp ON ab.guild_id = tp.guild_id AND ab.puuid = tp.puuid WHERE ab.guild_id = ? AND ab.discord_id = ?').all(guildId, discordId);
}

export function getAutoBetsForMatch(guildId, puuid) {
  return db.prepare('SELECT * FROM auto_bets WHERE guild_id = ? AND puuid = ?').all(guildId, puuid);
}

// Achievements
const ACHIEVEMENT_DEFS = [
  { id: 'bets_10',    label: '🎰 Gambler — 10 bets placed',          check: u => u.correct + u.incorrect >= 10 },
  { id: 'bets_50',    label: '🎰 Regular — 50 bets placed',          check: u => u.correct + u.incorrect >= 50 },
  { id: 'bets_100',   label: '🎰 Veteran — 100 bets placed',         check: u => u.correct + u.incorrect >= 100 },
  { id: 'bets_500',   label: '🎰 Addict — 500 bets placed',          check: u => u.correct + u.incorrect >= 500 },
  { id: 'bets_1000',  label: '🎰 Degenerate — 1,000 bets placed',    check: u => u.correct + u.incorrect >= 1000 },
  { id: 'wins_10',    label: '✅ Lucky — 10 bets won',                check: u => u.correct >= 10 },
  { id: 'wins_50',    label: '✅ Sharp — 50 bets won',                check: u => u.correct >= 50 },
  { id: 'wins_100',   label: '✅ Oracle — 100 bets won',              check: u => u.correct >= 100 },
  { id: 'wins_1000',  label: '✅ Prophet — 1,000 bets won',           check: u => u.correct >= 1000 },
  { id: 'streak_5',   label: '🔥 Hot Hand — 5 win streak',           check: u => u.best_streak >= 5 },
  { id: 'streak_10',  label: '🔥 On Fire — 10 win streak',           check: u => u.best_streak >= 10 },
  { id: 'streak_20',  label: '🔥 Untouchable — 20 win streak',       check: u => u.best_streak >= 20 },
  { id: 'streak_50',  label: '🔥 Legendary — 50 win streak',         check: u => u.best_streak >= 50 },
  { id: 'streak_100', label: '🔥 Mythical — 100 win streak',         check: u => u.best_streak >= 100 },
];

export { ACHIEVEMENT_DEFS };

export function getUnlockedAchievements(guildId, discordId) {
  return db.prepare('SELECT achievement FROM achievements WHERE guild_id = ? AND discord_id = ?').all(guildId, discordId).map(r => r.achievement);
}

export function unlockAchievement(guildId, discordId, achievementId) {
  return db.prepare('INSERT OR IGNORE INTO achievements (guild_id, discord_id, achievement) VALUES (?, ?, ?)').run(guildId, discordId, achievementId);
}

export function checkAchievements(guildId, discordId) {
  const user = getUser(guildId, discordId);
  if (!user) return [];
  const unlocked = new Set(getUnlockedAchievements(guildId, discordId));
  const newlyUnlocked = [];
  for (const def of ACHIEVEMENT_DEFS) {
    if (!unlocked.has(def.id) && def.check(user)) {
      unlockAchievement(guildId, discordId, def.id);
      newlyUnlocked.push(def);
    }
  }
  return newlyUnlocked;
}

// Bet history
export function getBetHistory(guildId, discordId, limit = 10) {
  return db.prepare(`
    SELECT b.*, tp.riot_tag FROM bets b
    LEFT JOIN tracked_players tp ON b.guild_id = tp.guild_id AND b.puuid = tp.puuid
    WHERE b.guild_id = ? AND b.discord_id = ?
    ORDER BY b.placed_at DESC LIMIT ?
  `).all(guildId, discordId, limit);
}

// Per-player betting record
export function getPerPlayerRecord(guildId, discordId) {
  return db.prepare(`
    SELECT b.puuid, tp.riot_tag,
      SUM(CASE WHEN b.outcome = 'correct' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN b.outcome = 'incorrect' THEN 1 ELSE 0 END) as losses,
      SUM(b.amount) as total_wagered
    FROM bets b
    LEFT JOIN tracked_players tp ON b.guild_id = tp.guild_id AND b.puuid = tp.puuid
    WHERE b.guild_id = ? AND b.discord_id = ? AND b.outcome IS NOT NULL
    GROUP BY b.puuid
    ORDER BY (wins + losses) DESC
  `).all(guildId, discordId);
}

// ── Init ─────────────────────────────────────────────────────────────────────

migrate();

export default db;
