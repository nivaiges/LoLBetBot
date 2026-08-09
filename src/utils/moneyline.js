// Converts a decimal-odds multiplier (total return per unit stake, e.g. 1.36
// or 3.17) into American-style moneyline odds.
//
// The math:
//   d >= 2.0  → underdog side, American = +(d - 1) × 100      (profit on 100 stake)
//   d <  2.0  → favorite side, American = -100 / (d - 1)      (stake to win 100)
//   d == 2.0  → even money → +100
//
// Example: 1.36 → -278, 3.17 → +217, 1.90 → -111, 2.00 → +100.
export function toAmericanOdds(decimalMult) {
  if (!Number.isFinite(decimalMult) || decimalMult <= 1) return 0;
  if (decimalMult >= 2) {
    return Math.round((decimalMult - 1) * 100);
  }
  return -Math.round(100 / (decimalMult - 1));
}

// Formatted string with the leading sign: "-278" / "+217" / "+100".
export function formatAmericanOdds(decimalMult) {
  const n = toAmericanOdds(decimalMult);
  return n > 0 ? `+${n}` : `${n}`;
}
