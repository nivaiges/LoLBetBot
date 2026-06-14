import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from './utils/logger.js';
import { peakLog } from './utils/peakLog.js';

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
      outcome     TEXT CHECK(outcome IN ('correct', 'incorrect', 'cancelled') OR outcome IS NULL),
      UNIQUE(guild_id, match_id, discord_id)
    );

    CREATE TABLE IF NOT EXISTS parley_bets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id    TEXT NOT NULL,
      discord_id  TEXT NOT NULL,
      match_id    TEXT NOT NULL,
      predictions TEXT NOT NULL,
      amount      INTEGER NOT NULL CHECK(amount > 0),
      placed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      outcome     TEXT CHECK(outcome IN ('correct', 'incorrect', 'cancelled') OR outcome IS NULL),
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
  if (!cols.includes('parlay_legs')) {
    db.exec(`ALTER TABLE active_matches ADD COLUMN parlay_legs TEXT`);
  }
  if (!cols.includes('message_id')) {
    db.exec(`ALTER TABLE active_matches ADD COLUMN message_id TEXT`);
  }
  if (!cols.includes('close_message_id')) {
    db.exec(`ALTER TABLE active_matches ADD COLUMN close_message_id TEXT`);
  }
  if (!cols.includes('extra_message_ids')) {
    db.exec(`ALTER TABLE active_matches ADD COLUMN extra_message_ids TEXT`);
  }

  // Migrate active_matches unique constraint from (guild_id, match_id) to
  // (guild_id, puuid, match_id) so two tracked players in the same game each
  // get their own row.
  const idxInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='active_matches'").get();
  if (idxInfo && idxInfo.sql.includes('UNIQUE(guild_id, match_id)')) {
    logger.info('Migrating active_matches: UNIQUE(guild_id, match_id) → UNIQUE(guild_id, puuid, match_id)');
    db.exec(`
      CREATE TABLE active_matches_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id        TEXT NOT NULL,
        puuid           TEXT NOT NULL,
        match_id        TEXT NOT NULL,
        started_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        state           TEXT NOT NULL DEFAULT 'active',
        parley_stat     TEXT,
        parley_line     REAL,
        message_id      TEXT,
        close_message_id TEXT,
        UNIQUE(guild_id, puuid, match_id)
      );
      INSERT INTO active_matches_new (id, guild_id, puuid, match_id, started_at, last_checked_at, state, parley_stat, parley_line, message_id, close_message_id)
        SELECT id, guild_id, puuid, match_id, started_at, last_checked_at, state, parley_stat, parley_line, message_id, close_message_id FROM active_matches;
      DROP TABLE active_matches;
      ALTER TABLE active_matches_new RENAME TO active_matches;
    `);
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

  if (!tpCols.includes('last_match_over_message_id')) {
    db.exec(`ALTER TABLE tracked_players ADD COLUMN last_match_over_message_id TEXT`);
  }

  if (!tpCols.includes('lane_wins')) {
    db.exec(`ALTER TABLE tracked_players ADD COLUMN lane_wins INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE tracked_players ADD COLUMN lane_losses INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate parley_bets: old schema had single `prediction TEXT`, new schema uses `predictions TEXT` (JSON array)
  const parleyBetsCols = db.prepare("PRAGMA table_info('parley_bets')").all().map(c => c.name);
  if (!parleyBetsCols.includes('predictions')) {
    logger.info('Migrating parley_bets: prediction → predictions (JSON array)');
    db.exec(`
      CREATE TABLE parley_bets_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        discord_id  TEXT NOT NULL,
        match_id    TEXT NOT NULL,
        predictions TEXT NOT NULL,
        amount      INTEGER NOT NULL CHECK(amount > 0),
        placed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        outcome     TEXT CHECK(outcome IN ('correct', 'incorrect') OR outcome IS NULL),
        UNIQUE(guild_id, match_id, discord_id)
      );
      INSERT INTO parley_bets_new (id, guild_id, discord_id, match_id, predictions, amount, placed_at, resolved_at, outcome)
        SELECT id, guild_id, discord_id, match_id, json_array(prediction), amount, placed_at, resolved_at, outcome
        FROM parley_bets;
      DROP TABLE parley_bets;
      ALTER TABLE parley_bets_new RENAME TO parley_bets;
    `);
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

  // Migrate bets table to allow 'cancelled' outcome
  const betsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bets'").get();
  if (betsSchema && !betsSchema.sql.includes('cancelled')) {
    logger.info('Migrating bets: adding cancelled outcome');
    db.exec(`
      CREATE TABLE bets_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        discord_id  TEXT NOT NULL,
        match_id    TEXT NOT NULL,
        puuid       TEXT NOT NULL,
        prediction  TEXT NOT NULL CHECK(prediction IN ('win', 'lose')),
        amount      INTEGER NOT NULL CHECK(amount > 0),
        placed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        outcome     TEXT CHECK(outcome IN ('correct', 'incorrect', 'cancelled') OR outcome IS NULL),
        UNIQUE(guild_id, match_id, discord_id)
      );
      INSERT INTO bets_new SELECT * FROM bets;
      DROP TABLE bets;
      ALTER TABLE bets_new RENAME TO bets;
    `);
  }

  // Migrate parley_bets table to allow 'cancelled' outcome
  const parleySchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='parley_bets'").get();
  if (parleySchema && !parleySchema.sql.includes('cancelled')) {
    logger.info('Migrating parley_bets: adding cancelled outcome');
    db.exec(`
      CREATE TABLE parley_bets_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        discord_id  TEXT NOT NULL,
        match_id    TEXT NOT NULL,
        predictions TEXT NOT NULL,
        amount      INTEGER NOT NULL CHECK(amount > 0),
        placed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        outcome     TEXT CHECK(outcome IN ('correct', 'incorrect', 'cancelled') OR outcome IS NULL),
        UNIQUE(guild_id, match_id, discord_id)
      );
      INSERT INTO parley_bets_new SELECT * FROM parley_bets;
      DROP TABLE parley_bets;
      ALTER TABLE parley_bets_new RENAME TO parley_bets;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS duo_pairs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      puuid1   TEXT NOT NULL,
      puuid2   TEXT NOT NULL,
      wins     INTEGER NOT NULL DEFAULT 0,
      losses   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(guild_id, puuid1, puuid2)
    );

    CREATE TABLE IF NOT EXISTS peak_records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id    TEXT NOT NULL,
      riot_tag    TEXT NOT NULL,
      season      TEXT NOT NULL,
      peak_tier   TEXT NOT NULL,
      peak_rank   TEXT NOT NULL,
      peak_lp     INTEGER NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(guild_id, riot_tag, season)
    );

    CREATE TABLE IF NOT EXISTS lp_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id    TEXT NOT NULL,
      puuid       TEXT NOT NULL,
      tier        TEXT NOT NULL,
      rank        TEXT NOT NULL,
      lp          INTEGER NOT NULL,
      match_id    TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lp_history_puuid ON lp_history(guild_id, puuid, id);

    -- "Predict next 10 wins" bets. Each row tracks one bettor's prediction for
    -- one tracked player; games_played counts up as the bot settles matches
    -- (any queue), and the bet settles when games_played reaches 10.
    CREATE TABLE IF NOT EXISTS predict10_bets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id        TEXT NOT NULL,
      discord_id      TEXT NOT NULL,
      target_puuid    TEXT NOT NULL,
      predicted_wins  INTEGER NOT NULL,
      amount          INTEGER NOT NULL,
      games_played    INTEGER NOT NULL DEFAULT 0,
      wins_so_far     INTEGER NOT NULL DEFAULT 0,
      state           TEXT NOT NULL DEFAULT 'open',
      payout          INTEGER,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_predict10_open ON predict10_bets(guild_id, target_puuid, state);
    CREATE INDEX IF NOT EXISTS idx_predict10_user ON predict10_bets(guild_id, discord_id, state);
  `);
}

// ── Query helpers ────────────────────────────────────────────────────────────

// Local-time YYYY-MM-DD so the daily W/L counter rolls over at midnight in the
// bot host's timezone (matches what players see as "today"), not UTC.
function localDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

export function markMatchCancelled(guildId, matchId) {
  db.prepare(`
    UPDATE active_matches SET state = 'cancelled', last_checked_at = datetime('now')
    WHERE guild_id = ? AND match_id = ?
  `).run(guildId, matchId);
}

export function touchMatch(id) {
  db.prepare("UPDATE active_matches SET last_checked_at = datetime('now') WHERE id = ?").run(id);
}

// Bets
export function placeBet(guildId, discordId, matchId, puuid, prediction, amount, houseConfidence = null) {
  return db.prepare(`
    INSERT INTO bets (guild_id, discord_id, match_id, puuid, prediction, amount, house_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, discordId, matchId, puuid, prediction, amount, houseConfidence);
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

export function cancelUnresolvedBets(guildId, matchId) {
  const bets = getUnresolvedBetsByMatch(guildId, matchId);
  const parlays = getUnresolvedParleyBetsByMatch(guildId, matchId);
  const refunded = [];
  for (const bet of bets) {
    db.prepare("UPDATE bets SET outcome = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(bet.id);
    db.prepare("UPDATE users SET coins = coins + ?, total_wagered = total_wagered - ?, updated_at = datetime('now') WHERE guild_id = ? AND discord_id = ?").run(bet.amount, bet.amount, guildId, bet.discord_id);
    refunded.push({ discordId: bet.discord_id, amount: bet.amount });
  }
  for (const pb of parlays) {
    db.prepare("UPDATE parley_bets SET outcome = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(pb.id);
    db.prepare("UPDATE users SET coins = coins + ?, total_wagered = total_wagered - ?, updated_at = datetime('now') WHERE guild_id = ? AND discord_id = ?").run(pb.amount, pb.amount, guildId, pb.discord_id);
    refunded.push({ discordId: pb.discord_id, amount: pb.amount });
  }
  return refunded;
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

// Parlay (per-match: all tracked players in the same game share one parlay)
// legs is an array of { stat, label, type, line } objects
export function setMatchParlay(guildId, matchId, legs) {
  db.prepare(`
    UPDATE active_matches SET parlay_legs = ?
    WHERE guild_id = ? AND match_id = ?
  `).run(JSON.stringify(legs), guildId, matchId);
}

// Returns the parsed legs array, or null if no parlay for this match
export function getMatchParlay(guildId, matchId) {
  const row = db.prepare(`
    SELECT parlay_legs FROM active_matches
    WHERE guild_id = ? AND match_id = ? AND parlay_legs IS NOT NULL
  `).get(guildId, matchId);
  if (!row?.parlay_legs) return null;
  return JSON.parse(row.parlay_legs);
}

// predictions is an array of 'over'/'under' strings (one per leg), stored as JSON
export function placeParleyBet(guildId, discordId, matchId, predictions, amount) {
  return db.prepare(`
    INSERT INTO parley_bets (guild_id, discord_id, match_id, predictions, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, discordId, matchId, JSON.stringify(predictions), amount);
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

// Message tracking (per-player: each tracked player in the same match has their own messages)
export function setMatchMessageId(guildId, puuid, matchId, messageId) {
  db.prepare('UPDATE active_matches SET message_id = ? WHERE guild_id = ? AND puuid = ? AND match_id = ?').run(messageId, guildId, puuid, matchId);
}

export function setMatchCloseMessageId(guildId, puuid, matchId, messageId) {
  db.prepare('UPDATE active_matches SET close_message_id = ? WHERE guild_id = ? AND puuid = ? AND match_id = ?').run(messageId, guildId, puuid, matchId);
}

export function getMatchMessages(guildId, puuid, matchId) {
  return db.prepare('SELECT message_id, close_message_id FROM active_matches WHERE guild_id = ? AND puuid = ? AND match_id = ?').get(guildId, puuid, matchId);
}

// Track the most recent Match Over message per tracked player so we can delete
// it when that player enters their next match.
export function setLastMatchOverMessage(guildId, puuid, messageId) {
  return db.prepare('UPDATE tracked_players SET last_match_over_message_id = ? WHERE guild_id = ? AND puuid = ?').run(messageId, guildId, puuid);
}

export function getLastMatchOverMessage(guildId, puuid) {
  const row = db.prepare('SELECT last_match_over_message_id FROM tracked_players WHERE guild_id = ? AND puuid = ?').get(guildId, puuid);
  return row?.last_match_over_message_id || null;
}

export function clearLastMatchOverMessage(guildId, puuid) {
  return db.prepare('UPDATE tracked_players SET last_match_over_message_id = NULL WHERE guild_id = ? AND puuid = ?').run(guildId, puuid);
}

export function clearLastMatchOverMessageByIds(guildId, messageIds) {
  if (!messageIds?.length) return { changes: 0 };
  const placeholders = messageIds.map(() => '?').join(',');
  return db.prepare(
    `UPDATE tracked_players SET last_match_over_message_id = NULL
     WHERE guild_id = ? AND last_match_over_message_id IN (${placeholders})`
  ).run(guildId, ...messageIds);
}

export function getActiveMatchByMessageId(guildId, messageId) {
  return db.prepare(`
    SELECT * FROM active_matches WHERE guild_id = ? AND message_id = ? AND state = 'active'
  `).get(guildId, messageId);
}

export function appendActiveMatchExtraMessage(guildId, puuid, matchId, messageId) {
  if (!messageId) return;
  const row = db.prepare('SELECT extra_message_ids FROM active_matches WHERE guild_id = ? AND puuid = ? AND match_id = ?').get(guildId, puuid, matchId);
  if (!row) return;
  const list = row.extra_message_ids ? JSON.parse(row.extra_message_ids) : [];
  list.push(messageId);
  return db.prepare('UPDATE active_matches SET extra_message_ids = ? WHERE guild_id = ? AND puuid = ? AND match_id = ?').run(JSON.stringify(list), guildId, puuid, matchId);
}

export function getActiveMatchExtraMessages(guildId, puuid, matchId) {
  const row = db.prepare('SELECT extra_message_ids FROM active_matches WHERE guild_id = ? AND puuid = ? AND match_id = ?').get(guildId, puuid, matchId);
  if (!row?.extra_message_ids) return [];
  try {
    return JSON.parse(row.extra_message_ids);
  } catch {
    return [];
  }
}

export function getActiveMatchMessageIds(guildId) {
  const rows = db.prepare(`
    SELECT message_id, close_message_id FROM active_matches
    WHERE guild_id = ? AND state = 'active'
  `).all(guildId);
  const ids = new Set();
  for (const r of rows) {
    if (r.message_id) ids.add(r.message_id);
    if (r.close_message_id) ids.add(r.close_message_id);
  }
  return ids;
}

// Daily win/loss tracking
export function recordDailyResult(guildId, puuid, won) {
  const today = localDateString();
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
  const today = localDateString();
  const player = db.prepare('SELECT daily_wins, daily_losses, daily_reset_date FROM tracked_players WHERE guild_id = ? AND puuid = ?').get(guildId, puuid);
  if (!player || player.daily_reset_date !== today) return { wins: 0, losses: 0 };
  return { wins: player.daily_wins, losses: player.daily_losses };
}

// Cumulative lane win/loss record (won lane = more gold than the role
// opponent at ~14 min). Reset per season via resetTrackedPlayerStats.
export function recordLaneResult(guildId, puuid, wonLane) {
  const col = wonLane ? 'lane_wins' : 'lane_losses';
  return db.prepare(`UPDATE tracked_players SET ${col} = ${col} + 1 WHERE guild_id = ? AND puuid = ?`).run(guildId, puuid);
}

export function getLaneRecord(guildId, puuid) {
  const r = db.prepare('SELECT lane_wins, lane_losses FROM tracked_players WHERE guild_id = ? AND puuid = ?').get(guildId, puuid);
  return { wins: r?.lane_wins || 0, losses: r?.lane_losses || 0 };
}

// Peak rank tracking
export function updatePeakRank(guildId, puuid, tier, rank, lp, rankValue) {
  const player = db.prepare('SELECT riot_tag, peak_tier, peak_rank, peak_lp FROM tracked_players WHERE guild_id = ? AND puuid = ?').get(guildId, puuid);
  if (!player) {
    peakLog.warn('updatePeakRank: no tracked_players row matched', { guildId, puuid });
    return;
  }
  const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
  const DIVISIONS = ['IV', 'III', 'II', 'I'];
  let peakValue = 0;
  if (player.peak_tier) {
    const ti = TIERS.indexOf(player.peak_tier);
    const di = DIVISIONS.indexOf(player.peak_rank || 'I');
    peakValue = (ti >= 7 ? ti * 4 : ti * 4 + di) * 100 + (player.peak_lp || 0);
  }
  const currentValue = (rankValue) * 100 + lp;
  peakLog.info('updatePeakRank: compare', {
    riotTag: player.riot_tag,
    stored: { tier: player.peak_tier, rank: player.peak_rank, lp: player.peak_lp, value: peakValue },
    incoming: { tier, rank, lp, rankValue, value: currentValue },
    willUpdate: currentValue > peakValue,
  });
  if (currentValue > peakValue) {
    const info = db.prepare('UPDATE tracked_players SET peak_tier = ?, peak_rank = ?, peak_lp = ? WHERE guild_id = ? AND puuid = ?').run(tier, rank, lp, guildId, puuid);
    peakLog.info('updatePeakRank: UPDATE executed', { riotTag: player.riot_tag, changes: info.changes });
  }
}

export function getPeakRanks(guildId) {
  return db.prepare('SELECT riot_tag, peak_tier, peak_rank, peak_lp FROM tracked_players WHERE guild_id = ?').all(guildId);
}

// LP history — insert a row whenever the player's solo/duo rank entry changes
// (tier/rank/lp). Returns the inserted row or null if a duplicate was skipped.
export function recordLp(guildId, puuid, tier, rank, lp, matchId = null) {
  const prev = db.prepare(`
    SELECT tier, rank, lp FROM lp_history
    WHERE guild_id = ? AND puuid = ? ORDER BY id DESC LIMIT 1
  `).get(guildId, puuid);
  if (prev && prev.tier === tier && prev.rank === rank && prev.lp === lp) {
    return null;
  }
  return db.prepare(`
    INSERT INTO lp_history (guild_id, puuid, tier, rank, lp, match_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, puuid, tier, rank, lp, matchId);
}

export function getLpHistory(guildId, puuid, limit = 250) {
  return db.prepare(`
    SELECT tier, rank, lp, match_id, recorded_at FROM lp_history
    WHERE guild_id = ? AND puuid = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(guildId, puuid, limit);
}

// Peak records (frozen historical peaks per season)
export function addPeakRecord(guildId, riotTag, season, tier, rank, lp) {
  return db.prepare(`
    INSERT OR IGNORE INTO peak_records (guild_id, riot_tag, season, peak_tier, peak_rank, peak_lp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, riotTag, season, tier, rank, lp);
}

export function getPeakRecords(guildId, season = null) {
  if (season) {
    return db.prepare('SELECT * FROM peak_records WHERE guild_id = ? AND season = ?').all(guildId, season);
  }
  return db.prepare('SELECT * FROM peak_records WHERE guild_id = ? ORDER BY season DESC, recorded_at DESC').all(guildId);
}

export function getPeakRecordSeasons(guildId) {
  return db.prepare('SELECT DISTINCT season FROM peak_records WHERE guild_id = ? ORDER BY season DESC').all(guildId).map(r => r.season);
}

// Season reset helpers
export function resetTrackedPlayerStats(guildId) {
  return db.prepare(`
    UPDATE tracked_players
    SET peak_tier = NULL, peak_rank = NULL, peak_lp = NULL,
        daily_wins = 0, daily_losses = 0, daily_reset_date = NULL,
        lane_wins = 0, lane_losses = 0
    WHERE guild_id = ?
  `).run(guildId);
}

export function resetUserBettingStats(guildId) {
  return db.prepare(`
    UPDATE users
    SET correct = 0, incorrect = 0, total_wagered = 0, total_won = 0,
        current_streak = 0, best_streak = 0, updated_at = datetime('now')
    WHERE guild_id = ?
  `).run(guildId);
}

export function resetDuoPairs(guildId) {
  return db.prepare('UPDATE duo_pairs SET wins = 0, losses = 0 WHERE guild_id = ?').run(guildId);
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

// Cumulative net profit per resolved bet (main + parley), oldest → newest.
// Starts at 0 before the first bet. WIN correct: +0.5x amount, LOSE correct:
// +2x amount, parley correct: +(2^legs − 1)x amount, incorrect: −amount.
// Cancelled bets are ignored (refunded → net zero).
export function getProfitHistory(guildId, discordId, limit = 250) {
  const bets = db.prepare(`
    SELECT amount, prediction, outcome, resolved_at FROM bets
    WHERE guild_id = ? AND discord_id = ?
      AND outcome IN ('correct', 'incorrect')
      AND resolved_at IS NOT NULL
  `).all(guildId, discordId);

  const parlays = db.prepare(`
    SELECT amount, predictions, outcome, resolved_at FROM parley_bets
    WHERE guild_id = ? AND discord_id = ?
      AND outcome IN ('correct', 'incorrect')
      AND resolved_at IS NOT NULL
  `).all(guildId, discordId);

  const events = [];
  for (const b of bets) {
    let net;
    if (b.outcome === 'correct') {
      const mult = b.prediction === 'win' ? 1.5 : 3;
      net = Math.floor(b.amount * mult) - b.amount;
    } else {
      net = -b.amount;
    }
    events.push({ ts: b.resolved_at, net });
  }
  for (const p of parlays) {
    let net;
    if (p.outcome === 'correct') {
      let legs = 0;
      try { legs = JSON.parse(p.predictions).length || 0; } catch { /* malformed */ }
      const mult = Math.pow(2, legs);
      net = Math.floor(p.amount * mult) - p.amount;
    } else {
      net = -p.amount;
    }
    events.push({ ts: p.resolved_at, net });
  }

  events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const recent = events.slice(-limit);

  let cum = 0;
  const series = [0];
  for (const e of recent) {
    cum += e.net;
    series.push(cum);
  }
  return series;
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

// Duo pair tracking
export function recordDuoResult(guildId, puuidA, puuidB, won) {
  const [p1, p2] = puuidA < puuidB ? [puuidA, puuidB] : [puuidB, puuidA];
  const col = won ? 'wins' : 'losses';
  db.prepare(`
    INSERT INTO duo_pairs (guild_id, puuid1, puuid2, ${col})
    VALUES (?, ?, ?, 1)
    ON CONFLICT(guild_id, puuid1, puuid2) DO UPDATE SET ${col} = ${col} + 1
  `).run(guildId, p1, p2);
}

export function getDuoPairs(guildId) {
  return db.prepare(`
    SELECT d.*, tp1.riot_tag AS tag1, tp2.riot_tag AS tag2
    FROM duo_pairs d
    LEFT JOIN tracked_players tp1 ON d.guild_id = tp1.guild_id AND d.puuid1 = tp1.puuid
    LEFT JOIN tracked_players tp2 ON d.guild_id = tp2.guild_id AND d.puuid2 = tp2.puuid
    WHERE d.guild_id = ? AND (d.wins + d.losses) > 0
    ORDER BY (d.wins + d.losses) DESC
  `).all(guildId);
}

export function resetDuoPair(guildId, puuidA, puuidB) {
  const [p1, p2] = puuidA < puuidB ? [puuidA, puuidB] : [puuidB, puuidA];
  return db.prepare('UPDATE duo_pairs SET wins = 0, losses = 0 WHERE guild_id = ? AND puuid1 = ? AND puuid2 = ?').run(guildId, p1, p2);
}

// Nullable house_confidence column on bets — only set when "The House" places
// the bet, so we can surface its model confidence in the Match Over recap.
try { db.exec('ALTER TABLE bets ADD COLUMN house_confidence REAL'); } catch { /* exists */ }


// ── /predict10 helpers ────────────────────────────────────────────────────────

export function createPredict10(guildId, discordId, targetPuuid, predictedWins, amount) {
  return db.prepare(`
    INSERT INTO predict10_bets (guild_id, discord_id, target_puuid, predicted_wins, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, discordId, targetPuuid, predictedWins, amount);
}

export function getOpenPredict10ForPlayer(guildId, targetPuuid) {
  return db.prepare(`
    SELECT * FROM predict10_bets
    WHERE guild_id = ? AND target_puuid = ? AND state = 'open'
  `).all(guildId, targetPuuid);
}

export function getOpenPredict10ForUser(guildId, discordId) {
  return db.prepare(`
    SELECT * FROM predict10_bets
    WHERE guild_id = ? AND discord_id = ? AND state = 'open'
    ORDER BY id DESC
  `).all(guildId, discordId);
}

// Look up a user's open prediction on a specific player (used for "one open
// slot per user × player" enforcement).
export function getOpenPredict10ForUserAndPlayer(guildId, discordId, targetPuuid) {
  return db.prepare(`
    SELECT * FROM predict10_bets
    WHERE guild_id = ? AND discord_id = ? AND target_puuid = ? AND state = 'open'
  `).get(guildId, discordId, targetPuuid);
}

export function updatePredict10Progress(id, gamesPlayed, winsSoFar) {
  return db.prepare(`
    UPDATE predict10_bets SET games_played = ?, wins_so_far = ? WHERE id = ?
  `).run(gamesPlayed, winsSoFar, id);
}

export function settlePredict10(id, payout) {
  return db.prepare(`
    UPDATE predict10_bets
    SET state = 'settled', payout = ?, settled_at = datetime('now')
    WHERE id = ?
  `).run(payout, id);
}

// ── Init ─────────────────────────────────────────────────────────────────────

migrate();

export default db;
