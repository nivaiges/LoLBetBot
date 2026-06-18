# `/lpc` redesign — port the `/lp` visual language to multi-player comparison

Bring `/lpc` in line with the new `/lp` look: rank-label Y-axis ticks
(D4/D3/D2/D1 etc., then `MAS X` once you cross Master), tier-color zone tints
behind the plot, per-player tier-themed lines (not the rainbow palette),
dashed reference lines at tier thresholds, and a dropped Discord embed so the
PNG renders at full attachment width.

## Files & landmarks

- Command: [`src/commands/lpc.js`](src/commands/lpc.js)
- Renderer: [`renderLpComparePng` at `src/matchGraph.js:1515`](src/matchGraph.js#L1515)
- Reference (the look to copy): [`renderLpProfilePng` at `src/matchGraph.js:849`](src/matchGraph.js#L849)
- Apex cutoffs: [`getApexCutoffs` in `src/riot.js`](src/riot.js) (already cached 6h)
- Rate-limit helpers: `getRiotCooldown`, `riotRateLimitMessage` from `src/riot.js`
- Tier palette: `TIER_BAR_COLORS` in `src/matchGraph.js`
- Mini-crest + emblem: `getRankMiniCrest`, `getRankEmblem` in
  `src/utils/rankEmblems.js`
- Profile icons: `getProfileIcon` in `src/utils/profileIcons.js`
- LP math: `toAbsoluteLP`, `MASTER_PLUS` in `src/utils/rankMath.js`

## What `/lp` does that `/lpc` should mirror

1. **Plot absolute LP** (continuous across promotions). Reuse
   `toAbsoluteLP(tier, rank, lp)` per entry.
2. **Y-axis tick labels** built from a `labelFor(v)` helper. Below 2800 →
   `${SUB_TIER_SHORT[Math.floor(v/400)]}${4 - Math.floor((v % 400)/100)}`
   (e.g. `D4`, `D3`, `E1`). At/above 2800 → `MAS`, `MAS 200`, `MAS 400`, …
   See lines around `src/matchGraph.js:1232–1260` for the exact snippet.
3. **Tick step**: `100` LP when range is small (single tier), `200` when
   range ≥ 800. Same as the `niceStep` selection at
   `src/matchGraph.js:1308`.
4. **Tier-zone bands**: loop `ti = 0..6`, fill `[ti*400, (ti+1)*400]` with
   `hexWithAlpha(TIER_BAR_COLORS[TIERS_ALL[ti]], 0.10)`. Master+ band
   (2800+) splits at the apex cutoff if known. Snippet at
   `src/matchGraph.js:1268–1305`.
5. **Dashed reference lines** at 2800 (Master threshold) and at
   `apexCutoffAbs = 2800 + cutoffs.gm` / `cutoffs.chl` if applicable.
   Lines around `src/matchGraph.js:1325–1346`.
6. **Drop the embed**: send `{ files: [...] }` only (no `EmbedBuilder`,
   no `setImage`). Discord renders the attachment at full native width
   (~720px on desktop) instead of the embed's ~400–550 cap.
7. **Tier-themed line color per player**: replace `compareColor(i)` with
   `TIER_BAR_COLORS[entries[entries.length - 1].tier]`. Two players in the
   same tier will share a color → desaturate or vary lightness by index so
   they're still distinguishable (`darken(color, i)` helper, or fall back
   to a small dotted-vs-solid stroke pattern).
8. **End-of-line callout per player**: small pill with `${SHORT_TIER}${div} ${rawLp}`
   anchored at the last point — see `renderLpProfilePng`
   `src/matchGraph.js:1455–1475` for the exact rendering pattern.
9. **Header band**: drop the embed legend; bake the legend into the PNG.
   A row of player chips (profile icon + name + current rank pill) at the
   top, in the same dark navy card style as `/lp` uses for stat tiles.
   See the player-tile pattern at `src/matchGraph.js:1095–1167`.
10. **Rate-limit pre-flight**: `if (getRiotCooldown().cooling) return reply(riotRateLimitMessage())`
    before deferring. Then `await getApexCutoffs(region)` for each unique
    Master+ region in the player list (de-dup regions first).

## Diffable checklist

- [ ] Strip embed + legend description from `/lpc`; ship raw PNG only.
- [ ] Pre-fetch `summoner` + `rankedStats` per player so the header chips
      can show profile icon + current rank. Use `Promise.all`.
- [ ] Pre-fetch apex `cutoffs` per unique Master+ region.
- [ ] Pass everything to `renderLpComparePng(opts)` instead of the
      current `(players, opts)` shape — match `/lp`'s opts object.
- [ ] In renderer: swap `series.lp` plotting back to absolute LP via
      `toAbsoluteLP`. Reuse the exact `labelFor`, band loop, dashed-line,
      and callout code from `renderLpProfilePng`.
- [ ] Color lines using `TIER_BAR_COLORS[lastEntry.tier]` with a
      lightness offset per duplicate-tier player.
- [ ] Bake a per-player legend header card at the top (replaces the
      Discord embed legend).
- [ ] Update `/lpc.js` to use `riotRateLimitMessage()` and `getRiotCooldown()`.
- [ ] Verify with: (a) 2 Master players, (b) Master + Diamond mix,
      (c) 4 sub-master players, (d) one player with cross-tier history.

## Helpers to copy verbatim from `renderLpProfilePng`

These are already self-contained and tier-agnostic — just lift them into
the compare renderer's scope:

- `SUB_TIER_SHORT` constant
- `labelFor(v)` closure
- tier-band loop (`for (let ti = 0; ti < 7; ti++) { ... }`)
- apex-cutoff resolution (`apexCutoffAbs`, `apexNextTier`)
- dashed `dashedLines[]` loop
- end-of-line callout block (around `lastEntry`, `calloutText`)

## Notes / gotchas

- `compareColor` and `COLOR_DOTS` in `/lpc.js` become dead code once
  lines are tier-colored — delete them.
- The existing `renderLpComparePng` accepts `(players, opts)` positional.
  Either keep the signature and add fields onto `opts`, or refactor to
  `(opts)` for parity with `renderLpProfilePng`. Either works; pick one.
- For the header card, summoner-level badges aren't needed (would be too
  busy with 4+ players). Skip the level badge; keep just icon + name +
  rank pill.
- Apex cutoffs: only fetch for unique regions with at least one Master+
  player in the comparison. Avoid the 2 MB Master ladder call when nobody
  needs it.
- Sanity-check the `darken(color, i)` lightness shift on the Iron/Bronze
  palette — they're already low-saturation and may need a different
  same-tier disambiguation (e.g. dotted line) if multiple Iron players
  are compared. Unlikely edge case.
