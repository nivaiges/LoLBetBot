// Discord renders ANSI escape codes inside ```ansi``` code blocks. Only an
// ~8-color palette is supported (no arbitrary hex). Mapping each LoL tier to
// the closest distinct ANSI code; bold (1;) is used to spread overlapping hues.
const ESC = '\x1b';

const TIER_TO_ANSI = {
  IRON:        `${ESC}[2;30m`, // dim gray
  BRONZE:      `${ESC}[0;33m`, // yellow (bronze ≈ dim gold in palette)
  SILVER:      `${ESC}[0;37m`, // white
  GOLD:        `${ESC}[1;33m`, // bold yellow
  PLATINUM:    `${ESC}[0;36m`, // cyan
  EMERALD:     `${ESC}[1;32m`, // bold green
  DIAMOND:     `${ESC}[1;34m`, // bold blue
  MASTER:      `${ESC}[1;35m`, // bold pink/magenta
  GRANDMASTER: `${ESC}[1;31m`, // bold red
  CHALLENGER:  `${ESC}[1;33m`, // bold yellow (gold/yellow accent)
};

export const ANSI_RESET = `${ESC}[0m`;

export function tierAnsi(tier) {
  return TIER_TO_ANSI[tier] || `${ESC}[0;37m`;
}

export function colorize(tier, text) {
  return `${tierAnsi(tier)}${text}${ANSI_RESET}`;
}

export function ansiBlock(lines) {
  return '```ansi\n' + lines.join('\n') + '\n```';
}
