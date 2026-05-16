import db, {
  addPeakRecord,
  resetTrackedPlayerStats,
  resetUserBettingStats,
  resetDuoPairs,
} from './src/db.js';

const season = process.argv[2];
if (!season) {
  console.error('Usage: node season-reset.js "<season label>"');
  console.error('Example: node season-reset.js "2025 Split 3"');
  process.exit(1);
}

const tx = db.transaction((seasonLabel) => {
  const players = db.prepare(`
    SELECT guild_id, riot_tag, peak_tier, peak_rank, peak_lp
    FROM tracked_players
    WHERE peak_tier IS NOT NULL
  `).all();

  let snapshotted = 0;
  const guilds = new Set();
  for (const p of players) {
    const result = addPeakRecord(p.guild_id, p.riot_tag, seasonLabel, p.peak_tier, p.peak_rank, p.peak_lp);
    if (result.changes > 0) snapshotted++;
    guilds.add(p.guild_id);
  }
  console.log(`Snapshotted ${snapshotted}/${players.length} peaks across ${guilds.size} guild(s) into season "${seasonLabel}"`);

  const guildIds = db.prepare('SELECT DISTINCT guild_id FROM tracked_players').all().map(r => r.guild_id);
  const allGuilds = new Set([...guildIds, ...guilds]);
  for (const guildId of allGuilds) {
    resetTrackedPlayerStats(guildId);
    resetUserBettingStats(guildId);
    resetDuoPairs(guildId);
  }
  console.log(`Reset stats for ${allGuilds.size} guild(s): tracked-player peaks, daily W/L, user betting stats, duo pairs`);
});

tx(season);
console.log('Done.');
db.close();
