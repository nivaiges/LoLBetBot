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
  collectCooldownMs: 24 * 60 * 60 * 1000, // 24 hours

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
  bettingWindowMs: 3 * 60 * 1000, // 3 minutes

  // Bet payout multiplier
  payoutMultiplier: 1.5,

  // Parley (over/under stat bets)
  parleyChance: 0.1,          // 10% of matches get a parley
  parleyPayoutMultiplier: 2,
};

export default config;
export { PLATFORM_TO_REGIONAL };
