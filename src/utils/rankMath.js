// Convert a (tier, rank, lp) triple into a single integer "absolute LP" value
// so that promotions across divisions/tiers render as a continuous climb. Used
// for the LP graph and for rank-gap math in /rank.
//
// Scale:
//   IRON IV 0    → 0
//   IRON I 100   → 400
//   BRONZE IV 0  → 400  (continuous with previous)
//   DIAMOND I 100→ 2800
//   MASTER 0    → 2800  (Master+ share one continuous pool, no divisions)
//   GRANDMASTER 200 → 3000 (Master+200 LP)

export const TIERS_ASC = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
export const DIVISIONS = ['IV', 'III', 'II', 'I'];
export const MASTER_PLUS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

export function toAbsoluteLP(tier, rank, lp) {
  const ti = TIERS_ASC.indexOf(tier);
  if (ti < 0) return null;
  if (ti >= 7) return 2800 + (lp || 0);
  const di = Math.max(0, DIVISIONS.indexOf(rank));
  return ti * 400 + di * 100 + (lp || 0);
}

// Short rank label like "DIA II 50" or "MASTER 245" (M+ has no division).
export function rankLabel(tier, rank, lp) {
  const short = {
    IRON: 'IRON', BRONZE: 'BRZ', SILVER: 'SIL', GOLD: 'GOLD',
    PLATINUM: 'PLAT', EMERALD: 'EM', DIAMOND: 'DIA',
    MASTER: 'MAS', GRANDMASTER: 'GM', CHALLENGER: 'CHL',
  }[tier] || tier;
  if (MASTER_PLUS.has(tier)) return `${short} ${lp}`;
  return `${short} ${rank} ${lp}`;
}
