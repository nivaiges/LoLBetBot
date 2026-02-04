/**
 * Riot API uses two routing concepts:
 *
 * 1. Platform routing (region-specific): na1, euw1, kr, etc.
 *    Used for: Spectator-V5, League-V4
 *    URL pattern: https://{platform}.api.riotgames.com
 *
 * 2. Regional routing (continent-level): americas, europe, asia, sea
 *    Used for: Account-V1, Match-V5
 *    URL pattern: https://{regional}.api.riotgames.com
 *
 * When a player is on NA1, their match data lives on the AMERICAS regional endpoint.
 */

const PLATFORM_TO_REGIONAL = {
  na1: 'americas',
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  euw1: 'europe',
  eun1: 'europe',
  tr1: 'europe',
  ru: 'europe',
  kr: 'asia',
  jp1: 'asia',
  oc1: 'sea',
  ph2: 'sea',
  sg2: 'sea',
  th2: 'sea',
  tw2: 'sea',
  vn2: 'sea',
};

const config = {
  // Currency
  collectAmount: 10_000,
  collectCooldownMs: 2 * 60 * 60 * 1000, // 2 hours

  // Polling
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),

  // Rate limiting (per-user command cooldown)
  commandCooldownMs: 5_000,

  // Riot API
  riotRegion: (process.env.RIOT_REGION || 'na1').toLowerCase(),

  getRegionalRoute(platform) {
    return PLATFORM_TO_REGIONAL[platform] || 'americas';
  },

  platformUrl(platform) {
    return `https://${platform}.api.riotgames.com`;
  },

  regionalUrl(platform) {
    const regional = this.getRegionalRoute(platform);
    return `https://${regional}.api.riotgames.com`;
  },

  // Betting window (time after match detection to allow bets)
  bettingWindowMs: 5 * 60 * 1000, // 5 minutes

  // Bet payout multipliers
  payoutMultiplier: 1.5,       // WIN bets pay 1.5x
  losePayoutMultiplier: 3,     // LOSE bets pay 3x

  // Parley (over/under stat bets)
  parleyChance: 0.175,        // 17.5% of matches get a parley
  parleyPayoutMultiplier: 2,

  // Custom rank emoji — upload rank icons to your server, then paste emoji IDs here.
  // To get an ID: type \:iron: in Discord and send — it shows <:iron:123456789>.
  // Format: '<:name:ID>' — leave empty string to skip that tier.
  rankEmoji: {
    IRON: '<:Iron:1466911638165917787>',
    BRONZE: '<:Bronze:1466911611913506929>',
    SILVER: '<:Silver:1466911584679887089>',
    GOLD: '<:Gold:1466911558386061558>',
    PLATINUM: '<:Platinum:1466911533727617128>',
    EMERALD: '',
    DIAMOND: '<:Diamond:1466911477435859250>',
    MASTER: '<:Master:1466911447715155989>',
    GRANDMASTER: '<:Grandmaster:1466911417759436865>',
    CHALLENGER: '<:Challenger:1466911383810740347>',
  },

  getRankEmoji(tier) {
    return this.rankEmoji[tier] || '';
  },
};

export default config;
export { PLATFORM_TO_REGIONAL };
