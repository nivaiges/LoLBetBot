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
      UPDATE users SET correct = correct + 1, coins = coins + ?, total_won = total_won + ?, updated_at = datetime('now')
      WHERE guild_id = ? AND discord_id = ?
    `).run(amountWon, amountWon, guildId, discordId);
  } else {
    db.prepare(`
      UPDATE users SET incorrect = incorrect + 1, updated_at = datetime('now')
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

// ── Init ─────────────────────────────────────────────────────────────────────

migrate();

export default db;
