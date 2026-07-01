import { createCanvas, loadImage } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './utils/logger.js';
import { toAbsoluteLP, rankLabel } from './utils/rankMath.js';
import { displayName } from './utils/displayName.js';
import { getChampionIcon } from './utils/championIcons.js';
import { getProfileIcon } from './utils/profileIcons.js';
import { getRankEmblem, getRankMiniCrest } from './utils/rankEmblems.js';
import { getLaneIcon } from './utils/laneIcons.js';
import { getChampionSplash } from './utils/championSplash.js';
import { getItemIcon } from './utils/itemIcons.js';
import { getSummonerSpellIcon, getRuneIcon, getRuneStyleIcon } from './utils/runeIcons.js';

// Asset-loader for objective icons. Drop PNGs (≈18×18) in assets/objectives/
// named after the kind in lowercase (baron.png, herald.png, grubs.png,
// dragon.png, soul.png) and they'll automatically replace the lettered pin.
const ASSET_DIR = path.resolve('assets', 'objectives');
const objectiveIconCache = new Map();   // kind → Image | false (false = checked, not present)

async function loadIcon(filename) {
  if (objectiveIconCache.has(filename)) {
    const cached = objectiveIconCache.get(filename);
    return cached === false ? null : cached;
  }
  const file = path.join(ASSET_DIR, filename);
  if (!existsSync(file)) {
    objectiveIconCache.set(filename, false);
    return null;
  }
  try {
    const img = await loadImage(file);
    objectiveIconCache.set(filename, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, filename }, 'matchGraph: failed to load objective icon');
    objectiveIconCache.set(filename, false);
    return null;
  }
}

async function getObjectiveIcon(kind) {
  // 1. Try the specific filename (e.g. dragon_ocean.png, soul.png, baron.png)
  const specific = await loadIcon(`${kind.toLowerCase()}.png`);
  if (specific) return specific;
  // 2. Generic dragon fallback if it's a dragon variant we don't have art for
  if (kind.startsWith('DRAGON')) {
    const generic = await loadIcon('dragon.png');
    if (generic) return generic;
  }
  return null;
}

// Build a per-minute team-gold-lead series from a Match-V5 timeline + result.
// Returns an array of integers — one per frame, where index = minute.
// Positive = tracked player's team is ahead; negative = behind.
export function computeTeamGoldLead(timeline, matchResult, trackedPuuid) {
  if (!timeline?.info?.frames || !matchResult?.info?.participants) return null;

  const puuidToTeam = new Map();
  for (const p of matchResult.info.participants) {
    puuidToTeam.set(p.puuid, p.teamId);
  }

  const tracked = matchResult.info.participants.find(p => p.puuid === trackedPuuid);
  if (!tracked) return null;
  const trackedTeamId = tracked.teamId;

  const idToTeam = new Map();
  for (const p of timeline.info.participants || []) {
    const team = puuidToTeam.get(p.puuid);
    if (team != null) idToTeam.set(p.participantId, team);
  }

  const lead = [];
  for (const frame of timeline.info.frames) {
    let allyGold = 0;
    let enemyGold = 0;
    for (const [pid, pframe] of Object.entries(frame.participantFrames || {})) {
      const team = idToTeam.get(parseInt(pid, 10));
      if (team == null) continue;
      const g = pframe.totalGold || 0;
      if (team === trackedTeamId) allyGold += g;
      else enemyGold += g;
    }
    lead.push(allyGold - enemyGold);
  }
  return lead;
}

// Pull Baron / Rift Herald / Void Grub kills out of the timeline events.
// Returns [{ kind: 'BARON'|'HERALD'|'GRUBS', minute, byAlly }]. Dragons,
// Atakhan, and turrets are intentionally skipped. Grubs killed in the same
// minute are de-duped to one marker.
export function extractObjectiveEvents(timeline, matchResult, trackedPuuid) {
  if (!timeline?.info?.frames) return [];

  const tracked = matchResult?.info?.participants?.find(p => p.puuid === trackedPuuid);
  const trackedTeamId = tracked?.teamId ?? null;

  const puuidToTeam = new Map();
  for (const p of matchResult?.info?.participants || []) puuidToTeam.set(p.puuid, p.teamId);
  const idToTeam = new Map();
  for (const p of timeline.info.participants || []) {
    const t = puuidToTeam.get(p.puuid);
    if (t != null) idToTeam.set(p.participantId, t);
  }

  const TYPE_MAP = {
    BARON_NASHOR: 'BARON',
    RIFTHERALD: 'HERALD',
    HORDE: 'GRUBS',
    DRAGON: 'DRAGON',
  };
  // Riot's monsterSubType (V5 timeline) → our specific dragon kind so the
  // renderer can pick the element-specific icon. Elder dragons (spawn after
  // any team has Soul) get their own kind too.
  const DRAGON_SUBTYPE = {
    WATER_DRAGON:    'DRAGON_OCEAN',
    EARTH_DRAGON:    'DRAGON_MOUNTAIN',
    AIR_DRAGON:      'DRAGON_CLOUD',
    FIRE_DRAGON:     'DRAGON_INFERNAL',
    HEXTECH_DRAGON:  'DRAGON_HEXTECH',
    CHEMTECH_DRAGON: 'DRAGON_CHEMTECH',
    ELDER_DRAGON:    'DRAGON_ELDER',
  };
  const seen = new Set();
  const dragonCounts = new Map(); // teamId → count of elemental dragons killed
  const out = [];

  for (const frame of timeline.info.frames) {
    for (const ev of frame.events || []) {
      if (ev.type !== 'ELITE_MONSTER_KILL') continue;
      let kind = TYPE_MAP[ev.monsterType];
      if (!kind) continue;

      // Promote to element-specific kind for dragons
      if (kind === 'DRAGON' && ev.monsterSubType && DRAGON_SUBTYPE[ev.monsterSubType]) {
        kind = DRAGON_SUBTYPE[ev.monsterSubType];
      }

      const minute = Math.round((ev.timestamp || 0) / 60000);
      let team = ev.killerTeamId;
      if (team == null && ev.killerId != null) team = idToTeam.get(ev.killerId);

      // The 4th *elemental* dragon a team takes = Dragon Soul granted.
      // Elder dragons (post-soul) don't count toward the soul threshold.
      const isElder = kind === 'DRAGON_ELDER';
      if (kind.startsWith('DRAGON') && !isElder && team != null) {
        const next = (dragonCounts.get(team) || 0) + 1;
        dragonCounts.set(team, next);
        if (next === 4) kind = 'SOUL';
      }

      const key = `${kind}:${minute}:${team ?? '?'}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ kind, minute, byAlly: trackedTeamId != null && team === trackedTeamId });
    }
  }
  return out;
}

// Pull CHAMPION_KILL events made by the tracked player and group consecutive
// kills within 10s (League's multikill window) into one marker with a count.
// Returns [{ minute, count }] — count = 1 for solo, 2+ for multikills.
export function extractTrackedPlayerKills(timeline, trackedPuuid) {
  if (!timeline?.info?.frames) return [];
  const tracked = (timeline.info.participants || []).find(p => p.puuid === trackedPuuid);
  if (!tracked) return [];
  const trackedId = tracked.participantId;

  const raw = [];
  for (const frame of timeline.info.frames) {
    for (const ev of frame.events || []) {
      if (ev.type === 'CHAMPION_KILL' && ev.killerId === trackedId) {
        raw.push(ev.timestamp || 0);
      }
    }
  }
  raw.sort((a, b) => a - b);

  const MULTIKILL_WINDOW_MS = 10000;
  const groups = [];
  let cur = null;
  for (const ts of raw) {
    if (!cur || ts - cur.last > MULTIKILL_WINDOW_MS) {
      if (cur) groups.push(cur);
      cur = { first: ts, last: ts, count: 1 };
    } else {
      cur.last = ts;
      cur.count += 1;
    }
  }
  if (cur) groups.push(cur);

  // Mark at the time of the killing blow that completed the multikill so the
  // X lands on the spike, not on the first kill of a long fight.
  return groups.map(g => ({ minute: g.last / 60000, count: g.count }));
}

// Did the tracked player win their lane? Compares gold at ~14:00 against the
// enemy in the same teamPosition. Returns true/false, or null if it can't be
// determined (no role data, no role opponent, missing frames).
export function computeWonLane(timeline, matchResult, trackedPuuid) {
  if (!timeline?.info?.frames || !matchResult?.info?.participants) return null;

  const tracked = matchResult.info.participants.find(p => p.puuid === trackedPuuid);
  if (!tracked || !tracked.teamPosition) return null;

  const opp = matchResult.info.participants.find(
    p => p.teamId !== tracked.teamId && p.teamPosition === tracked.teamPosition
  );
  if (!opp) return null;

  const puuidToId = new Map();
  for (const p of timeline.info.participants || []) puuidToId.set(p.puuid, p.participantId);
  const trackedId = puuidToId.get(trackedPuuid);
  const oppId = puuidToId.get(opp.puuid);
  if (trackedId == null || oppId == null) return null;

  const frames = timeline.info.frames;
  const frame = frames[Math.min(14, frames.length - 1)];
  if (!frame?.participantFrames) return null;

  const tg = frame.participantFrames[String(trackedId)]?.totalGold;
  const og = frame.participantFrames[String(oppId)]?.totalGold;
  if (tg == null || og == null) return null;

  // { won, diff }: diff is the tracked player's gold lead over their lane
  // opponent at ~14 min (negative when behind).
  return { won: tg > og, diff: tg - og };
}

const BLUE = '#5DADE2';
const RED  = '#e74c3c';
const GREEN = '#2ecc71';
const BLUE_FILL = 'rgba(93,173,226,0.25)';
const RED_FILL  = 'rgba(231,76,60,0.25)';
const BG    = '#2f3136';
const GRID  = 'rgba(255,255,255,0.06)';
const AXIS  = '#aab';
const TITLE = '#fff';

// Absolute-LP zones for the LP graph background bands (see rankMath.js scale).
// Master+ is open-ended (one continuous pool above Diamond I).
const TIER_BANDS = [
  { name: 'Iron',     min: 0,    max: 400,    color: 'rgba(120,110,100,0.13)' },
  { name: 'Bronze',   min: 400,  max: 800,    color: 'rgba(205,127,50,0.13)' },
  { name: 'Silver',   min: 800,  max: 1200,   color: 'rgba(170,170,180,0.13)' },
  { name: 'Gold',     min: 1200, max: 1600,   color: 'rgba(241,196,15,0.13)' },
  { name: 'Platinum', min: 1600, max: 2000,   color: 'rgba(78,215,200,0.13)' },
  { name: 'Emerald',  min: 2000, max: 2400,   color: 'rgba(46,204,113,0.13)' },
  { name: 'Diamond',  min: 2400, max: 2800,   color: 'rgba(93,173,226,0.13)' },
  { name: 'Master+',  min: 2800, max: 100000, color: 'rgba(155,89,182,0.15)' },
];

// Discord uses gg sans / Whitney; fall back through Segoe UI (Windows) and the
// generic stack so the chart renders in something close on any host. The
// "Emoji" fonts are included so badge characters (👑 🥀) get a color glyph
// when the host has Segoe UI Emoji or Noto Color Emoji installed.
const FONT_STACK = '"gg sans", "Whitney", "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", "Helvetica Neue", Helvetica, Arial, sans-serif';

// Render a signed-line chart (line + zero-baseline area fill, blue ≥ 0 / red < 0)
// as a PNG Buffer. Used by both the team-gold-lead chart and the profit chart.
async function renderSignedLineChart(series, opts = {}) {
  if (!series || series.length === 0) return null;
  const {
    title = '',
    yAxisLabel = '',
    peakSuffix = '',  // appended after the index in callouts, e.g. 'm' for minute
    objectives = [],  // [{ kind: 'BARON'|'HERALD'|'GRUBS', minute, byAlly }]
    kills = [],       // [{ minute }] for the tracked player's kills
    bg = BG,          // override panel background (defaults to legacy chart grey)
  } = opts;

  try {
    const SCALE = 2; // supersample for a crisp chart (esp. when embedded/scaled)
    const W = 520;
    const H = 200;
    const padL = 52;
    const padR = 14;
    const padT = 28;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE); // draw in logical units; output is 2×

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    if (title) {
      ctx.fillStyle = TITLE;
      ctx.font = `bold 17px ${FONT_STACK}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(title, padL, 6);
    }

    // Y range — pad to nice 1k bounds, always include 0.
    const minVal = Math.min(0, ...series);
    const maxVal = Math.max(0, ...series);
    const yMin = Math.floor(minVal / 1000) * 1000;
    const yMax = Math.ceil(maxVal / 1000) * 1000;
    const yRange = yMax - yMin || 1;

    const desiredTicks = 5;
    const rawStep = yRange / desiredTicks;
    const niceStep = niceStepFor(rawStep);

    const yPx = v => padT + plotH * (yMax - v) / yRange;
    const xPx = i => padL + (series.length === 1 ? plotW / 2 : plotW * i / (series.length - 1));
    const y0 = yPx(0);

    // Horizontal grid + y-axis labels
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = AXIS;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / niceStep) * niceStep; v <= yMax; v += niceStep) {
      const py = yPx(v);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(W - padR, py);
      ctx.stroke();
      ctx.fillText(formatK(v), padL - 6, py);
    }

    // Per-segment fills (split at zero crossings)
    for (let i = 0; i < series.length - 1; i++) {
      const ya = series[i];
      const yb = series[i + 1];
      const xa = xPx(i);
      const xb = xPx(i + 1);
      const yaPx = yPx(ya);
      const ybPx = yPx(yb);

      const sameSign = (ya >= 0 && yb >= 0) || (ya <= 0 && yb <= 0);
      if (sameSign) {
        ctx.fillStyle = (ya >= 0 && yb >= 0) ? BLUE_FILL : RED_FILL;
        ctx.beginPath();
        ctx.moveTo(xa, yaPx);
        ctx.lineTo(xb, ybPx);
        ctx.lineTo(xb, y0);
        ctx.lineTo(xa, y0);
        ctx.closePath();
        ctx.fill();
      } else {
        const t = (0 - ya) / (yb - ya);
        const xc = xa + t * (xb - xa);

        ctx.fillStyle = ya >= 0 ? BLUE_FILL : RED_FILL;
        ctx.beginPath();
        ctx.moveTo(xa, yaPx);
        ctx.lineTo(xc, y0);
        ctx.lineTo(xa, y0);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = yb >= 0 ? BLUE_FILL : RED_FILL;
        ctx.beginPath();
        ctx.moveTo(xc, y0);
        ctx.lineTo(xb, ybPx);
        ctx.lineTo(xb, y0);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Line segments — color by endpoint sign
    ctx.lineWidth = 2;
    for (let i = 0; i < series.length - 1; i++) {
      ctx.strokeStyle = series[i + 1] < 0 ? RED : BLUE;
      ctx.beginPath();
      ctx.moveTo(xPx(i), yPx(series[i]));
      ctx.lineTo(xPx(i + 1), yPx(series[i + 1]));
      ctx.stroke();
    }

    // Points — color by own y sign
    for (let i = 0; i < series.length; i++) {
      ctx.fillStyle = series[i] < 0 ? RED : BLUE;
      ctx.beginPath();
      ctx.arc(xPx(i), yPx(series[i]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Objective markers — faint dashed guide line + pin. Pin flips to the
    // bottom of the plot when the line is below y=0 at that minute, mirroring
    // the kill-X flip behavior so pins sit on the same side as the active fill.
    if (objectives.length) {
      const LABEL = { BARON: 'B', HERALD: 'H', GRUBS: 'G', DRAGON: 'D', SOUL: 'DS' };
      const iconSize = 16;
      const pinH = 14;
      const pinTopY = padT - 6;
      const pinBotY = H - padB - 10;

      for (const obj of objectives) {
        const idx = Math.max(0, Math.min(series.length - 1, obj.minute));
        const x = xPx(idx);
        const color = obj.byAlly ? BLUE : RED;

        // Interpolate lead at this objective's minute and place pin on the
        // same vertical side as the line (bottom when behind, top when ahead).
        const lo = Math.floor(idx);
        const hi = Math.min(lo + 1, series.length - 1);
        const t = idx - lo;
        const leadAtObj = series[lo] * (1 - t) + series[hi] * t;
        const flipped = leadAtObj < 0;
        const pinY = flipped ? pinBotY : pinTopY;

        const icon = await getObjectiveIcon(obj.kind);
        const halfPin = icon ? iconSize / 2 + 1 : pinH / 2;
        const guideStartY = flipped ? pinY - halfPin : pinY + halfPin;
        const guideEndY = flipped ? padT : H - padB;

        // Guide line — pin to opposite plot edge
        ctx.strokeStyle = obj.byAlly ? 'rgba(93,173,226,0.30)' : 'rgba(231,76,60,0.30)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, guideStartY);
        ctx.lineTo(x, guideEndY);
        ctx.stroke();
        ctx.setLineDash([]);

        if (icon) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, pinY, iconSize / 2 + 1, 0, Math.PI * 2);
          ctx.fill();
          ctx.drawImage(icon, x - iconSize / 2, pinY - iconSize / 2, iconSize, iconSize);
        } else {
          // Dragon variants (DRAGON_OCEAN etc.) all fall back to 'D' label
          const label = LABEL[obj.kind] || (obj.kind.startsWith('DRAGON') ? 'D' : '?');
          ctx.font = `bold 9px ${FONT_STACK}`;
          const tw = ctx.measureText(label).width;
          const w = Math.max(pinH, tw + 8);
          ctx.fillStyle = color;
          roundRect(ctx, x - w / 2, pinY - pinH / 2, w, pinH, pinH / 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, x, pinY + 0.5);
        }
      }
    }

    // Tracked-player kill markers — N adjacent X's (one per kill in the
    // multikill cluster) along the bottom row of the plot. Color escalates
    // with the tier (yellow → orange → red → purple → hot pink for penta).
    if (kills.length) {
      const MULTIKILL_COLOR = {
        1: '#f1c40f', // single  — yellow
        2: '#e67e22', // double  — orange
        3: '#e74c3c', // triple  — red
        4: '#9b59b6', // quadra  — purple
        5: '#e91e63', // penta   — hot pink
      };
      const killYBase = y0; // anchor to the y=0 gold-lead baseline
      const r = 4;
      const spacing = 9; // X-center spacing — stacks into the active fill zone
      const last = series.length - 1;
      ctx.lineCap = 'round';
      for (const k of kills) {
        const i = Math.max(0, Math.min(last, k.minute));
        const x = xPx(i);
        const color = MULTIKILL_COLOR[Math.min(k.count, 5)] || '#f1c40f';

        // Lead at the kill moment determines stack direction so the X's
        // always point into the side of the chart where the line is.
        const lo = Math.floor(i);
        const hi = Math.min(lo + 1, last);
        const t = i - lo;
        const leadAtKill = series[lo] * (1 - t) + series[hi] * t;
        const dir = leadAtKill < 0 ? 1 : -1; // -1 = up (ahead), +1 = down (behind)

        for (let n = 0; n < k.count; n++) {
          const y = killYBase + n * spacing * dir;

          // Dark outline
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
          ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
          ctx.stroke();

          // Colored X
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
          ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
          ctx.stroke();
        }
      }
      ctx.lineCap = 'butt';
    }

    // X-axis tick labels (~7 max)
    ctx.fillStyle = AXIS;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStep = Math.max(1, Math.ceil((series.length - 1) / 7));
    let lastDrawn = -Infinity;
    for (let i = 0; i < series.length; i += xStep) {
      ctx.fillText(i.toString(), xPx(i), H - padB + 4);
      lastDrawn = i;
    }
    if (lastDrawn !== series.length - 1) {
      ctx.fillText((series.length - 1).toString(), xPx(series.length - 1), H - padB + 4);
    }

    // Y-axis label — rotated 90° on the left
    if (yAxisLabel) {
      ctx.save();
      ctx.translate(14, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TITLE; // white
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.fillText(yAxisLabel, 0, 0);
      ctx.restore();
    }

    // Peak annotations
    const maxVal2 = Math.max(...series);
    const minVal2 = Math.min(...series);

    if (maxVal2 > 0) {
      const idx = series.indexOf(maxVal2);
      const px = xPx(idx);
      const py = yPx(maxVal2);
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      drawCallout(ctx, px, py - 8, `+${formatK(maxVal2)} @ ${idx}${peakSuffix}`, BLUE, 'above', W, padR, H);
    }

    if (minVal2 < 0) {
      const idx = series.indexOf(minVal2);
      const px = xPx(idx);
      const py = yPx(minVal2);
      ctx.strokeStyle = RED;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      drawCallout(ctx, px, py + 8, `${formatK(minVal2)} @ ${idx}${peakSuffix}`, RED, 'below', W, padR, H);
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: canvas render failed');
    return null;
  }
}

export function renderGoldLeadPng(lead, opts = {}) {
  return renderSignedLineChart(lead, {
    title: opts.title != null ? opts.title : 'Gold Graph',
    yAxisLabel: 'Team Gold Lead',
    peakSuffix: 'm',
    objectives: opts.objectives || [],
    kills: opts.kills || [],
    ...(opts.bg ? { bg: opts.bg } : {}),
  });
}

export function renderProfitPng(profit, opts = {}) {
  return renderSignedLineChart(profit, {
    title: opts.title || 'Net Profit',
    yAxisLabel: 'Profit',
    peakSuffix: '',
  });
}

function niceStepFor(raw) {
  // Round step up to a "nice" 1/2/5 × 10^n value
  const exp = Math.floor(Math.log10(Math.abs(raw)));
  const base = Math.pow(10, exp);
  const norm = raw / base;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function formatK(v) {
  if (v === 0) return '0';
  const k = v / 1000;
  if (Number.isInteger(k)) return `${k}k`;
  return `${k.toFixed(1)}k`;
}

// Pill-shaped callout: white text on a solid colored rounded rectangle.
// `anchor`: 'above' draws the pill so its bottom edge sits at y; 'below'
// draws so its top edge sits at y.
function drawCallout(ctx, x, y, text, color, anchor, W, padR, H) {
  ctx.font = `bold 11px ${FONT_STACK}`;
  const tw = ctx.measureText(text).width;
  const padX = 6;
  const boxW = tw + padX * 2;
  const boxH = 18;
  let boxX = Math.round(x - boxW / 2);
  // Clamp horizontally to canvas
  boxX = Math.max(2, Math.min(W - padR - boxW, boxX));
  let boxY = anchor === 'above' ? Math.round(y - boxH) : Math.round(y);
  // Clamp vertically so the pill never gets cut off by the canvas edge.
  if (typeof H === 'number') boxY = Math.max(2, Math.min(H - boxH - 2, boxY));

  // Pill background
  ctx.fillStyle = color;
  roundRect(ctx, boxX, boxY, boxW, boxH, 4);
  ctx.fill();

  // White text
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, boxX + boxW / 2, boxY + boxH / 2 + 0.5);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// LP graph — plots a series of (tier, rank, lp) entries as absolute LP over
// time. No zero-baseline since LP can't go negative; instead we anchor the
// line and fill area to the min observed value.
export async function renderLpPng(entries, opts = {}) {
  if (!entries || entries.length === 0) return null;
  const { title = 'LP History' } = opts;

  try {
    const W = 520;
    const H = 200;
    const padL = 56;
    const padR = 14;
    const padT = 28;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // Compute absolute LP and remember per-point context
    const series = entries.map(e => toAbsoluteLP(e.tier, e.rank, e.lp)).filter(v => v != null);
    if (series.length === 0) return null;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = TITLE;
    ctx.font = `bold 13px ${FONT_STACK}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(title, padL, 8);

    // Y range — pad above/below the data, then extend the bottom to include
    // at least half of the tier band below the player's current band. This
    // way a Master player sees the Diamond zone below them as a visible gap
    // (rather than the line bottoming out exactly at the Master threshold).
    const minVal = Math.min(...series);
    const maxVal = Math.max(...series);
    const span = Math.max(50, maxVal - minVal);
    const pad = Math.max(25, span * 0.1);
    let yMin = Math.max(0, Math.floor((minVal - pad) / 50) * 50);
    const yMax = Math.ceil((maxVal + pad) / 50) * 50;

    const playerBandIdx = TIER_BANDS.findIndex(b => minVal >= b.min && minVal < b.max);
    if (playerBandIdx > 0) {
      const bandBelow = TIER_BANDS[playerBandIdx - 1];
      const bandBelowSpan = bandBelow.max - bandBelow.min;
      // Show at least half of the band below for context.
      const targetMin = Math.max(0, bandBelow.min + Math.floor(bandBelowSpan / 2 / 50) * 50);
      yMin = Math.min(yMin, targetMin);
    }
    const yRange = yMax - yMin || 1;

    const niceStep = niceLpStep(yRange);

    const yPx = v => padT + plotH * (yMax - v) / yRange;
    const xPx = i => padL + (series.length === 1 ? plotW / 2 : plotW * i / (series.length - 1));

    // Tier bands — translucent zones behind the plot, faint label on the right
    for (const band of TIER_BANDS) {
      const lo = Math.max(band.min, yMin);
      const hi = Math.min(band.max, yMax);
      if (hi <= lo) continue;
      const yTop = yPx(hi);
      const yBot = yPx(lo);
      ctx.fillStyle = band.color;
      ctx.fillRect(padL, yTop, plotW, yBot - yTop);
      if (yBot - yTop > 14) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.font = `9px ${FONT_STACK}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(band.name, W - padR - 3, yTop + 2);
      }
    }

    // Tier boundary lines — dashed, more visible than the band edge alone.
    // Marks where promotion/demotion actually happens (e.g. 2800 = Master/Diamond).
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const band of TIER_BANDS) {
      if (band.min > yMin && band.min < yMax) {
        const py = yPx(band.min);
        ctx.beginPath();
        ctx.moveTo(padL, py);
        ctx.lineTo(W - padR, py);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // Grid + y ticks
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = AXIS;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / niceStep) * niceStep; v <= yMax; v += niceStep) {
      const py = yPx(v);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(W - padR, py);
      ctx.stroke();
      ctx.fillText(v.toString(), padL - 6, py);
    }

    // Fill area below the line down to yMin
    const yBase = yPx(yMin);
    ctx.fillStyle = BLUE_FILL;
    ctx.beginPath();
    ctx.moveTo(xPx(0), yPx(series[0]));
    for (let i = 1; i < series.length; i++) ctx.lineTo(xPx(i), yPx(series[i]));
    ctx.lineTo(xPx(series.length - 1), yBase);
    ctx.lineTo(xPx(0), yBase);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xPx(0), yPx(series[0]));
    for (let i = 1; i < series.length; i++) ctx.lineTo(xPx(i), yPx(series[i]));
    ctx.stroke();

    // Points — green if LP rose from the previous entry, red if it fell,
    // blue for the first point (no prior to compare against).
    for (let i = 0; i < series.length; i++) {
      if (i === 0) ctx.fillStyle = BLUE;
      else if (series[i] > series[i - 1]) ctx.fillStyle = GREEN;
      else if (series[i] < series[i - 1]) ctx.fillStyle = RED;
      else ctx.fillStyle = AXIS;
      ctx.beginPath();
      ctx.arc(xPx(i), yPx(series[i]), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // X-axis tick labels (game index 1..N)
    ctx.fillStyle = AXIS;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStep = Math.max(1, Math.ceil((series.length - 1) / 7));
    let lastDrawn = -Infinity;
    for (let i = 0; i < series.length; i += xStep) {
      ctx.fillText(i.toString(), xPx(i), H - padB + 4);
      lastDrawn = i;
    }
    if (lastDrawn !== series.length - 1) {
      ctx.fillText((series.length - 1).toString(), xPx(series.length - 1), H - padB + 4);
    }

    // Y-axis label rotated
    ctx.save();
    ctx.translate(14, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = AXIS;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.fillText('LP', 0, 0);
    ctx.restore();

    // Callouts: peak high + most recent
    const maxIdx = series.indexOf(Math.max(...series));
    const peak = entries[maxIdx];
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(xPx(maxIdx), yPx(series[maxIdx]), 4.5, 0, Math.PI * 2);
    ctx.stroke();
    drawCallout(ctx, xPx(maxIdx), yPx(series[maxIdx]) - 8, `${rankLabel(peak.tier, peak.rank, peak.lp)}`, BLUE, 'above', W, padR, H);

    // Current (last) label — only if different from peak
    if (maxIdx !== series.length - 1) {
      const last = entries[series.length - 1];
      drawCallout(ctx, xPx(series.length - 1), yPx(series[series.length - 1]) + 8, `now: ${rankLabel(last.tier, last.rank, last.lp)}`, AXIS, 'below', W, padR, H);
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: LP canvas render failed');
    return null;
  }
}

// Profile-style LP card — replaces the legacy /lp embed render. Layout:
//   1. Top header band: profile icon (with level badge) + RiotID + tier label
//      on the left, big rank emblem on the right.
//   2. Four stat tiles: Current LP, Peak LP, Win Rate donut, Games Tracked.
//   3. Segmented progress bar with "X LP to NEXT_TIER" annotation.
//   4. LP HISTORY line chart with tier-color line + green/red win-loss dots
//      + a dashed "starting LP" reference line.
//
// Everything is tinted with the player's current tier color, on top of a
// dark navy backdrop (matching the rest of our renders).
export async function renderLpProfilePng(opts = {}) {
  const {
    riotTag,                // e.g. "Nivy#NA1"
    summonerLevel = null,
    profileIconId = null,
    tier,                   // current tier (e.g. "MASTER")
    rank,                   // current division (null for Master+)
    lp,                     // current LP
    wins = 0,
    losses = 0,
    entries = [],           // lp_history rows (tier, rank, lp, recorded_at)
    cutoffs = null,         // { gm, chl } from getApexCutoffs(region)
    topChampionInternalId = null, // for the faded top-right header decoration
  } = opts;

  if (!entries.length) return null;

  try {
    const SCALE = 2;
    const W = 1100;
    const padX = 24;

    const tierColor = TIER_BAR_COLORS[tier] || '#5DADE2';

    // ── Compute series (absolute LP) + min/max ─────────────────────────────
    const series = entries
      .map(e => ({ abs: toAbsoluteLP(e.tier, e.rank, e.lp), tier: e.tier, rank: e.rank, lp: e.lp }))
      .filter(p => p.abs != null);
    if (!series.length) return null;

    const curAbs = toAbsoluteLP(tier, rank, lp) ?? series[series.length - 1].abs;
    const peakEntry = series.reduce((a, b) => (a.abs >= b.abs ? a : b));
    const peakLp = peakEntry.lp;
    const peakLabel = MASTER_PLUS_TIERS.has(peakEntry.tier)
      ? `${peakEntry.lp} LP`
      : `${peakEntry.tier[0]}${({ I: 1, II: 2, III: 3, IV: 4 })[peakEntry.rank] || ''}-${peakEntry.lp}`;

    // ── Layout heights ─────────────────────────────────────────────────────
    const headerH = 300;
    const statsH = 130;
    const progressH = 48;
    const chartH = 460;
    const gap = 14;
    const padBottom = 22;
    const H = headerH + gap + statsH + gap + progressH + gap + chartH + padBottom;

    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // ── Backdrop — dark navy gradient (consistent with other renders) ──────
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#11131a');
    bgGrad.addColorStop(1, '#070910');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // ── HEADER BAND ────────────────────────────────────────────────────────
    const headerY = 0;
    {
      const x = padX;
      const y = headerY + 14;
      const w = W - padX * 2;
      const h = headerH - 14;

      // Header card surface
      ctx.fillStyle = '#10141d';
      roundRect(ctx, x, y, w, h, 14);
      ctx.fill();

      // Top-champion splash in the top-right as a faded background — drawn
      // BEFORE the icon/text so they stay sharply on top. Falls back
      // silently when we don't have a champ ID or the splash fetch failed.
      if (topChampionInternalId) {
        try {
          const champSplash = await getChampionSplash(topChampionInternalId);
          if (champSplash) {
            ctx.save();
            // Clip to the card with rounded corners so the splash respects
            // the card's edge radius.
            ctx.beginPath();
            roundRect(ctx, x, y, w, h, 14);
            ctx.clip();

            // Cover-fit the splash to the full card, then bias the source
            // crop right so the champion's face lands on the right side.
            const splashAR = champSplash.width / champSplash.height;
            const cardAR = w / h;
            let sw, sh, sx2, sy2;
            if (splashAR > cardAR) {
              sh = h;
              sw = sh * splashAR;
              sy2 = y;
              sx2 = x + w - sw + (sw - w) * 0.10;
            } else {
              sw = w;
              sh = sw / splashAR;
              sx2 = x;
              sy2 = y - (sh - h) / 2;
            }
            ctx.globalAlpha = 0.22;
            ctx.drawImage(champSplash, sx2, sy2, sw, sh);
            ctx.globalAlpha = 1;

            // Fade-to-dark on the left half so the splash blends out behind
            // the icon + name + tier label (which render afterward on top).
            const fadeW = Math.round(w * 0.62);
            const fadeGrad = ctx.createLinearGradient(x, y, x + fadeW, y);
            fadeGrad.addColorStop(0,    'rgba(16,20,29,0.95)');
            fadeGrad.addColorStop(0.55, 'rgba(16,20,29,0.55)');
            fadeGrad.addColorStop(1,    'rgba(16,20,29,0)');
            ctx.fillStyle = fadeGrad;
            ctx.fillRect(x, y, fadeW, h);

            ctx.restore();
          }
        } catch (err) {
          logger.warn({ err: err.message }, 'lp profile: top-champion splash render failed');
        }
      }

      ctx.save();
      ctx.strokeStyle = tierColor;
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = 1.4;
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14);
      ctx.stroke();
      ctx.restore();

      // Profile icon with tier-color ring + level badge
      const iconR = 80;
      const iconCx = x + 30 + iconR;
      const iconCy = y + h / 2;

      // Halo glow
      const halo = ctx.createRadialGradient(iconCx, iconCy, iconR - 6, iconCx, iconCy, iconR + 22);
      halo.addColorStop(0, 'rgba(0,0,0,0)');
      halo.addColorStop(0.55, hexWithAlpha(tierColor, 0.30));
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(iconCx, iconCy, iconR + 22, 0, Math.PI * 2);
      ctx.fill();

      const profileIcon = profileIconId != null ? await getProfileIcon(profileIconId) : null;
      ctx.save();
      ctx.beginPath();
      ctx.arc(iconCx, iconCy, iconR, 0, Math.PI * 2);
      ctx.clip();
      if (profileIcon) {
        ctx.drawImage(profileIcon, iconCx - iconR, iconCy - iconR, iconR * 2, iconR * 2);
      } else {
        ctx.fillStyle = '#2a2e38';
        ctx.fillRect(iconCx - iconR, iconCy - iconR, iconR * 2, iconR * 2);
      }
      ctx.restore();
      ctx.strokeStyle = tierColor;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(iconCx, iconCy, iconR - 2, 0, Math.PI * 2);
      ctx.stroke();

      // Level badge — small dark pill at bottom of icon
      if (summonerLevel != null) {
        const lvlText = String(summonerLevel);
        ctx.font = `900 16px ${FONT_STACK}`;
        const lw = ctx.measureText(lvlText).width;
        const bw = Math.max(48, lw + 18);
        const bh = 26;
        const bx = iconCx - bw / 2;
        const by = iconCy + iconR - bh / 2;
        ctx.fillStyle = '#0c0f17';
        roundRect(ctx, bx, by, bw, bh, bh / 2);
        ctx.fill();
        ctx.strokeStyle = tierColor;
        ctx.lineWidth = 1.5;
        roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, bh / 2);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(lvlText, iconCx, by + bh / 2 + 1);
      }

      // Name + tier label
      const tx = iconCx + iconR + 30;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 56px ${FONT_STACK}`;
      ctx.fillText(riotTag || '—', tx, y + h / 2 - 8);

      // Mini-crest + tier label
      const miniCrest = await getRankMiniCrest(tier);
      const tierLabel = MASTER_PLUS_TIERS.has(tier) ? tier : `${tier} ${rank}`;
      const labelY = y + h / 2 + 38;
      const crestSize = 34;
      if (miniCrest) {
        const isWingFallback = miniCrest.width >= 500 || miniCrest.height >= 500;
        if (isWingFallback) {
          const sCrop = Math.min(miniCrest.width, miniCrest.height) * 0.85;
          const sx = (miniCrest.width - sCrop) / 2;
          const sy = (miniCrest.height - sCrop) / 2;
          ctx.drawImage(miniCrest, sx, sy, sCrop, sCrop, tx, labelY - crestSize + 6, crestSize, crestSize);
        } else {
          ctx.drawImage(miniCrest, tx, labelY - crestSize + 6, crestSize, crestSize);
        }
      }
      ctx.fillStyle = tierColor;
      ctx.font = `900 30px ${FONT_STACK}`;
      ctx.fillText(tierLabel, tx + crestSize + 12, labelY);

    }

    // ── STAT TILES ─────────────────────────────────────────────────────────
    const statsY = headerH + gap;
    {
      const tileCount = 3;
      const tileGap = 14;
      const availW = W - padX * 2;
      const tileW = (availW - tileGap * (tileCount - 1)) / tileCount;
      const drawTile = (i, render) => {
        const x = padX + i * (tileW + tileGap);
        ctx.fillStyle = '#10141d';
        roundRect(ctx, x, statsY, tileW, statsH, 12);
        ctx.fill();
        ctx.save();
        ctx.strokeStyle = tierColor;
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = 1.2;
        roundRect(ctx, x + 0.5, statsY + 0.5, tileW - 1, statsH - 1, 12);
        ctx.stroke();
        ctx.restore();
        render(x, statsY, tileW);
      };

      // Shared helper: render a "Current"-style tile with a tier mini-crest
      // on the left and big LP + rank label on the right. Used by both
      // Current and Peak tiles so the look stays uniform.
      const drawRankTile = async (tileIndex, label, rankTier, rankDiv, rankLp) => {
        const tileColor = TIER_BAR_COLORS[rankTier] || tierColor;
        const crest = await getRankMiniCrest(rankTier);
        // Override the tile border accent to match this rank's color.
        drawTile(tileIndex, (x, y, w) => {
          const crestSize = 56;
          const crestX = x + 18;
          const crestY = y + statsH / 2 - crestSize / 2;
          if (crest) {
            const isWingFallback = crest.width >= 500 || crest.height >= 500;
            if (isWingFallback) {
              const sCrop = Math.min(crest.width, crest.height) * 0.85;
              const sx = (crest.width - sCrop) / 2;
              const sy = (crest.height - sCrop) / 2;
              ctx.drawImage(crest, sx, sy, sCrop, sCrop, crestX, crestY, crestSize, crestSize);
            } else {
              ctx.drawImage(crest, crestX, crestY, crestSize, crestSize);
            }
          }

          // Right side text — label, LP, division
          const rightX = crestX + crestSize + 14;
          ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = '#9aa0a6'; ctx.font = `13px ${FONT_STACK}`;
          ctx.fillText(label, rightX, y + 32);
          // Big LP number
          const lpStr = String(rankLp);
          ctx.fillStyle = '#ffffff'; ctx.font = `900 44px ${FONT_STACK}`;
          ctx.fillText(lpStr, rightX, y + 78);
          const lpW = ctx.measureText(lpStr).width;
          ctx.fillStyle = '#7a818c'; ctx.font = `bold 14px ${FONT_STACK}`;
          ctx.fillText('LP', rightX + lpW + 6, y + 78);
          // Rank tag (e.g. "Diamond IV" / "Master")
          const rankTag = MASTER_PLUS_TIERS.has(rankTier)
            ? rankTier
            : `${rankTier} ${rankDiv}`;
          ctx.fillStyle = tileColor; ctx.font = `bold 14px ${FONT_STACK}`;
          ctx.fillText(rankTag, rightX, y + 102);
        });
      };

      await drawRankTile(0, 'Current', tier, rank, lp);
      await drawRankTile(1, 'Peak',    peakEntry.tier, peakEntry.rank, peakEntry.lp);

      // Win Rate — donut on left, big % + W/L on right (no duplicate %)
      drawTile(2, (x, y, w) => {
        const total = wins + losses;
        const wr = total > 0 ? wins / total : 0;
        const wrPct = Math.round(wr * 100);
        const wrColor = wr >= 0.5 ? '#3ba55d' : '#ed4245';

        // Donut on the left
        const donutR = 34;
        const donutCx = x + 26 + donutR;
        const donutCy = y + statsH / 2;
        ctx.lineWidth = 9;
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.beginPath();
        ctx.arc(donutCx, donutCy, donutR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = wrColor;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(donutCx, donutCy, donutR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * wr);
        ctx.stroke();
        ctx.lineCap = 'butt';

        // Label + big % + W/L on the right side of the tile
        const rightX = donutCx + donutR + 22;
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#9aa0a6'; ctx.font = `14px ${FONT_STACK}`;
        ctx.fillText('Win Rate', rightX, y + 32);
        ctx.fillStyle = wrColor;
        ctx.font = `900 42px ${FONT_STACK}`;
        ctx.fillText(`${wrPct}%`, rightX, y + 78);
        // W/L breakdown — green wins, red losses
        ctx.fillStyle = '#3ba55d'; ctx.font = `bold 14px ${FONT_STACK}`;
        const wText = `${wins}W`;
        ctx.fillText(wText, rightX, y + 102);
        const wTextW = ctx.measureText(wText).width;
        ctx.fillStyle = '#ed4245';
        ctx.fillText(` ${losses}L`, rightX + wTextW, y + 102);
      });

    }

    // ── PROGRESS BAR ───────────────────────────────────────────────────────
    const progressY = statsY + statsH + gap;
    {
      const milestone = nextRankMilestone(tier, rank, lp, cutoffs);
      const barX = padX;
      const barY = progressY + 16;
      const barH = 16;
      const labelW = 240; // reserved on the right for the label
      const barW = W - padX * 2 - labelW - 16;

      // Smooth track + fill — no segmentation since progress isn't really
      // discretized into chunks (each game's LP delta is variable).
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      roundRect(ctx, barX, barY, barW, barH, barH / 2);
      ctx.fill();
      const fillFrac = milestone ? Math.max(0.02, Math.min(1, milestone.fraction)) : 1;
      const fillW = Math.max(barH, fillFrac * barW);
      ctx.fillStyle = tierColor;
      roundRect(ctx, barX, barY, fillW, barH, barH / 2);
      ctx.fill();

      // Right-side label
      const labelX = barX + barW + 16;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const labelMidY = barY + barH / 2;
      let labelText;
      if (!milestone) {
        labelText = 'Apex tier';
      } else if (milestone.remaining === 0 && (milestone.nextLabel === 'Grandmaster' || milestone.nextLabel === 'Challenger')) {
        labelText = `Awaiting ${milestone.nextLabel} promo`;
        ctx.fillStyle = '#ffffff';
        ctx.font = `900 18px ${FONT_STACK}`;
        ctx.fillText(labelText, labelX, labelMidY);
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.font = `900 18px ${FONT_STACK}`;
        ctx.fillText(`${milestone.remaining}`, labelX, labelMidY);
        const rmW = ctx.measureText(`${milestone.remaining}`).width;
        ctx.fillStyle = '#9aa0a6';
        ctx.font = `bold 15px ${FONT_STACK}`;
        ctx.fillText(' LP to ', labelX + rmW, labelMidY);
        const toW = ctx.measureText(' LP to ').width;
        // Tint the destination tier name with that tier's color (e.g. GM in
        // red, Challenger in gold) — not the player's current tier color.
        const destTier = milestone.nextLabel.split(' ')[0].toUpperCase();
        const destColor = TIER_BAR_COLORS[destTier] || tierColor;
        ctx.fillStyle = destColor;
        ctx.font = `900 18px ${FONT_STACK}`;
        ctx.fillText(milestone.nextLabel.toUpperCase(), labelX + rmW + toW, labelMidY);
      }
    }

    // ── LP HISTORY CHART ───────────────────────────────────────────────────
    const chartY = progressY + progressH + gap;
    {
      const x = padX;
      const y = chartY;
      const w = W - padX * 2;
      const h = chartH;

      ctx.fillStyle = '#10141d';
      roundRect(ctx, x, y, w, h, 14);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = tierColor;
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = 1.4;
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14);
      ctx.stroke();
      ctx.restore();

      // Title + tiny legend (green up / red down)
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = tierColor;
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.fillText('📈  LP HISTORY', x + 18, y + 30);

      // Right-aligned legend showing what the line colors mean.
      const legendY = y + 28;
      const legendX = x + w - 18;
      const drawLegendPip = (lx, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(lx, legendY - 8, 14, 4);
      };
      const lossText = 'Loss';
      const winText  = 'Win';
      ctx.font = `13px ${FONT_STACK}`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#cfd6ff';
      const lossTextW = ctx.measureText(lossText).width;
      ctx.fillText(lossText, legendX, legendY);
      drawLegendPip(legendX - lossTextW - 18, '#ed4245');

      ctx.fillStyle = '#cfd6ff';
      const winTailX = legendX - lossTextW - 18 - 14;
      const winTextW = ctx.measureText(winText).width;
      ctx.fillText(winText, winTailX, legendY);
      drawLegendPip(winTailX - winTextW - 18, '#3ba55d');

      // Plot area
      const plotPadL = 70;
      const plotPadR = 24;
      const plotPadT = 58;
      const plotPadB = 56;
      const plotX = x + plotPadL;
      const plotY = y + plotPadT;
      const plotW = w - plotPadL - plotPadR;
      const plotH = h - plotPadT - plotPadB;

      // Y values — plot ABSOLUTE LP so the line is continuous across
      // promotions/demotions. Y-axis labels then translate each tick value
      // back into a rank string (e.g. 2400 → "D4", 2500 → "D3", 2800 →
      // "MAS"). Above Master start (2800) we switch to "MAS X" raw LP.
      const abs = series.map(p => p.abs);
      const minVal = Math.min(...abs);
      const maxVal = Math.max(...abs);
      const span = Math.max(50, maxVal - minVal);
      const padV = Math.max(40, span * 0.15);
      const yMin = Math.max(0, Math.floor((minVal - padV) / 100) * 100);
      const yMax = Math.ceil((maxVal + padV) / 100) * 100;
      const yRange = yMax - yMin || 1;

      // Tick label: rank for sub-master, "MAS N" for Master+. The actual
      // tick *positions* are computed below alongside the grid pass.
      const SUB_TIER_SHORT = ['I', 'B', 'S', 'G', 'P', 'E', 'D'];
      const labelFor = (v) => {
        if (v >= 2800) {
          const masterLp = v - 2800;
          return masterLp === 0 ? 'MAS' : `MAS ${masterLp}`;
        }
        // Sub-master: ti*400 + di*100 + raw_lp. Snap to division boundaries.
        const ti = Math.floor(v / 400);
        const di = Math.floor((v % 400) / 100);
        const divNum = 4 - di; // di=0 → IV → 4, di=3 → I → 1
        return `${SUB_TIER_SHORT[ti]}${divNum}`;
      };

      const yPx = v => plotY + plotH * (yMax - v) / yRange;
      const xPx = i => plotX + (series.length === 1 ? plotW / 2 : plotW * i / (series.length - 1));

      // Tier-zone backgrounds — each main tier (sub-master) gets a faint
      // color band so the chart reads as a vertical rank ladder. Master+
      // gets a current-tier band, with the area above the live apex cutoff
      // tinted as the next tier when known.
      const TIERS_ALL = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];

      const drawBand = (loV, hiV, color) => {
        if (hiV <= loV) return;
        const yTop = yPx(hiV);
        const yBot = yPx(loV);
        ctx.fillStyle = color;
        ctx.fillRect(plotX, yTop, plotW, yBot - yTop);
      };

      // Apex cutoff (Master → GM or GM → Challenger) converted to absolute LP.
      let apexCutoffAbs = null;
      let apexNextTier = null;
      if (tier === 'MASTER' && cutoffs?.gm != null) {
        apexCutoffAbs = 2800 + cutoffs.gm;
        apexNextTier = 'GRANDMASTER';
      } else if (tier === 'GRANDMASTER' && cutoffs?.chl != null) {
        apexCutoffAbs = 2800 + cutoffs.chl;
        apexNextTier = 'CHALLENGER';
      }

      // Sub-master tier bands (one per 400-LP main tier).
      for (let ti = 0; ti < 7; ti++) {
        const lo = Math.max(yMin, ti * 400);
        const hi = Math.min(yMax, (ti + 1) * 400);
        if (hi <= lo) continue;
        const bandColor = TIER_BAR_COLORS[TIERS_ALL[ti]] || '#888';
        drawBand(lo, hi, hexWithAlpha(bandColor, 0.10));
      }
      // Master+ band (2800+). Split at the apex cutoff if we have one.
      if (yMax > 2800) {
        const masterBot = Math.max(yMin, 2800);
        if (apexCutoffAbs != null && apexCutoffAbs > masterBot && apexCutoffAbs < yMax) {
          drawBand(masterBot, apexCutoffAbs, hexWithAlpha(TIER_BAR_COLORS.MASTER, 0.10));
          const nextColor = TIER_BAR_COLORS[apexNextTier] || TIER_BAR_COLORS.GRANDMASTER;
          drawBand(apexCutoffAbs, yMax, hexWithAlpha(nextColor, 0.16));
        } else {
          drawBand(masterBot, yMax, hexWithAlpha(TIER_BAR_COLORS.MASTER, 0.10));
        }
      }

      // Grid + Y tick labels — ticks at division boundaries (every 100 LP)
      // for sub-master, every 100 LP starting at Master 0 for Master+. If
      // the range is huge (e.g. spans multiple tiers), step up to keep the
      // axis readable.
      const niceStep = (yRange >= 800) ? 200 : 100;
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#9aa0a6';
      ctx.font = `bold 12px ${FONT_STACK}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const firstTick = Math.ceil(yMin / niceStep) * niceStep;
      for (let v = firstTick; v <= yMax; v += niceStep) {
        const py = yPx(v);
        ctx.beginPath();
        ctx.moveTo(plotX, py);
        ctx.lineTo(plotX + plotW, py);
        ctx.stroke();
        ctx.fillText(labelFor(v), plotX - 10, py);
      }

      // Dashed reference line at the Master tier threshold (2800) and at
      // the apex cutoff when applicable.
      const dashedLines = [];
      if (2800 > yMin && 2800 < yMax) {
        dashedLines.push({ v: 2800, color: TIER_BAR_COLORS.MASTER });
      }
      if (apexCutoffAbs != null && apexCutoffAbs > yMin && apexCutoffAbs < yMax) {
        dashedLines.push({ v: apexCutoffAbs, color: TIER_BAR_COLORS[apexNextTier] || TIER_BAR_COLORS.GRANDMASTER });
      }
      for (const d of dashedLines) {
        ctx.strokeStyle = hexWithAlpha(d.color, 0.85);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(plotX, yPx(d.v));
        ctx.lineTo(plotX + plotW, yPx(d.v));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Y axis label
      ctx.save();
      ctx.translate(x + 22, plotY + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#9aa0a6';
      ctx.font = `bold 13px ${FONT_STACK}`;
      ctx.fillText('LP', 0, 0);
      ctx.restore();

      // Fill area below the line — tier-color tint
      ctx.fillStyle = hexWithAlpha(tierColor, 0.18);
      ctx.beginPath();
      ctx.moveTo(xPx(0), yPx(abs[0]));
      for (let i = 1; i < abs.length; i++) ctx.lineTo(xPx(i), yPx(abs[i]));
      ctx.lineTo(xPx(abs.length - 1), plotY + plotH);
      ctx.lineTo(xPx(0), plotY + plotH);
      ctx.closePath();
      ctx.fill();

      // Per-segment colored line — green if LP went up, red if it went down.
      // Reads as a win/loss timeline at a glance, without depending on dots.
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      for (let i = 1; i < abs.length; i++) {
        const delta = abs[i] - abs[i - 1];
        ctx.strokeStyle = delta > 0 ? '#3ba55d' : (delta < 0 ? '#ed4245' : tierColor);
        ctx.beginPath();
        ctx.moveTo(xPx(i - 1), yPx(abs[i - 1]));
        ctx.lineTo(xPx(i), yPx(abs[i]));
        ctx.stroke();
      }

      // Dots only at "real" peaks and pits — the local extremum within a
      // ±WIN window. A single W-L-W blip in the middle of a winning streak
      // won't generate dots; only the genuine turning points where the
      // trend reverses for at least a few games. Plus the global high/low.
      const peakIdx = abs.indexOf(Math.max(...abs));
      const pitIdx = abs.indexOf(Math.min(...abs));
      const WIN = Math.max(2, Math.floor(abs.length / 30)); // ~5 for 139-game series
      const isLocalPeak = (i) => {
        for (let j = Math.max(0, i - WIN); j <= Math.min(abs.length - 1, i + WIN); j++) {
          if (j !== i && abs[j] > abs[i]) return false;
        }
        // Must strictly beat at least one side to avoid plateaus all dotting.
        return (i > 0 && abs[i] > abs[i - 1]) || (i < abs.length - 1 && abs[i] > abs[i + 1]);
      };
      const isLocalPit = (i) => {
        for (let j = Math.max(0, i - WIN); j <= Math.min(abs.length - 1, i + WIN); j++) {
          if (j !== i && abs[j] < abs[i]) return false;
        }
        return (i > 0 && abs[i] < abs[i - 1]) || (i < abs.length - 1 && abs[i] < abs[i + 1]);
      };

      const markedDots = new Set([0, abs.length - 1, peakIdx, pitIdx]);
      for (let i = 1; i < abs.length - 1; i++) {
        if (isLocalPeak(i) || isLocalPit(i)) markedDots.add(i);
      }
      for (const i of markedDots) {
        // Color the dot by which side of the trend it caps: peak = green
        // (ended a winning run), pit = red (ended a losing run).
        let color = tierColor;
        if (i > 0 && i < abs.length - 1) {
          if (abs[i] >= abs[i - 1] && abs[i] >= abs[i + 1]) color = '#3ba55d';
          else if (abs[i] <= abs[i - 1] && abs[i] <= abs[i + 1]) color = '#ed4245';
        } else if (i > 0) {
          color = abs[i] > abs[i - 1] ? '#3ba55d' : '#ed4245';
        }
        const r = (i === peakIdx || i === pitIdx) ? 6 : 4.5;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(xPx(i), yPx(abs[i]), r, 0, Math.PI * 2);
        ctx.fill();
      }

      // X-axis ticks
      ctx.fillStyle = '#9aa0a6';
      ctx.font = `13px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const N = series.length - 1;
      const xStep = Math.max(1, Math.ceil(N / 7));
      let lastDrawn = -Infinity;
      for (let i = 0; i <= N; i += xStep) {
        ctx.fillText(String(i), xPx(i), plotY + plotH + 10);
        lastDrawn = i;
      }
      if (lastDrawn !== N && N > 0) ctx.fillText(String(N), xPx(N), plotY + plotH + 10);

      // X-axis title
      ctx.fillStyle = '#9aa0a6';
      ctx.font = `bold 13px ${FONT_STACK}`;
      ctx.fillText('Games Tracked', plotX + plotW / 2, plotY + plotH + 32);

      // End-of-line "X LP" callout
      const lastX = xPx(N);
      const lastY = yPx(abs[N]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = tierColor;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
      ctx.fill();

      // Callout shows current rank short label + raw LP (e.g. "D4 45 LP",
      // "MAS 575"). Built from the last entry's tier/rank/lp so it matches
      // what Riot displays in-game, not the absolute-LP plot value.
      const lastEntry = series[N];
      const calloutText = MASTER_PLUS_TIERS.has(lastEntry.tier)
        ? `${lastEntry.tier === 'MASTER' ? 'MAS' : lastEntry.tier === 'GRANDMASTER' ? 'GM' : 'CHA'} ${lastEntry.lp} LP`
        : `${SUB_TIER_SHORT[Math.floor(lastEntry.abs / 400)]}${4 - Math.floor((lastEntry.abs % 400) / 100)} ${lastEntry.lp} LP`;
      ctx.font = `900 14px ${FONT_STACK}`;
      const ctw = ctx.measureText(calloutText).width;
      const cpadX = 10;
      const cpadY = 6;
      const cw = ctw + cpadX * 2;
      const ch = 24;
      let cx = lastX - cw - 14;
      const cy = lastY - ch / 2;
      if (cx < plotX) cx = lastX + 14;
      ctx.fillStyle = hexWithAlpha(tierColor, 0.85);
      roundRect(ctx, cx, cy, cw, ch, 6);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(calloutText, cx + cw / 2, cy + ch / 2 + 1);
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: LP profile render failed');
    return null;
  }
}

function niceLpStep(range) {
  // Prefer 25/50/100/200/500 LP steps, scaled to give ~5 ticks
  const target = range / 5;
  const candidates = [25, 50, 100, 200, 500, 1000];
  for (const c of candidates) {
    if (target <= c) return c;
  }
  return Math.ceil(target / 500) * 500;
}

// Distinct colors for stacked /lpc lines (up to 6 players)
const COMPARE_COLORS = [
  '#5DADE2', // blue
  '#2ecc71', // green
  '#e67e22', // orange
  '#9b59b6', // purple
  '#e74c3c', // red
  '#f1c40f', // yellow
];

export function compareColor(i) {
  return COMPARE_COLORS[i % COMPARE_COLORS.length];
}


// Multi-player LP overlay. `players` = [{ riotTag, entries }] where entries is
// the lp_history rows for that player (tier/rank/lp/recorded_at). X-axis is
// time-aligned across players so play frequency is reflected in dot density.
export async function renderLpComparePng(players, opts = {}) {
  if (!players?.length) return null;
  const valid = players.filter(p => p.entries?.length);
  if (!valid.length) return null;

  const { title = 'LP Comparison' } = opts;

  try {
    const W = 520;
    const H = 220;
    const padL = 56;
    const padR = 14;
    const padT = 28;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = TITLE;
    ctx.font = `bold 13px ${FONT_STACK}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(title, padL, 8);

    // Y range across all players
    let minVal = Infinity, maxVal = -Infinity;
    for (const p of valid) {
      for (const e of p.entries) {
        const abs = toAbsoluteLP(e.tier, e.rank, e.lp);
        if (abs == null) continue;
        if (abs < minVal) minVal = abs;
        if (abs > maxVal) maxVal = abs;
      }
    }
    if (!Number.isFinite(minVal)) return null;
    const span = Math.max(50, maxVal - minVal);
    const pad = Math.max(25, span * 0.1);
    let yMin = Math.max(0, Math.floor((minVal - pad) / 50) * 50);
    const yMax = Math.ceil((maxVal + pad) / 50) * 50;

    // Extend yMin to include at least half of the band below (same as /lp)
    const playerBandIdx = TIER_BANDS.findIndex(b => minVal >= b.min && minVal < b.max);
    if (playerBandIdx > 0) {
      const bandBelow = TIER_BANDS[playerBandIdx - 1];
      const targetMin = Math.max(0, bandBelow.min + Math.floor((bandBelow.max - bandBelow.min) / 2 / 50) * 50);
      yMin = Math.min(yMin, targetMin);
    }
    const yRange = yMax - yMin || 1;
    const yPx = v => padT + plotH * (yMax - v) / yRange;

    // Time range (X-axis)
    const parseTs = s => {
      const t = Date.parse((s || '').replace(' ', 'T') + 'Z');
      return Number.isFinite(t) ? t : null;
    };
    let tMin = Infinity, tMax = -Infinity;
    for (const p of valid) {
      for (const e of p.entries) {
        const t = parseTs(e.recorded_at);
        if (t == null) continue;
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    }
    if (!Number.isFinite(tMin) || tMin === tMax) tMax = tMin + 1;
    const tSpan = tMax - tMin;
    const xPx = t => padL + plotW * (t - tMin) / tSpan;

    // Tier bands
    for (const band of TIER_BANDS) {
      const lo = Math.max(band.min, yMin);
      const hi = Math.min(band.max, yMax);
      if (hi <= lo) continue;
      const yTop = yPx(hi);
      const yBot = yPx(lo);
      ctx.fillStyle = band.color;
      ctx.fillRect(padL, yTop, plotW, yBot - yTop);
      if (yBot - yTop > 14) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.font = `9px ${FONT_STACK}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(band.name, W - padR - 3, yTop + 2);
      }
    }

    // Tier boundary dashed lines
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const band of TIER_BANDS) {
      if (band.min > yMin && band.min < yMax) {
        const py = yPx(band.min);
        ctx.beginPath();
        ctx.moveTo(padL, py);
        ctx.lineTo(W - padR, py);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // Y-tick labels
    const niceStep = niceLpStep(yRange);
    ctx.fillStyle = AXIS;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / niceStep) * niceStep; v <= yMax; v += niceStep) {
      ctx.fillText(v.toString(), padL - 6, yPx(v));
    }

    // One line + dots per player. Lines drawn first so peak rings/callouts
    // (drawn in a second pass below) always sit on top of every line.
    const peakMarks = [];
    for (let pi = 0; pi < valid.length; pi++) {
      const p = valid[pi];
      const color = compareColor(pi);
      const pts = [];
      let peak = null; // { abs, entry, point }
      let pit = null;  // { abs, entry, point } — lowest LP reached
      for (const e of p.entries) {
        const abs = toAbsoluteLP(e.tier, e.rank, e.lp);
        const t = parseTs(e.recorded_at);
        if (abs == null || t == null) continue;
        const pt = { x: xPx(t), y: yPx(abs) };
        pts.push(pt);
        if (!peak || abs > peak.abs) peak = { abs, entry: e, point: pt };
        if (!pit || abs < pit.abs) pit = { abs, entry: e, point: pt };
      }
      if (pts.length === 0) continue;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();

      // Carry-forward: if this player hasn't logged a point at the global
      // tMax, extend a faint dashed plateau from their last point to the right
      // edge so every line ends at the same x.
      const lastEntry = p.entries[p.entries.length - 1];
      const lastT = parseTs(lastEntry?.recorded_at);
      if (lastT != null && lastT < tMax) {
        const lastPt = pts[pts.length - 1];
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lastPt.x, lastPt.y);
        ctx.lineTo(xPx(tMax), lastPt.y);
        ctx.stroke();
        ctx.restore();
      }

      // Dots only at the peak and pit (highest / lowest LP for this player).
      ctx.fillStyle = color;
      const dotPoints = [];
      if (peak) dotPoints.push(peak.point);
      if (pit && pit.point !== peak?.point) dotPoints.push(pit.point);
      for (const pt of dotPoints) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      if (peak) peakMarks.push({ pi, color, peak });
    }

    // Per-player peak callouts — ring + pill with the rank label. Stagger
    // upward by player index so two peaks at similar Y/X don't overlap.
    for (const m of peakMarks) {
      const { color, peak, pi } = m;
      const { point, entry } = peak;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
      ctx.stroke();

      const labelY = Math.max(padT + 10, point.y - 8 - pi * 14);
      drawCallout(ctx, point.x, labelY, rankLabel(entry.tier, entry.rank, entry.lp), color, 'above', W, padR, H);
    }

    // Y-axis label
    ctx.save();
    ctx.translate(14, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = AXIS;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.fillText('LP', 0, 0);
    ctx.restore();

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: LP compare render failed');
    return null;
  }
}

// Solid tier-fill colors for the rank-ladder bars. Slightly different from the
// faint band fills (TIER_BANDS above) — needs to be opaque/saturated to stand
// out as a bar.
const TIER_BAR_COLORS = {
  IRON:        '#7a6a62',
  BRONZE:      '#a0522d',
  SILVER:      '#c0c0c0',
  GOLD:        '#f1c40f',
  PLATINUM:    '#3cbec8',
  EMERALD:     '#2ecc71',
  DIAMOND:     '#5DADE2',
  MASTER:      '#9b59b6',
  GRANDMASTER: '#e74c3c',
  CHALLENGER:  '#f4d03f',
};

const PEAK_YELLOW = '#f1c40f';

// Short tier abbreviations for the per-player LP tag (e.g. "c-1235", "m-345",
// "d2-45"). Master+ have no division so it's just abbr-LP; below master we
// include the division number (IV→4 … I→1).
const TIER_ABBR = {
  IRON: 'I', BRONZE: 'B', SILVER: 'S', GOLD: 'G', PLATINUM: 'P',
  EMERALD: 'E', DIAMOND: 'D', MASTER: 'M', GRANDMASTER: 'GM', CHALLENGER: 'C',
};
const MASTER_PLUS_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const DIVISION_NUM = { I: 1, II: 2, III: 3, IV: 4 };

function formatRankShort(tier, rank, lp) {
  if (!tier) return null;
  const abbr = TIER_ABBR[tier] || '?';
  if (lp == null) return abbr;
  if (MASTER_PLUS_TIERS.has(tier)) return `${abbr}-${lp}`;
  const div = DIVISION_NUM[rank] || '';
  return `${abbr}${div}-${lp}`;
}

// Horizontal-bar rank ladder. Each player is a row: name on the left, a
// tier-colored bar from 0 to their current absolute LP, a faded extension +
// vertical tick to their peak if they've lost LP, and a right-side label.
// Players currently at peak get a yellow halo around the end-cap dot and a
// "CURRENT PEAK!!" tag in yellow.
//
// `players` shape: [{ riot_tag, tier, rank, lp, peak_tier?, peak_rank?, peak_lp? }]
// Compute "X LP to {next tier or division}" + progress fraction for the bar.
// `cutoffs` is { gm, chl } from getApexCutoffs(region); pass null/undefined to
// fall back to a 250/500/750 LP banded milestone for Master+ when we don't
// have a live cutoff.
function nextRankMilestone(tier, rank, lp, cutoffs = null) {
  const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
  const DIVS_DESC = ['IV', 'III', 'II', 'I'];
  const ti = TIERS.indexOf(tier);
  if (ti < 0) return null;
  // Sub-master: progress within current division (0..100 LP).
  if (ti < 7) {
    const di = DIVS_DESC.indexOf(rank);
    const remaining = Math.max(0, 100 - lp);
    let nextLabel;
    if (di < 0) nextLabel = '?';
    else if (di === 3) {
      // Promoting from Diamond I (or rare cases above) — the next tier is
      // an apex tier with no division, so drop the trailing " IV".
      const next = TIERS[ti + 1];
      nextLabel = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(next)
        ? capitalize(next)
        : `${capitalize(next)} IV`;
    }
    else nextLabel = `${capitalize(tier)} ${DIVS_DESC[di + 1]}`;
    return { remaining, nextLabel, fraction: Math.min(1, lp / 100) };
  }
  // Master / GM — live cutoff if we have it, otherwise band to next 250 step.
  if (tier === 'MASTER') {
    const live = cutoffs?.gm;
    if (live != null && live > 0) {
      return {
        remaining: Math.max(0, live - lp),
        nextLabel: 'Grandmaster',
        fraction: Math.min(1, lp / live),
      };
    }
    return bandedMilestone(lp, 'Grandmaster');
  }
  if (tier === 'GRANDMASTER') {
    const live = cutoffs?.chl;
    if (live != null && live > 0) {
      return {
        remaining: Math.max(0, live - lp),
        nextLabel: 'Challenger',
        fraction: Math.min(1, lp / live),
      };
    }
    return bandedMilestone(lp, 'Challenger');
  }
  // Challenger — no further tier to climb; we still want a bar so it doesn't
  // look broken next to lower-tier rows. Band to next 250 LP step.
  if (tier === 'CHALLENGER') {
    return bandedMilestone(lp, null);
  }
  return null;
}

// Fallback when we don't have a live apex cutoff: progress to the next round
// 250-LP step (0..250..500..750..). `nextLabel` is "LP" with no destination
// when we're at the top tier (no tier above).
function bandedMilestone(lp, nextTierName) {
  const step = 250;
  const nextBand = Math.ceil((lp + 1) / step) * step;
  const remaining = Math.max(0, nextBand - lp);
  const prevBand = nextBand - step;
  const fraction = (lp - prevBand) / step;
  return {
    remaining,
    nextLabel: nextTierName ? nextTierName : `${nextBand} LP`,
    fraction: Math.max(0, Math.min(1, fraction)),
  };
}

function capitalize(s) {
  if (!s) return '';
  return s[0] + s.slice(1).toLowerCase();
}

// Compact "MAS 304" / "DIA II 50" peak label for the card subtitle.
function compactPeakLabel(tier, rank, lp) {
  const SHORT = { IRON: 'IRO', BRONZE: 'BRZ', SILVER: 'SLV', GOLD: 'GLD', PLATINUM: 'PLT', EMERALD: 'EMR', DIAMOND: 'DIA', MASTER: 'MAS', GRANDMASTER: 'GM', CHALLENGER: 'CHA' };
  const t = SHORT[tier] || tier?.slice(0, 3);
  if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier)) return `${t} ${lp}`;
  return `${t} ${rank} ${lp}`;
}

export async function renderRankLadderPng(players, opts = {}) {
  if (!players?.length) return null;
  const {
    title = 'RANK LADDER',
    subtitle = 'Tracked Players',
    decorateFirstLast = false, // 👑 on first row, 🥀 on last row
    bg = '#15171c', // dark navy bg matches the mockup
  } = opts;

  try {
    const sorted = [...players].sort((a, b) =>
      (toAbsoluteLP(b.tier, b.rank, b.lp) || 0) - (toAbsoluteLP(a.tier, a.rank, a.lp) || 0)
    );

    // Card layout dimensions. Sized for Discord's ~720px attachment column —
    // tall rows trade aspect ratio for in-chat row size (Discord downscales to
    // fit width, so making rows taller is what actually grows the visible row).
    const SCALE = 2;
    const W = 920;
    const padX = 18;
    const headerH = 72;
    const cardH = 120;
    const cardGap = 10;
    const padBottom = 22;
    const H = headerH + sorted.length * cardH + Math.max(0, sorted.length - 1) * cardGap + padBottom;

    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // Background gradient — slight diagonal to mimic the mockup.
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#181b22');
    grad.addColorStop(1, '#0f1118');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // ── Header — crown + title on a single line, no subtitle ───────────────
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const headerBaselineY = 56;
    ctx.fillStyle = '#f0b232';
    ctx.font = `900 36px ${FONT_STACK}`;
    ctx.fillText('👑', padX, headerBaselineY);
    ctx.fillStyle = '#fff';
    ctx.font = `900 30px ${FONT_STACK}`;
    ctx.fillText(title, padX + 46, headerBaselineY);

    // ── Cards ───────────────────────────────────────────────────────────────
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const cardY = headerH + i * (cardH + cardGap);
      const cardX = padX;
      const cardW = W - padX * 2;
      const absCur = toAbsoluteLP(p.tier, p.rank, p.lp) || 0;
      const absPeak = p.peak_tier ? (toAbsoluteLP(p.peak_tier, p.peak_rank, p.peak_lp) || 0) : 0;
      const tierColor = TIER_BAR_COLORS[p.tier] || '#999';
      const isPeaking = !p.peak_tier || absCur >= absPeak;
      const isLeader = i === 0;

      // Card background
      ctx.fillStyle = '#1d2029';
      roundRect(ctx, cardX, cardY, cardW, cardH, 10);
      ctx.fill();
      // Left accent bar — gold for the leader, tier-color otherwise
      ctx.fillStyle = isLeader ? '#f0b232' : tierColor;
      roundRect(ctx, cardX, cardY, 4, cardH, 2);
      ctx.fill();
      // Leader gets a subtle gold border
      if (isLeader) {
        ctx.strokeStyle = 'rgba(240,178,50,0.6)';
        ctx.lineWidth = 1.5;
        roundRect(ctx, cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1, 10);
        ctx.stroke();
      }

      // ── Column 1: rank number (or crown for #1, rose for last) ───────────
      const colNumCx = cardX + 40;
      const cy = cardY + cardH / 2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (decorateFirstLast && isLeader) {
        ctx.font = `32px ${FONT_STACK}`;
        ctx.fillText('👑', colNumCx, cy);
      } else {
        ctx.fillStyle = isLeader ? '#f0b232' : '#e8e8ea';
        ctx.font = `900 32px ${FONT_STACK}`;
        ctx.fillText(String(i + 1), colNumCx, cy);
      }

      // ── Column 2: summoner icon (circle clipped) ─────────────────────────
      const iconR = 34;
      const iconCx = cardX + 102;
      const iconCy = cy;
      const icon = p.profileIconId != null ? await getProfileIcon(p.profileIconId) : null;
      ctx.save();
      ctx.beginPath();
      ctx.arc(iconCx, iconCy, iconR, 0, Math.PI * 2);
      ctx.clip();
      if (icon) {
        ctx.drawImage(icon, iconCx - iconR, iconCy - iconR, iconR * 2, iconR * 2);
      } else {
        ctx.fillStyle = '#2a2e38';
        ctx.fillRect(iconCx - iconR, iconCy - iconR, iconR * 2, iconR * 2);
      }
      ctx.restore();
      ctx.strokeStyle = isLeader ? '#f0b232' : 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(iconCx, iconCy, iconR - 1, 0, Math.PI * 2);
      ctx.stroke();

      // ── Column 3: name + peak subtitle ───────────────────────────────────
      const nameX = cardX + 152;
      const nameDisplay = decorateFirstLast && i === sorted.length - 1 && sorted.length > 1
        ? `🥀 ${displayName(p.riot_tag)}`
        : displayName(p.riot_tag);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff';
      ctx.font = `bold 24px ${FONT_STACK}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(nameDisplay, nameX, cy - 5);
      // At-peak players get a yellow "CURRENT PEAK!" tag here instead of the
      // grey "Peak: X" subtitle — the big tier+LP label already conveys their
      // current rank (which == peak) so the peak value isn't lost.
      if (isPeaking && p.peak_tier) {
        ctx.fillStyle = '#f0b232';
        ctx.font = `bold 14px ${FONT_STACK}`;
        ctx.fillText('CURRENT PEAK!', nameX, cy + 20);
      } else {
        ctx.fillStyle = '#7a818c';
        ctx.font = `14px ${FONT_STACK}`;
        ctx.fillText(`Peak: ${p.peak_tier ? compactPeakLabel(p.peak_tier, p.peak_rank, p.peak_lp) : '—'}`, nameX, cy + 20);
      }

      // ── Column 4: tier emblem ────────────────────────────────────────────
      // Source emblems are 1280×720 with the actual crest centered and lots
      // of empty space around it. Crop to a centered square that's ~60% of
      // the shorter axis so the crest fills the destination box instead of
      // shrinking into a small icon with whitespace around it.
      const emblemSize = 116;
      const emblemX = cardX + 315;
      const emblem = await getRankEmblem(p.tier);
      if (emblem) {
        const sCrop = Math.min(emblem.width, emblem.height) * 0.85;
        const sx = (emblem.width - sCrop) / 2;
        const sy = (emblem.height - sCrop) / 2;
        ctx.drawImage(emblem, sx, sy, sCrop, sCrop, emblemX, cy - emblemSize / 2, emblemSize, emblemSize);
      } else {
        ctx.fillStyle = tierColor;
        ctx.fillRect(emblemX + emblemSize / 2 - 3, cy - 28, 6, 56);
      }

      // ── Column 5: TIER + LP big ──────────────────────────────────────────
      const labelX = cardX + 450;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = tierColor;
      ctx.font = `bold 16px ${FONT_STACK}`;
      const tierLabel = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(p.tier)
        ? p.tier
        : `${p.tier} ${p.rank}`;
      ctx.fillText(tierLabel, labelX, cy - 10);
      ctx.fillStyle = '#fff';
      ctx.font = `900 32px ${FONT_STACK}`;
      const lpText = `${p.lp}`;
      ctx.fillText(lpText, labelX, cy + 22);
      const lpW = ctx.measureText(lpText).width;
      ctx.fillStyle = '#7a818c';
      ctx.font = `14px ${FONT_STACK}`;
      ctx.fillText('LP', labelX + lpW + 6, cy + 22);

      // ── Column 6: progress bar + sub label ───────────────────────────────
      // Master+ has no milestone (dynamic apex-tier cutoffs we don't query).
      // For those players we skip the bar entirely; the "CURRENT PEAK!" tag
      // still shows as text if applicable.
      const barX = cardX + 590;
      const barW = 200;
      const barH = 10;
      const barY = cy - 5;
      const milestone = nextRankMilestone(p.tier, p.rank, p.lp, p.cutoffs || null);

      if (milestone) {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        roundRect(ctx, barX, barY, barW, barH, barH / 2);
        ctx.fill();
        const fillW = Math.max(2, Math.min(barW, milestone.fraction * barW));
        ctx.fillStyle = tierColor;
        roundRect(ctx, barX, barY, fillW, barH, barH / 2);
        ctx.fill();
        // End-cap dot at the bar's fill edge — solid tier color, every row.
        ctx.fillStyle = tierColor;
        ctx.beginPath();
        ctx.arc(barX + fillW, barY + barH / 2, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      // Progress sub-text — always shows climb-to-next-tier (no longer the
      // home of "CURRENT PEAK!"; that moved next to the LP big number).
      ctx.fillStyle = '#7a818c';
      ctx.font = `13px ${FONT_STACK}`;
      let subText = '';
      if (milestone?.nextLabel) {
        const isApexNextTier = milestone.nextLabel === 'Grandmaster' || milestone.nextLabel === 'Challenger';
        subText = (milestone.remaining === 0 && isApexNextTier)
          ? `Awaiting ${milestone.nextLabel} promo`
          : `${milestone.remaining} LP to ${milestone.nextLabel}`;
      }
      const subY = milestone ? barY + barH + 18 : cy + 8;
      ctx.fillText(subText, barX, subY);

      // ── Column 7: weekly LP delta ────────────────────────────────────────
      const deltaX = cardX + cardW - 20;
      if (p.weeklyDelta != null && Number.isFinite(p.weeklyDelta)) {
        const positive = p.weeklyDelta >= 0;
        ctx.textAlign = 'right';
        ctx.fillStyle = positive ? '#3ba55d' : '#ed4245';
        ctx.font = `bold 22px ${FONT_STACK}`;
        ctx.fillText(`${positive ? '↑' : '↓'} ${Math.abs(p.weeklyDelta)}`, deltaX, cy - 5);
        ctx.fillStyle = '#7a818c';
        ctx.font = `13px ${FONT_STACK}`;
        ctx.fillText('LP this week', deltaX, cy + 20);
      }
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: rank ladder render failed');
    return null;
  }
}

const LANE_BY_INDEX = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];

function hexWithAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function fitText(ctx, str, maxW) {
  if (!str) return '';
  if (ctx.measureText(str).width <= maxW) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// Mockup-style Match Detected: header band + two team panels (BLUE/RED) with
// per-player cards (champion icon w/ tier glow, lane icon overlay, name, tier
// pill). Tracked player is highlighted with a gold ring + crown overlay +
// italic gold name. Parlay/auto-bet footer cards are preserved.
async function renderMatchDetectedCards(opts) {
  const {
    blueTeam, redTeam, highlightSet, labelFor,
    getChampionInternalId, getChampionName,
    title, subtitle, gameMode,
    blueBans = [], redBans = [],
    parlay = null, autoBets = [], autoBetStyle = 'plain',
    betStatus = null, // { kind: 'open', minutes, winMult, loseMult } | { kind: 'closed', playerName }
  } = opts;
  const isTrackedPuuid = (puuid) => highlightSet && highlightSet.has(puuid);

  try {
    const SCALE = 2;
    const W = 920;
    const padX = 18;

    const headerH = 100;

    const panelInnerPadX = 14;
    const panelHdrH = 38;
    const cardCount = 5;
    const cardGap = 8;
    const panelW = W - padX * 2;
    const cardsAreaW = panelW - panelInnerPadX * 2;
    const cardW = (cardsAreaW - cardGap * (cardCount - 1)) / cardCount;
    const cardH = 178;
    const panelBottomPad = 12;
    const panelH = panelHdrH + cardH + panelBottomPad;

    const blueY = headerH + 4;
    const teamGap = 22;
    const redY = blueY + panelH + teamGap;
    const gridBottom = redY + panelH;

    const betStatusGap = 12;
    const betStatusH = betStatus ? 42 : 0;
    const betStatusY = gridBottom + (betStatus ? betStatusGap : 0);

    const cardHeightFor = (n) => 24 + n * 22 + 12;
    const fcardGap = 10;
    const parlaySectionH = parlay ? (fcardGap + cardHeightFor(1)) : 0;
    let autoSectionH = 0;
    if (autoBets.length) {
      autoSectionH = autoBetStyle === 'card'
        ? fcardGap + cardHeightFor(autoBets.length)
        : 20 + autoBets.length * 22 + 6;
    }

    const H = gridBottom + (betStatus ? betStatusGap + betStatusH : 0) + parlaySectionH + autoSectionH + 14;
    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // Backdrop
    {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0b0e16');
      g.addColorStop(1, '#04060c');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // ----- HEADER -----
    const chipX = padX, chipY = 18, chipS = 60;
    ctx.fillStyle = '#1a1d29';
    roundRect(ctx, chipX, chipY, chipS, chipS, 12);
    ctx.fill();
    ctx.strokeStyle = '#2a2e3d';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#cfd6ff';
    ctx.font = `900 30px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚔', chipX + chipS / 2, chipY + chipS / 2 + 2);

    const tx = padX + chipS + 14;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 28px ${FONT_STACK}`;
    ctx.fillText(title || 'MATCH DETECTED', tx, 52);

    if (subtitle) {
      const m = subtitle.match(/^(.*?)\s+on\s+(.*)$/);
      const baseY = 76;
      if (m) {
        const [, who, champ] = m;
        ctx.font = `15px ${FONT_STACK}`;
        ctx.fillStyle = '#cfd6ff';
        ctx.fillText(who, tx, baseY);
        const wWho = ctx.measureText(who).width;
        ctx.fillStyle = '#9aa3bd';
        ctx.fillText(' on ', tx + wWho, baseY);
        const wOn = ctx.measureText(' on ').width;
        ctx.font = `bold 15px ${FONT_STACK}`;
        ctx.fillStyle = '#5ad6ff';
        ctx.fillText(champ, tx + wWho + wOn, baseY);
      } else {
        ctx.font = `15px ${FONT_STACK}`;
        ctx.fillStyle = '#cfd6ff';
        ctx.fillText(subtitle, tx, baseY);
      }
    }

    if (gameMode) {
      ctx.font = `bold 13px ${FONT_STACK}`;
      const ptw = ctx.measureText(gameMode).width;
      const pW = ptw + 30;
      const pH = 30;
      const pXr = W - padX - pW;
      const pYr = 32;
      ctx.fillStyle = '#1a1d29';
      roundRect(ctx, pXr, pYr, pW, pH, pH / 2);
      ctx.fill();
      ctx.strokeStyle = '#2a2e3d';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#cfd6ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(gameMode, pXr + pW / 2, pYr + pH / 2 + 0.5);
    }

    // ----- TEAM PANEL -----
    async function drawTeamPanel({ team, py, label, color, bans }) {
      ctx.fillStyle = '#0e121c';
      roundRect(ctx, padX, py, panelW, panelH, 14);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1.5;
      roundRect(ctx, padX + 0.75, py + 0.75, panelW - 1.5, panelH - 1.5, 13.5);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(padX + 20, py + 0.5);
      ctx.lineTo(padX + panelW - 20, py + 0.5);
      ctx.stroke();
      ctx.restore();

      const hdrY = py + 8;
      const labelX = padX + panelInnerPadX + 4;
      const labelY = hdrY + 18;
      ctx.font = `900 14px ${FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('◆', labelX, labelY);
      const flagW = ctx.measureText('◆').width;
      ctx.fillText(label, labelX + flagW + 8, labelY);
      const labelEnd = labelX + flagW + 8 + ctx.measureText(label).width;

      const banSize = 24;
      const banGap = 4;
      const banCount = Math.min((bans || []).length, 5);
      const bansW = banCount > 0 ? (banCount * (banSize + banGap) - banGap) : 0;
      const bansX = padX + panelW - panelInnerPadX - bansW;
      const lineEndX = banCount > 0 ? bansX - 10 : padX + panelW - panelInnerPadX;

      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(labelEnd + 10, labelY - 4);
      ctx.lineTo(lineEndX, labelY - 4);
      ctx.stroke();
      ctx.restore();

      for (let i = 0; i < banCount; i++) {
        const bx = bansX + i * (banSize + banGap);
        const by = hdrY + (panelHdrH - 8 - banSize) / 2;
        ctx.fillStyle = '#1a1d29';
        roundRect(ctx, bx, by, banSize, banSize, 5);
        ctx.fill();
        const champId = bans[i];
        if (champId != null && champId !== -1) {
          const internalId = getChampionInternalId(champId);
          const icon = internalId ? await getChampionIcon(internalId) : null;
          if (icon) {
            ctx.save();
            ctx.beginPath();
            roundRect(ctx, bx + 1, by + 1, banSize - 2, banSize - 2, 4);
            ctx.clip();
            ctx.globalAlpha = 0.55;
            ctx.drawImage(icon, bx + 1, by + 1, banSize - 2, banSize - 2);
            ctx.restore();
          }
        }
        ctx.strokeStyle = '#e74c3c';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(bx + 3, by + banSize - 3);
        ctx.lineTo(bx + banSize - 3, by + 3);
        ctx.stroke();
      }

      const cardsY = py + panelHdrH;
      const cardsX0 = padX + panelInnerPadX;
      for (let i = 0; i < team.length; i++) {
        const p = team[i];
        const cardX = cardsX0 + i * (cardW + cardGap);
        const cardY = cardsY;
        const isTracked = isTrackedPuuid(p.puuid);
        const tierColor = TIER_BAR_COLORS[p.tier] || '#7a8190';

        const cardBgGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
        cardBgGrad.addColorStop(0, '#171b27');
        cardBgGrad.addColorStop(1, '#0c1018');
        ctx.fillStyle = cardBgGrad;
        roundRect(ctx, cardX, cardY, cardW, cardH, 10);
        ctx.fill();

        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = isTracked ? 0.85 : 0.30;
        ctx.lineWidth = isTracked ? 1.8 : 1;
        roundRect(ctx, cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1, 10);
        ctx.stroke();
        ctx.restore();

        if (isTracked) {
          ctx.save();
          ctx.strokeStyle = PEAK_YELLOW;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 2;
          roundRect(ctx, cardX + 1.5, cardY + 1.5, cardW - 3, cardH - 3, 9);
          ctx.stroke();
          ctx.restore();
        }

        const avatarR = 40;
        const cx = cardX + cardW / 2;
        const cy = cardY + 16 + avatarR;

        const internalId = getChampionInternalId(p.championId);
        const icon = internalId ? await getChampionIcon(internalId) : null;

        ctx.save();
        const haloGrad = ctx.createRadialGradient(cx, cy, avatarR - 4, cx, cy, avatarR + 10);
        haloGrad.addColorStop(0, 'rgba(0,0,0,0)');
        haloGrad.addColorStop(0.6, hexWithAlpha(tierColor, 0.35));
        haloGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = haloGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, avatarR + 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, avatarR, 0, Math.PI * 2);
        ctx.clip();
        if (icon) {
          ctx.drawImage(icon, cx - avatarR, cy - avatarR, avatarR * 2, avatarR * 2);
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fillRect(cx - avatarR, cy - avatarR, avatarR * 2, avatarR * 2);
          ctx.fillStyle = '#aab';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `bold 12px ${FONT_STACK}`;
          ctx.fillText((getChampionName(p.championId) || '?').slice(0, 6), cx, cy);
        }
        ctx.restore();

        ctx.strokeStyle = isTracked ? PEAK_YELLOW : tierColor;
        ctx.lineWidth = isTracked ? 3 : 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, avatarR - 0.5, 0, Math.PI * 2);
        ctx.stroke();

        // Lane overlay top-right of the avatar — same icon for tracked and
        // non-tracked players. The tracked player's highlight (gold avatar
        // ring + gold card border + gold italic name) is already enough
        // distinction; using a yellow background here would wash out the
        // white lane silhouette.
        const overlayCx = cx + avatarR - 4;
        const overlayCy = cy - avatarR + 4;
        const lane = LANE_BY_INDEX[i];
        const laneIcon = lane ? await getLaneIcon(lane) : null;
        if (laneIcon) {
          ctx.save();
          ctx.fillStyle = 'rgba(15,17,25,0.85)';
          ctx.beginPath();
          ctx.arc(overlayCx, overlayCy, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.drawImage(laneIcon, overlayCx - 9, overlayCy - 9, 18, 18);
          ctx.restore();
        }

        const display = labelFor(p);
        const nameY = cy + avatarR + 22;
        ctx.fillStyle = isTracked ? PEAK_YELLOW : '#ffffff';
        ctx.font = `${isTracked ? 'italic ' : ''}800 16px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const maxNameW = cardW - 18;
        ctx.fillText(fitText(ctx, display, maxNameW), cx, nameY);

        const pillTxt = formatRankShort(p.tier, p.rank, p.lp);
        if (pillTxt) {
          ctx.font = `bold 13px ${FONT_STACK}`;
          // Mini-crest variant (80×80 square crops Riot ships) — already
          // tightly cropped to the crest itself, so it stays crisp inside
          // the small pill icon slot. Emerald falls back internally to the
          // big wing emblem since Riot didn't ship a mini-crest for it.
          const emblem = p.tier ? await getRankMiniCrest(p.tier) : null;
          const isWingFallback = !!emblem && (emblem.width >= 500 || emblem.height >= 500);
          const txtW = ctx.measureText(pillTxt).width;
          const emblemSize = 22;
          const pillPad = 10;
          const pillW = txtW + (emblem ? emblemSize + 6 : 0) + pillPad;
          const pillH = 30;
          const pillX = cx - pillW / 2;
          const pillY = cardY + cardH - pillH - 10;

          ctx.fillStyle = '#1a1f2b';
          roundRect(ctx, pillX, pillY, pillW, pillH, 6);
          ctx.fill();
          ctx.save();
          ctx.strokeStyle = tierColor;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1;
          roundRect(ctx, pillX + 0.5, pillY + 0.5, pillW - 1, pillH - 1, 6);
          ctx.stroke();
          ctx.restore();

          let textX = pillX + pillPad / 2;
          if (emblem) {
            const emY = pillY + (pillH - emblemSize) / 2;
            if (isWingFallback) {
              // Emerald (wing-emblem fallback): source-crop the centered
              // crest area before downscaling so the wing doesn't squish.
              const sCrop = Math.min(emblem.width, emblem.height) * 0.85;
              const sx = (emblem.width - sCrop) / 2;
              const sy = (emblem.height - sCrop) / 2;
              ctx.drawImage(emblem, sx, sy, sCrop, sCrop, pillX + 4, emY, emblemSize, emblemSize);
            } else {
              // Mini-crest: already pre-cropped, draw straight.
              ctx.drawImage(emblem, pillX + 4, emY, emblemSize, emblemSize);
            }
            textX = pillX + 4 + emblemSize + 4;
          }
          ctx.fillStyle = tierColor;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(pillTxt, textX, pillY + pillH / 2 + 1);
        }
      }
    }

    await drawTeamPanel({ team: blueTeam, py: blueY, label: 'BLUE TEAM', color: '#5DADE2', bans: blueBans });
    await drawTeamPanel({ team: redTeam, py: redY, label: 'RED TEAM', color: '#e74c3c', bans: redBans });

    // VS diamond between the two panels
    {
      const cx = W / 2;
      const cy = blueY + panelH + teamGap / 2;
      const r = 18;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#1a1d29';
      ctx.strokeStyle = '#3a3f55';
      ctx.lineWidth = 1.2;
      roundRect(ctx, -r, -r, r * 2, r * 2, 4);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#cfd6ff';
      ctx.font = `900 13px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('VS', cx, cy + 1);
    }

    // ----- FOOTER (parlay + auto-bets) -----
    const drawCard = (cardY, headerText, lines, accent = '#f0b232', lineFont = `14px ${FONT_STACK}`) => {
      const ch = cardHeightFor(lines.length);
      ctx.fillStyle = '#1e1f22';
      roundRect(ctx, padX, cardY, W - padX * 2, ch, 10);
      ctx.fill();
      ctx.fillStyle = accent;
      roundRect(ctx, padX, cardY, 4, ch, 2);
      ctx.fill();
      const innerX = padX + 16;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = accent;
      ctx.font = `bold 11px ${FONT_STACK}`;
      ctx.fillText(headerText, innerX, cardY + 16);
      let ly = cardY + 24;
      ctx.font = lineFont;
      for (const line of lines) {
        ctx.fillStyle = '#fff';
        ctx.fillText(line, innerX, ly + 14);
        ly += 22;
      }
      return ch;
    };

    // ----- BET-STATUS BANNER -----
    if (betStatus) {
      const bx = padX;
      const by = betStatusY;
      const bw = W - padX * 2;
      const bh = betStatusH;
      const isOpen = betStatus.kind === 'open';
      const accent = isOpen ? '#f0b232' : '#7a8190';

      ctx.fillStyle = isOpen ? '#1f1a0c' : '#161821';
      roundRect(ctx, bx, by, bw, bh, 10);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.globalAlpha = isOpen ? 0.7 : 0.45;
      ctx.lineWidth = 1.2;
      roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, 10);
      ctx.stroke();
      ctx.restore();
      // Left accent bar
      ctx.fillStyle = accent;
      roundRect(ctx, bx, by, 4, bh, 2);
      ctx.fill();

      const text = isOpen
        ? `⏰  BETS CLOSE IN ${betStatus.minutes} MIN  ·  WIN ${betStatus.winMult}×  ·  LOSE ${betStatus.loseMult}×`
        : `🔒  BETTING CLOSED${betStatus.playerName ? `  ·  ${betStatus.playerName.toUpperCase()}` : ''}`;
      ctx.fillStyle = isOpen ? '#f6cf6a' : '#cfd6ff';
      ctx.font = `900 16px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + bw / 2, by + bh / 2 + 1);
    }

    let fy = gridBottom + (betStatus ? betStatusGap + betStatusH : 0);
    if (parlay) {
      fy += fcardGap;
      drawCard(fy, parlay.label, [parlay.legs], '#a974ff', `13px ${FONT_STACK}`);
      fy += cardHeightFor(1);
    }
    if (autoBets.length) {
      if (autoBetStyle === 'card') {
        fy += fcardGap;
        drawCard(fy, 'AUTO-BETS 🤖', autoBets);
        fy += cardHeightFor(autoBets.length);
      } else {
        let ay = fy + 4;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#80848e';
        ctx.font = `bold 11px ${FONT_STACK}`;
        ctx.fillText('AUTO-BETS 🤖', padX, ay + 11);
        ay += 20;
        ctx.font = `14px ${FONT_STACK}`;
        for (const line of autoBets) {
          ctx.fillStyle = '#fff';
          ctx.fillText(line, padX, ay + 14);
          ay += 22;
        }
      }
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: match-detected cards render failed');
    return null;
  }
}

// Lane-aligned team composite for Match Detected — two team panels, each with
// a header (BLUE/RED label + bans), and 5 player cards (champion icon w/ tier
// glow, lane icon overlay, name, tier+LP pill). Tracked player is highlighted
// with a gold ring + crown + italic gold name.
//
// Expects `blueTeam` and `redTeam` already ordered TOP → JUNGLE → MID → BOT → SUP.
export async function renderTeamsCompositePng(opts = {}) {
  const {
    blueTeam = [],
    redTeam = [],
    trackedPuuid = null,
    trackedPuuids = null,  // array form for duos; falls back to [trackedPuuid] when null
    getChampionInternalId, // (championId) => internal-id string (Data Dragon URL slug)
    getChampionName,       // (championId) => display name
    getLabel,              // optional (participant) => label string; defaults to champion name
    title = null,          // header title (e.g. 'MATCH DETECTED')
    subtitle = null,       // header subtitle (e.g. 'Nivy on Pyke')
    side = null,           // 'Blue' | 'Red'
    sideColor = '#5DADE2', // CSS hex for the accent strip + side pill
    avgRank = null,        // plain text (no Discord custom emoji)
    gameMode = null,       // queue/game-mode name shown in the corner pill
    autoBets = [],         // array of already-resolved plain strings
    parlay = null,         // { label, legs } — rendered as a card above auto-bets
    blueBans = [],         // array of champion IDs banned by blue team (in pick order)
    redBans = [],          // array of champion IDs banned by red team
    teamLabels = false,    // BLUE/RED panel layout (mockup style)
    autoBetStyle = 'plain',// 'plain' | 'card' (separated auto-bet card)
  } = opts;

  if (!blueTeam.length || !redTeam.length || !getChampionInternalId || !getChampionName) return null;

  const labelFor = (p) => (getLabel ? getLabel(p) : getChampionName(p.championId)) || getChampionName(p.championId) || '?';

  // New "card panel" layout (matches the Match Detected mockup): two glowing
  // team panels with player cards inside, plus the existing parlay/auto-bet
  // footer cards. Driven by `teamLabels: true` from the poller.
  if (teamLabels) {
    const highlightSet = new Set(
      (trackedPuuids && trackedPuuids.length ? trackedPuuids : [trackedPuuid]).filter(Boolean)
    );
    return renderMatchDetectedCards({
      blueTeam, redTeam, highlightSet, labelFor,
      getChampionInternalId, getChampionName,
      title, subtitle, gameMode,
      blueBans, redBans,
      parlay, autoBets, autoBetStyle,
      betStatus: opts.betStatus || null,
    });
  }

  try {
    const SCALE = 2;                       // supersample for a crisp hi-res PNG
    const iconSize = 84;                   // champion icon diameter
    const iconR = iconSize / 2;
    const ringW = 3;                       // tier-colored outline thickness
    const lpBubbleH = 20;                  // LP pill height
    const lpBubbleTopRel = iconSize + 24;  // LP pill top, relative to row's top
    const labelH = 46;                     // room for name + LP bubble (two lines)
    const cellH = iconSize + 5 + labelH;
    const gap = 14;
    const padX = 18;
    const padY = 18;
    const vsBandH = 30;
    const hasHeader = !!(title || subtitle || side || avgRank || gameMode);
    const headerH = hasHeader ? 52 : padY;

    // Team row layout. With `teamLabels`, each team gets a BLUE/RED header and
    // the VS pill is dropped; otherwise the original VS-divider layout is used.
    const teamLabelH = teamLabels ? 24 : 0;
    const sepGap = 8;
    const blueRowY = headerH + teamLabelH;
    const redRowY = teamLabels
      ? blueRowY + cellH + sepGap + teamLabelH
      : headerH + cellH + vsBandH;
    const gridBottom = redRowY + cellH;

    // Footer cards (parlay, auto-bets). Each card: header row + N lines + pad.
    const cardGap = 10;
    const cardHeightFor = (n) => 24 + n * 22 + 12;
    const parlaySectionH = parlay ? (cardGap + cardHeightFor(1)) : 0;
    let autoSectionH = 0;
    if (autoBets.length) {
      autoSectionH = autoBetStyle === 'card'
        ? cardGap + cardHeightFor(autoBets.length)
        : 20 + autoBets.length * 22 + 6;
    }

    const W = padX * 2 + iconSize * 5 + gap * 4;
    const H = gridBottom + parlaySectionH + autoSectionH + 14;

    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);               // draw in logical units; output is 2×
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // Header: accent strip + title/subtitle (left) + side · avg-rank pill (right)
    if (hasHeader) {
      ctx.fillStyle = sideColor;
      ctx.fillRect(0, 0, W, 4);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      if (title) {
        ctx.fillStyle = '#fff';
        ctx.font = `800 22px ${FONT_STACK}`;
        ctx.fillText(title, padX, subtitle ? 28 : 34);
      }
      if (subtitle) {
        ctx.fillStyle = '#b5bac1';
        ctx.font = `13px ${FONT_STACK}`;
        ctx.fillText(subtitle, padX, 45);
      }
      // Corner pill: with team labels it shows the game mode (neutral); without,
      // it shows side · avg rank in the side color.
      const pillText = teamLabels
        ? (gameMode || null)
        : [side ? `${side.toUpperCase()} SIDE` : null, avgRank].filter(Boolean).join(' · ') || null;
      if (pillText) {
        ctx.font = `bold 13px ${FONT_STACK}`;
        const ptw = ctx.measureText(pillText).width;
        const pW = ptw + 22;
        const pH = 26;
        const pXr = W - padX - pW;
        const pYr = 13;
        ctx.fillStyle = teamLabels ? '#4e5058' : sideColor;
        roundRect(ctx, pXr, pYr, pW, pH, pH / 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pillText, pXr + pW / 2, pYr + pH / 2 + 1);
      }
    }

    async function drawRow(team, rowY) {
      for (let i = 0; i < team.length; i++) {
        const p = team[i];
        const cx = padX + i * (iconSize + gap) + iconR;
        const cy = rowY + iconR;
        const internalId = getChampionInternalId(p.championId);
        const isTracked = p.puuid === trackedPuuid;

        const icon = internalId ? await getChampionIcon(internalId) : null;

        // Champion icon clipped to a circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, iconR, 0, Math.PI * 2);
        ctx.clip();
        if (icon) {
          ctx.drawImage(icon, cx - iconR, cy - iconR, iconSize, iconSize);
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(cx - iconR, cy - iconR, iconSize, iconSize);
          ctx.fillStyle = '#aab';
          ctx.font = `bold 11px ${FONT_STACK}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const name = getChampionName(p.championId) || '?';
          ctx.fillText(name.slice(0, 6), cx, cy);
        }
        ctx.restore();

        // Outline ring always shows the player's tier color (unranked → grey),
        // so the tracked player still reads as their actual rank.
        ctx.strokeStyle = TIER_BAR_COLORS[p.tier] || '#888';
        ctx.lineWidth = ringW;
        ctx.beginPath();
        ctx.arc(cx, cy, iconR - ringW / 2, 0, Math.PI * 2);
        ctx.stroke();

        // Label (summoner name when known, else champion name). The tracked
        // player is highlighted with a yellow italic name.
        const display = labelFor(p);
        const short = display.length > 12 ? display.slice(0, 11) + '…' : display;
        const nameY = rowY + iconSize + 6;
        ctx.fillStyle = isTracked ? PEAK_YELLOW : '#fff';
        ctx.font = `${isTracked ? 'italic ' : ''}bold 13px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(short, cx, nameY);

        // LP bubble under the name: tier-colored pill with white text so it pops.
        const lpTag = formatRankShort(p.tier, p.rank, p.lp);
        if (lpTag) {
          ctx.font = `bold 13px ${FONT_STACK}`;
          const tw = ctx.measureText(lpTag).width;
          const bw = tw + 16;
          const bh = lpBubbleH;
          const bx = cx - bw / 2;
          const byy = rowY + lpBubbleTopRel;
          ctx.fillStyle = TIER_BAR_COLORS[p.tier] || '#555';
          roundRect(ctx, bx, byy, bw, bh, bh / 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(lpTag, cx, byy + bh / 2 + 0.5);
        }
      }
    }

    // Change 1: per-team BLUE/RED labels with a divider line to the right.
    // When bans are present, render 5 dimmed champion icons with a red slash
    // on the right side of the label row.
    const drawTeamLabel = async (text, color, labelTopY, bans = []) => {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `800 14px ${FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.fillText(text, padX, labelTopY + 14);
      const tw = ctx.measureText(text).width;

      // Reserve space on the right for up to 5 ban icons.
      const banSize = 22;
      const banGap = 4;
      const banCount = Math.min(bans.length, 5);
      const bansW = banCount > 0 ? (banCount * (banSize + banGap) - banGap) : 0;
      const bansX = W - padX - bansW;
      const lineEndX = banCount > 0 ? bansX - 10 : (W - padX);

      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padX + tw + 10, labelTopY + 9);
      ctx.lineTo(lineEndX, labelTopY + 9);
      ctx.stroke();
      ctx.restore();

      for (let i = 0; i < banCount; i++) {
        const champId = bans[i];
        const bx = bansX + i * (banSize + banGap);
        const by = labelTopY + 9 - banSize / 2;

        // Background tile (in case the icon doesn't load or champ wasn't banned)
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(bx, by, banSize, banSize);

        if (champId != null && champId !== -1) {
          const internalId = getChampionInternalId(champId);
          const icon = internalId ? await getChampionIcon(internalId) : null;
          if (icon) {
            ctx.save();
            ctx.globalAlpha = 0.55; // dim banned icons
            ctx.drawImage(icon, bx, by, banSize, banSize);
            ctx.restore();
          }
        }

        // Red diagonal slash to mark "banned"
        ctx.strokeStyle = '#e74c3c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx + 2, by + banSize - 2);
        ctx.lineTo(bx + banSize - 2, by + 2);
        ctx.stroke();
      }
    };

    if (teamLabels) {
      await drawTeamLabel('BLUE', '#5DADE2', headerH, blueBans);
      await drawTeamLabel('RED', '#e74c3c', redRowY - teamLabelH, redBans);
    }

    await drawRow(blueTeam, blueRowY);
    await drawRow(redTeam, redRowY);

    // Original VS divider + pill (only when team labels are off).
    if (!teamLabels) {
      const vsCenterX = W / 2;
      const row1BubbleBottom = headerH + lpBubbleTopRel + lpBubbleH;
      const row2IconTop = headerH + cellH + vsBandH;
      const vsCenterY = (row1BubbleBottom + row2IconTop) / 2;

      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padX, vsCenterY);
      ctx.lineTo(W - padX, vsCenterY);
      ctx.stroke();

      ctx.font = `bold 14px ${FONT_STACK}`;
      const vsText = 'VS';
      const tw = ctx.measureText(vsText).width;
      const pillW = tw + 18;
      const pillH = 22;

      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      roundRect(ctx, vsCenterX - pillW / 2 - 1, vsCenterY - pillH / 2 + 1, pillW + 2, pillH + 2, pillH / 2 + 1);
      ctx.fill();
      ctx.fillStyle = '#e74c3c';
      roundRect(ctx, vsCenterX - pillW / 2, vsCenterY - pillH / 2, pillW, pillH, pillH / 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(vsText, vsCenterX, vsCenterY + 1);
    }

    // Footer cards below the grid. A card = dark rounded rect + gold accent bar
    // + bold header + one or more white lines. `lineFont` lets the parlay legs
    // use a smaller font so a long leg list still fits.
    const drawCard = (cardY, headerText, lines, accent = '#f0b232', lineFont = `14px ${FONT_STACK}`) => {
      const cardH2 = cardHeightFor(lines.length);
      ctx.fillStyle = '#1e1f22';
      roundRect(ctx, padX, cardY, W - padX * 2, cardH2, 10);
      ctx.fill();
      ctx.fillStyle = accent;
      roundRect(ctx, padX, cardY, 4, cardH2, 2);
      ctx.fill();
      const innerX = padX + 16;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = accent;
      ctx.font = `bold 11px ${FONT_STACK}`;
      ctx.fillText(headerText, innerX, cardY + 16);
      let ly = cardY + 24;
      ctx.font = lineFont;
      for (const line of lines) {
        ctx.fillStyle = '#fff';
        ctx.fillText(line, innerX, ly + 14);
        ly += 22;
      }
      return cardH2;
    };

    let fy = gridBottom;

    if (parlay) {
      fy += cardGap;
      drawCard(fy, parlay.label, [parlay.legs], '#a974ff', `13px ${FONT_STACK}`);
      fy += cardHeightFor(1);
    }

    if (autoBets.length) {
      if (autoBetStyle === 'card') {
        fy += cardGap;
        drawCard(fy, 'AUTO-BETS 🤖', autoBets);
        fy += cardHeightFor(autoBets.length);
      } else {
        let ay = fy + 4;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#80848e';
        ctx.font = `bold 11px ${FONT_STACK}`;
        ctx.fillText('AUTO-BETS 🤖', padX, ay + 11);
        ay += 20;
        ctx.font = `14px ${FONT_STACK}`;
        for (const line of autoBets) {
          ctx.fillStyle = '#fff';
          ctx.fillText(line, padX, ay + 14);
          ay += 22;
        }
      }
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: teams composite render failed');
    return null;
  }
}

// Splash-art Match Over: single-player variant where the champion's loading-
// screen splash fills the player card (faded behind a left-side gradient so
// the stats stay legible), then BETS SETTLED / PARLAY / ACHIEVEMENTS /
// GOLD GRAPH render as separate cards below.
async function renderMatchOverSplashPng({
  won, durationStr, players,
  getChampionInternalId,
  bets, parlay, achievements,
  lead, objectives, kills,
}) {
  const WIN = '#3ba55d';
  const LOSE = '#ed4245';
  const WHITE = '#ffffff';
  const GREY = '#b5bac1';
  const SUBTLE = '#80848e';
  // Header chip + outer accents follow the primary tracked player's W/L —
  // matches the existing splash card behavior. Duo on a split team is an
  // edge case (each card still recolors itself per-player below).
  const accent = won ? WIN : LOSE;
  if (!Array.isArray(players) || !players.length) return null;

  try {
    const SCALE = 2;
    const W = 760;
    const padX = 18;

    // ── Pre-render the gold chart so we know its dimensions for layout ─────
    // Pass bg + title='' so it blends into the dark splash card and doesn't
    // duplicate the "GOLD GRAPH" widget label rendered by the outer card.
    let goldImg = null;
    if (lead && lead.length > 0) {
      try {
        const buf = await renderGoldLeadPng(lead, {
          objectives, kills,
          title: '',
          bg: '#10141d',
        });
        if (buf) goldImg = await loadImage(buf);
      } catch (err) {
        logger.warn({ err: err.message }, 'matchGraph: gold chart render failed inside match-over');
      }
    }
    const chartInnerW = W - padX * 2 - 24;
    const chartH = goldImg ? Math.round(goldImg.height * (chartInnerW / goldImg.width)) : 0;

    // ── Section heights ────────────────────────────────────────────────────
    const headerH = 84;
    // Each tracked player gets their own splash card; duo = 2 cards stacked.
    const playerCardH = 220;
    const playerCardGap = 12;
    const playersBlockH = players.length * playerCardH + Math.max(0, players.length - 1) * playerCardGap;
    const sectionGap = 12;

    const lineH = 26;
    // Cards: label sits ~22px from card-top; row cards need extra clearance
    // so the structured icon box doesn't overlap header text. The chart card
    // doesn't have rows — it can hug the header much tighter, saving the
    // ~20px of empty band that otherwise sits above the chart.
    const cardHeaderH = 50;
    const chartHeaderH = 30;
    const cardBodyPad = 12;
    const computeCardH = (rowCount) => rowCount > 0 ? (cardHeaderH + rowCount * lineH + cardBodyPad) : 0;

    const betsH = computeCardH(bets.length);
    const parlayH = computeCardH(parlay.length);
    const chartCardH = goldImg ? (chartHeaderH + chartH + cardBodyPad) : 0;

    const sectionsTotal = [betsH, parlayH, chartCardH].filter(h => h > 0).length;
    const totalGapAfterSections = sectionsTotal * sectionGap;

    const padBottom = 16;
    const H = headerH + sectionGap + playersBlockH + totalGapAfterSections + betsH + parlayH + chartCardH + padBottom;

    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // Backdrop
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#0c0f17');
    bgGrad.addColorStop(1, '#06080d');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // ── HEADER ─────────────────────────────────────────────────────────────
    // Accent bar on the very left
    ctx.fillStyle = accent;
    roundRect(ctx, 0, 16, 6, 52, 3);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = WHITE;
    ctx.font = `900 42px ${FONT_STACK}`;
    ctx.fillText('MATCH OVER', padX + 12, 58);

    // Victory / Defeat chip + duration
    {
      const chipText = won ? 'VICTORY' : 'DEFEAT';
      const chipIcon = won ? '✓' : '✕';
      ctx.font = `900 20px ${FONT_STACK}`;
      const ctw = ctx.measureText(chipText).width;
      const chipPadX = 18;
      const chipW = ctw + chipPadX * 2 + 24;
      const chipH = 44;
      ctx.font = `14px ${FONT_STACK}`;
      const durW = ctx.measureText(durationStr).width;
      const groupW = chipW + 14 + durW;
      const groupX = W - padX - groupW;
      const chipX = groupX;
      const chipY = 20;

      ctx.fillStyle = hexWithAlpha(accent, 0.18);
      roundRect(ctx, chipX, chipY, chipW, chipH, 10);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.3;
      roundRect(ctx, chipX + 0.5, chipY + 0.5, chipW - 1, chipH - 1, 10);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = accent;
      ctx.font = `900 20px ${FONT_STACK}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(chipIcon, chipX + chipPadX, chipY + chipH / 2);
      ctx.fillText(chipText, chipX + chipPadX + 22, chipY + chipH / 2);

      ctx.fillStyle = SUBTLE;
      ctx.font = `bold 18px ${FONT_STACK}`;
      ctx.fillText(durationStr, chipX + chipW + 14, chipY + chipH / 2);
    }

    // ── PLAYER CARDS ──────────────────────────────────────────────────────
    // One splash card per tracked player. Each card pulls its own win/lose
    // from `player.won` so a split-team duo still colors per-player correctly.
    const playerCardY = headerH + sectionGap;
    const playerCardW = W - padX * 2;
    for (let pi = 0; pi < players.length; pi++) {
      const cardY = playerCardY + pi * (playerCardH + playerCardGap);
      const playerObj = players[pi];
      const playerWon = playerObj.won !== undefined ? playerObj.won : won;
      const playerAccent = playerWon ? WIN : LOSE;
      await drawPlayerSplashCard({
        ctx, x: padX, y: cardY, w: playerCardW, h: playerCardH,
        player: playerObj, accent: playerAccent, won: playerWon,
        getChampionInternalId, WIN, LOSE,
      });
    }

    // ── HELPERS: card rendering ────────────────────────────────────────────
    const drawCard = (y, h, label, accentColor) => {
      const cardW = W - padX * 2;
      ctx.fillStyle = '#10141d';
      roundRect(ctx, padX, y, cardW, h, 12);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = accentColor;
      ctx.globalAlpha = 0.30;
      ctx.lineWidth = 1.2;
      roundRect(ctx, padX + 0.5, y + 0.5, cardW - 1, h - 1, 12);
      ctx.stroke();
      ctx.restore();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = accentColor;
      ctx.font = `bold 13px ${FONT_STACK}`;
      ctx.fillText(label, padX + 16, y + 22);
    };

    const drawSettledRow = (lineY, text) => {
      // Poller-formatted lines start with ✅ or ❌. The two emojis have very
      // different widths/baselines depending on the host font, which makes
      // multiple rows look misaligned. Strip the leading status emoji and
      // draw a structured icon (small filled square + glyph) at a fixed x
      // position so every row's icon column AND text column line up.
      const stripped = text.replace(/^(?:✅|❌)\s*/, '');
      const correct = text.startsWith('✅');

      const iconX = padX + 20;
      const iconSize = 18;
      const iconY = lineY - 8 - iconSize / 2;
      ctx.fillStyle = correct ? hexWithAlpha(WIN, 0.22) : hexWithAlpha(LOSE, 0.22);
      roundRect(ctx, iconX, iconY, iconSize, iconSize, 4);
      ctx.fill();
      ctx.fillStyle = correct ? WIN : LOSE;
      ctx.font = `bold 13px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(correct ? '✓' : '✕', iconX + iconSize / 2, iconY + iconSize / 2 + 1);

      ctx.fillStyle = WHITE;
      ctx.font = `15px ${FONT_STACK}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(stripped, iconX + iconSize + 10, lineY - 8);
    };

    let cy = playerCardY + playersBlockH + sectionGap;

    if (bets.length) {
      drawCard(cy, betsH, '🏛  BETS SETTLED', '#cfd6ff');
      let lineY = cy + cardHeaderH + 4;
      for (const b of bets) {
        drawSettledRow(lineY, b);
        lineY += lineH;
      }
      cy += betsH + sectionGap;
    }

    if (parlay.length) {
      drawCard(cy, parlayH, '🎰  PARLAY', '#a974ff');
      let lineY = cy + cardHeaderH + 4;
      for (const p of parlay) {
        ctx.fillStyle = WHITE;
        ctx.font = `15px ${FONT_STACK}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(p, padX + 20, lineY - 8);
        lineY += lineH;
      }
      cy += parlayH + sectionGap;
    }

    // Achievements section intentionally omitted from the image — the poller
    // still surfaces achievements through other channels but they never get
    // drawn into the Match Over splash recap.

    if (goldImg) {
      drawCard(cy, chartCardH, '🪙  GOLD GRAPH', '#f0b232');
      const chartX = padX + 12;
      const chartY = cy + chartHeaderH;
      ctx.save();
      roundRect(ctx, chartX, chartY, chartInnerW, chartH, 8);
      ctx.clip();
      ctx.drawImage(goldImg, chartX, chartY, chartInnerW, chartH);
      ctx.restore();
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: match-over splash render failed');
    return null;
  }
}

// Draws the single-player splash-art card inside the Match Over recap.
// Splash art fills the right portion of the card, faded behind a dark
// gradient on the left so stats stay readable. Avatar + name + KDA + stat
// row sit on the left; "Today record" + lane indicator sit top-right.
async function drawPlayerSplashCard({ ctx, x, y, w, h, player, accent, won, getChampionInternalId, WIN, LOSE }) {
  const WHITE = '#ffffff';
  const GREY = '#b5bac1';
  const SUBTLE = '#80848e';
  const internalId = getChampionInternalId ? getChampionInternalId(player.championId) : null;

  // Card base (dark)
  ctx.fillStyle = '#10141d';
  roundRect(ctx, x, y, w, h, 14);
  ctx.fill();

  // Splash art behind everything, clipped to the card. Cover-fit so it fills
  // the card without distortion, then a left-side gradient fades it out so
  // the avatar/name/stats remain readable on top of solid dark.
  ctx.save();
  roundRect(ctx, x, y, w, h, 14);
  ctx.clip();

  const splash = internalId ? await getChampionSplash(internalId) : null;
  if (splash) {
    // Center-fit cover. The centered splash variant from Community Dragon
    // puts the champion's face in the middle of the frame, so a straight
    // cover-fit (no left/right bias) reliably shows the head every time.
    const splashAR = splash.width / splash.height;
    const cardAR = w / h;
    let sw, sh, sx, sy;
    if (splashAR > cardAR) {
      sh = h;
      sw = sh * splashAR;
      sx = x - (sw - w) / 2;
      sy = y;
    } else {
      sw = w;
      sh = sw / splashAR;
      sx = x;
      sy = y - (sh - h) / 2;
    }
    ctx.globalAlpha = 0.55;
    ctx.drawImage(splash, sx, sy, sw, sh);
    ctx.globalAlpha = 1;
  }

  // Left-side darkening gradient — opaque on the left, fades to transparent
  // around the 70% mark so the right side stays mostly splash.
  const leftGrad = ctx.createLinearGradient(x, y, x + w, y);
  leftGrad.addColorStop(0,    'rgba(16,20,29,0.95)');
  leftGrad.addColorStop(0.45, 'rgba(16,20,29,0.65)');
  leftGrad.addColorStop(1,    'rgba(16,20,29,0.20)');
  ctx.fillStyle = leftGrad;
  ctx.fillRect(x, y, w, h);

  ctx.restore();

  // Card outline (accent color, faint)
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.40;
  ctx.lineWidth = 1.4;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14);
  ctx.stroke();
  ctx.restore();

  // ── Avatar ───────────────────────────────────────────────────────────────
  const avatarR = 50;
  const avatarCx = x + 30 + avatarR;
  const avatarCy = y + h / 2;
  const icon = internalId ? await getChampionIcon(internalId) : null;

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCx, avatarCy, avatarR, 0, Math.PI * 2);
  ctx.clip();
  if (icon) {
    ctx.drawImage(icon, avatarCx - avatarR, avatarCy - avatarR, avatarR * 2, avatarR * 2);
  } else {
    ctx.fillStyle = '#2a2e38';
    ctx.fillRect(avatarCx - avatarR, avatarCy - avatarR, avatarR * 2, avatarR * 2);
  }
  ctx.restore();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(avatarCx, avatarCy, avatarR - 1, 0, Math.PI * 2);
  ctx.stroke();

  // ── Name + champion subtitle ────────────────────────────────────────────
  const tx = avatarCx + avatarR + 24;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = WHITE;
  ctx.font = `900 30px ${FONT_STACK}`;
  ctx.fillText(player.name, tx, y + 50);

  // Champion subtitle line — use the champion icon as a tiny inline marker
  if (icon) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(tx + 10, y + 70, 9, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(icon, tx + 1, y + 61, 18, 18);
    ctx.restore();
  }
  ctx.fillStyle = GREY;
  ctx.font = `15px ${FONT_STACK}`;
  ctx.fillText(player.champName || '', tx + 26, y + 75);

  // ── KDA big ──────────────────────────────────────────────────────────────
  const kdaY = y + 122;
  ctx.font = `900 44px ${FONT_STACK}`;
  const kStr = String(player.k);
  const slash = ' / ';
  const dStr = String(player.d);
  const aStr = String(player.a);
  const wK = ctx.measureText(kStr).width;
  const wS = ctx.measureText(slash).width;
  const wD = ctx.measureText(dStr).width;
  let cx = tx;
  ctx.fillStyle = WIN;
  ctx.fillText(kStr, cx, kdaY);   cx += wK;
  ctx.fillStyle = SUBTLE;
  ctx.fillText(slash, cx, kdaY);  cx += wS;
  ctx.fillStyle = LOSE;
  ctx.fillText(dStr, cx, kdaY);   cx += wD;
  ctx.fillStyle = SUBTLE;
  ctx.fillText(slash, cx, kdaY);  cx += wS;
  ctx.fillStyle = '#5ad6ff';
  ctx.fillText(aStr, cx, kdaY);

  // "Perfect KDA" sub-label when no deaths
  if (player.d === 0) {
    ctx.fillStyle = WIN;
    ctx.font = `bold 14px ${FONT_STACK}`;
    ctx.fillText('Perfect KDA', tx, kdaY + 22);
  } else if (player.kda) {
    ctx.fillStyle = SUBTLE;
    ctx.font = `bold 14px ${FONT_STACK}`;
    ctx.fillText(`${player.kda} KDA`, tx, kdaY + 22);
  }

  // ── Stats row ────────────────────────────────────────────────────────────
  const statsY = y + h - 26;
  const drawStat = (sx, label, value) => {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = WHITE;
    ctx.font = `900 22px ${FONT_STACK}`;
    ctx.fillText(value, sx, statsY);
    const vw = ctx.measureText(value).width;
    ctx.fillStyle = SUBTLE;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.fillText(label, sx, statsY + 14);
    return vw;
  };

  let sx = tx;
  const w1 = drawStat(sx, 'CS', String(player.cs ?? '—'));
  sx += Math.max(w1, 40) + 36;
  const w2 = drawStat(sx, 'DMG', formatNumber(player.dmg));
  sx += Math.max(w2, 60) + 36;
  drawStat(sx, 'KP', player.kp != null ? `${player.kp}%` : '—');

  // ── Right side: today pill + lane indicator ─────────────────────────────
  const rx = x + w - 22;
  const total = (player.dailyW || 0) + (player.dailyL || 0);
  const flame = total > 0 && player.dailyW / total > 0.5 ? ' 🔥' : '';
  const todayText = `Today: ${player.dailyW || 0}W ${player.dailyL || 0}L${flame}`;

  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = GREY;
  ctx.font = `bold 14px ${FONT_STACK}`;
  ctx.fillText(todayText, rx, y + 38);

  // Lane indicator below
  if (player.wonLane != null) {
    const laneMargin = (typeof player.laneDiff === 'number')
      ? (() => { const ab = Math.abs(player.laneDiff); const s = player.laneDiff >= 0 ? '+' : '-'; return ` ${s}${ab >= 1000 ? (ab / 1000).toFixed(1) + 'k' : ab}`; })()
      : '';
    if (player.wonLane === true) {
      ctx.fillStyle = WIN;
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.fillText(`✓ Won Lane${laneMargin}`, rx, y + 62);
    } else if (player.wonLane === false) {
      ctx.fillStyle = LOSE;
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.fillText(`✕ Lost Lane${laneMargin}`, rx, y + 62);
    }
  }
}

function formatNumber(n) {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

// Full 10-player scoreboard panel for Match Over — meant to be attached
// alongside the splash recap so Discord lays them out side-by-side. Each
// row shows: champion icon, summoner name + champ name, K/D/A, CS, DMG,
// KP%, Gold, and the 7 item slots from the participant. The tracked
// player's row gets the gold-ring highlight used elsewhere.
//
// Inputs come straight from Match-V5 participants (no derived fields
// required) — caller passes the blue/red participant arrays and the
// puuid of the tracked player to highlight.
// Triple-bar "impact" chart — 10 player slots in two team-grouped clusters,
// each slot showing three small vertical bars: damage dealt to champions,
// CC score (timeCCingOthers in seconds), and vision score. All three bars
// are normalized to the lobby max for that metric, so the tallest bar in
// each color flags the leader. Designed to live in the bottom-right of the
// Match Over Discord message, next to the scoreboard above it.
export async function renderMatchOverImpactPng(opts = {}) {
  const {
    blueTeam = [],
    redTeam = [],
    trackedPuuid = null,
    getChampionInternalId,
    getChampionName,
  } = opts;

  if (!blueTeam.length || !redTeam.length || !getChampionInternalId) return null;

  const BLUE = '#5DADE2';
  const RED  = '#e74c3c';
  const WHITE = '#ffffff';
  const SUBTLE = '#80848e';

  // Bar colors — distinct hue per metric so all three read at a glance.
  const DMG_COLOR    = '#f0b232'; // amber — damage
  const CC_COLOR     = '#9b59b6'; // purple — control
  const VISION_COLOR = '#3cbec8'; // cyan — vision/wards

  try {
    const SCALE = 2;
    const W = 980;
    const padX = 20;

    const titleH    = 50;
    const legendH   = 32;
    const plotH     = 230;
    const footerH   = 80;  // champ icon + name + role
    const padBottom = 18;
    const H = titleH + legendH + plotH + footerH + padBottom;

    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // Backdrop
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0c0f17');
    bg.addColorStop(1, '#06080d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Title ──────────────────────────────────────────────────────────────
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = WHITE;
    ctx.font = `900 26px ${FONT_STACK}`;
    ctx.fillText('IMPACT', padX, 34);

    // Combined player list with team color + computed metrics
    const all = [
      ...blueTeam.map(p => ({ p, team: 'blue', color: BLUE })),
      ...redTeam.map (p => ({ p, team: 'red',  color: RED  })),
    ];
    const metricsFor = (p) => ({
      dmg:    p.totalDamageDealtToChampions || 0,
      cc:     Math.round(p.timeCCingOthers || 0),
      vision: p.visionScore || 0,
    });
    const stats = all.map(x => metricsFor(x.p));
    const dmgMax    = Math.max(1, ...stats.map(s => s.dmg));
    const ccMax     = Math.max(1, ...stats.map(s => s.cc));
    const visionMax = Math.max(1, ...stats.map(s => s.vision));
    const dmgLeader    = stats.findIndex(s => s.dmg    === dmgMax);
    const ccLeader     = stats.findIndex(s => s.cc     === ccMax);
    const visionLeader = stats.findIndex(s => s.vision === visionMax);

    // ── Legend ────────────────────────────────────────────────────────────
    {
      const y = titleH + 16;
      const pip = (lx, color, text) => {
        ctx.fillStyle = color;
        roundRect(ctx, lx, y - 8, 14, 14, 3);
        ctx.fill();
        ctx.fillStyle = WHITE;
        ctx.font = `bold 13px ${FONT_STACK}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(text, lx + 20, y - 1);
        return ctx.measureText(text).width + 20 + 18;
      };
      let lx = padX;
      lx += pip(lx, DMG_COLOR,    'Damage');
      lx += pip(lx, CC_COLOR,     'CC Score');
      lx += pip(lx, VISION_COLOR, 'Vision Score');
    }

    // ── Plot area ──────────────────────────────────────────────────────────
    const plotY = titleH + legendH;
    const usable = W - padX * 2;
    const teamGap = 28;
    const slotW = (usable - teamGap) / 10;
    const barW = 14;
    const barGap = 3;
    const triplet = barW * 3 + barGap * 2;
    const tripletInset = (slotW - triplet) / 2;
    const baseY = plotY + plotH - 6; // bars grow upward from this baseline
    const barMaxH = plotH - 22;       // leave room for value labels above

    // Subtle horizontal grid (4 ticks)
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gy = baseY - (barMaxH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padX, gy);
      ctx.lineTo(W - padX, gy);
      ctx.stroke();
    }

    // Team divider in the middle
    const dividerX = padX + 5 * slotW + teamGap / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dividerX, plotY);
    ctx.lineTo(dividerX, baseY + 12);
    ctx.stroke();

    // Team labels above the plot at the left/right edges
    ctx.font = `900 12px ${FONT_STACK}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = BLUE;
    ctx.textAlign = 'left';
    ctx.fillText('◆ BLUE', padX, plotY + 14);
    ctx.fillStyle = RED;
    ctx.textAlign = 'right';
    ctx.fillText('RED ◆', W - padX, plotY + 14);

    // ── Per-slot rendering ────────────────────────────────────────────────
    for (let i = 0; i < all.length; i++) {
      const { p, team, color } = all[i];
      const s = stats[i];
      const isTracked = p.puuid === trackedPuuid;

      // Slot X — blue 0..4 in left half, red 5..9 in right half (after gap)
      const teamIdx = team === 'blue' ? i : (i - 5);
      const slotX = padX + (team === 'blue' ? teamIdx * slotW : (5 * slotW + teamGap) + teamIdx * slotW);

      // Tracked-player accent — a soft gold column behind the bars
      if (isTracked) {
        ctx.fillStyle = 'rgba(240,178,50,0.10)';
        roundRect(ctx, slotX + 2, plotY + 6, slotW - 4, plotH + footerH - 16, 8);
        ctx.fill();
        ctx.save();
        ctx.strokeStyle = '#f0b232';
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.2;
        roundRect(ctx, slotX + 2.5, plotY + 6.5, slotW - 5, plotH + footerH - 17, 8);
        ctx.stroke();
        ctx.restore();
      }

      // Three bars
      const bars = [
        { val: s.dmg,    max: dmgMax,    color: DMG_COLOR,    isLeader: i === dmgLeader,    label: formatNumber(s.dmg) },
        { val: s.cc,     max: ccMax,     color: CC_COLOR,     isLeader: i === ccLeader,     label: String(s.cc) },
        { val: s.vision, max: visionMax, color: VISION_COLOR, isLeader: i === visionLeader, label: String(s.vision) },
      ];
      for (let b = 0; b < 3; b++) {
        const bar = bars[b];
        const bx = slotX + tripletInset + b * (barW + barGap);
        const frac = bar.val / bar.max;
        const bh = Math.max(2, frac * barMaxH);
        const by = baseY - bh;

        // Bar track (faint background)
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        roundRect(ctx, bx, baseY - barMaxH, barW, barMaxH, 2);
        ctx.fill();
        // Bar fill
        ctx.fillStyle = bar.color;
        roundRect(ctx, bx, by, barW, bh, 2);
        ctx.fill();
        // Leader marker — small gold downward triangle above the bar, drawn
        // as a path so we don't depend on the host font for glyphs. Sits
        // above the value label.
        if (bar.isLeader) {
          const cxArrow = bx + barW / 2;
          const tipY = by - 17;
          ctx.fillStyle = '#f0b232';
          ctx.beginPath();
          ctx.moveTo(cxArrow - 5, tipY - 7);
          ctx.lineTo(cxArrow + 5, tipY - 7);
          ctx.lineTo(cxArrow,     tipY);
          ctx.closePath();
          ctx.fill();
        }
        // Value label above the bar (small, faint)
        ctx.fillStyle = isTracked ? '#f0b232' : SUBTLE;
        ctx.font = `bold 9px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(bar.label, bx + barW / 2, by - 3);
      }

      // ── Footer per slot — champion icon, player name, role ──────────────
      const footerTopY = plotY + plotH + 8;
      const champCx = slotX + slotW / 2;
      const champR = 22;
      const champCy = footerTopY + champR;
      const internalId = getChampionInternalId(p.championId);
      const champIcon = internalId ? await getChampionIcon(internalId) : null;
      ctx.save();
      ctx.beginPath();
      ctx.arc(champCx, champCy, champR, 0, Math.PI * 2);
      ctx.clip();
      if (champIcon) ctx.drawImage(champIcon, champCx - champR, champCy - champR, champR * 2, champR * 2);
      else { ctx.fillStyle = '#2a2e38'; ctx.fillRect(champCx - champR, champCy - champR, champR * 2, champR * 2); }
      ctx.restore();
      ctx.strokeStyle = isTracked ? '#f0b232' : color;
      ctx.lineWidth = isTracked ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(champCx, champCy, champR - 0.5, 0, Math.PI * 2);
      ctx.stroke();

      // Player name below the avatar
      const name = p.riotIdGameName || p.summonerName || '—';
      const short = name.length > 11 ? name.slice(0, 10) + '…' : name;
      ctx.fillStyle = isTracked ? '#f0b232' : WHITE;
      ctx.font = `${isTracked ? 'italic ' : ''}bold 11px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(short, champCx, champCy + champR + 6);
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: impact chart render failed');
    return null;
  }
}

export async function renderMatchOverScoreboardPng(opts = {}) {
  const {
    blueTeam = [],
    redTeam = [],
    trackedPuuid = null,
    durationStr = '',
    getChampionInternalId,
    getChampionName,
  } = opts;

  if (!blueTeam.length || !redTeam.length || !getChampionInternalId || !getChampionName) return null;

  const BLUE = '#5DADE2';
  const RED  = '#e74c3c';
  const WIN  = '#3ba55d';
  const LOSE = '#ed4245';
  const WHITE = '#ffffff';
  const GREY = '#9aa0a6';
  const SUBTLE = '#80848e';

  try {
    const SCALE = 2;
    const W = 980;
    const padX = 20;

    const titleH = 50;
    const colHeaderH = 26;
    const teamHdrH = 30;
    const rowH = 56;
    const teamGap = 14;
    const padBottom = 20;
    const H = titleH + colHeaderH + teamHdrH + 5 * rowH + teamGap + teamHdrH + 5 * rowH + padBottom;

    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // Backdrop
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#0c0f17');
    bgGrad.addColorStop(1, '#06080d');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // ── Header ────────────────────────────────────────────────────────────
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = WHITE;
    ctx.font = `900 26px ${FONT_STACK}`;
    ctx.fillText('SCOREBOARD', padX, 34);
    if (durationStr) {
      ctx.textAlign = 'right'; ctx.fillStyle = SUBTLE;
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.fillText(durationStr, W - padX, 34);
    }

    // ── Column anchors (used by both team sections) ──────────────────────
    // Leftmost three columns are stacked icon pairs: rune (keystone + path),
    // summoner spells (D + F), then the champion avatar. Player text begins
    // after the avatar.
    const RUNE_COL_X  = padX + 4;
    const RUNE_BOX    = 22;
    const SUMM_COL_X  = RUNE_COL_X + RUNE_BOX + 4;
    const SUMM_BOX    = 22;
    const CHAMP_COL_X = SUMM_COL_X + SUMM_BOX + 6;
    const CHAMP_R     = 20;
    const COL = {
      playerX:  CHAMP_COL_X + CHAMP_R * 2 + 12,
      kdaX:     padX + 352,
      csX:      padX + 456,
      dmgX:     padX + 530,
      kpX:      padX + 602,
      goldX:    padX + 670,
      itemsX:   padX + 722,
    };
    const ITEM_SIZE = 30;
    const ITEM_GAP  = 1;

    // Column header strip
    {
      const y = titleH;
      ctx.fillStyle = '#10141d';
      roundRect(ctx, padX, y, W - padX * 2, colHeaderH, 6);
      ctx.fill();
      ctx.fillStyle = SUBTLE;
      ctx.font = `bold 11px ${FONT_STACK}`;
      ctx.textBaseline = 'middle';
      const labelY = y + colHeaderH / 2 + 1;
      ctx.textAlign = 'left';
      ctx.fillText('PLAYER', COL.playerX, labelY);
      ctx.textAlign = 'center';
      ctx.fillText('K / D / A', COL.kdaX, labelY);
      ctx.fillText('CS',  COL.csX,  labelY);
      ctx.fillText('DMG', COL.dmgX, labelY);
      ctx.fillText('KP',  COL.kpX,  labelY);
      ctx.fillText('GOLD',COL.goldX,labelY);
      ctx.textAlign = 'left';
      ctx.fillText('ITEMS', COL.itemsX, labelY);
    }

    // ── Team section drawer ──────────────────────────────────────────────
    const drawTeam = async (team, teamLabel, teamColor, sectionY) => {
      // Team header bar
      const teamWon = team[0]?.win === true;
      ctx.fillStyle = '#10141d';
      roundRect(ctx, padX, sectionY, W - padX * 2, teamHdrH, 6);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = teamColor;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.2;
      roundRect(ctx, padX + 0.5, sectionY + 0.5, W - padX * 2 - 1, teamHdrH - 1, 6);
      ctx.stroke();
      ctx.restore();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = teamColor;
      ctx.font = `900 14px ${FONT_STACK}`;
      ctx.fillText(`◆  ${teamLabel} TEAM`, padX + 12, sectionY + teamHdrH / 2 + 1);
      // WIN/LOSE pill on the right
      const pillText = teamWon ? 'WIN' : 'LOSE';
      const pillColor = teamWon ? WIN : LOSE;
      ctx.font = `900 12px ${FONT_STACK}`;
      const pillTw = ctx.measureText(pillText).width;
      const pillW = pillTw + 18;
      const pillH = 20;
      const pillX = W - padX - 12 - pillW;
      const pillY = sectionY + (teamHdrH - pillH) / 2;
      ctx.fillStyle = hexWithAlpha(pillColor, 0.20);
      roundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = pillColor;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.2;
      roundRect(ctx, pillX + 0.5, pillY + 0.5, pillW - 1, pillH - 1, pillH / 2);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = pillColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pillText, pillX + pillW / 2, pillY + pillH / 2 + 1);

      // Team total kills — used for KP%
      const teamKills = team.reduce((s, p) => s + (p.kills || 0), 0);

      // Player rows
      for (let i = 0; i < team.length; i++) {
        const p = team[i];
        const rowY = sectionY + teamHdrH + i * rowH;
        const isTracked = p.puuid === trackedPuuid;

        // Row background — alternating subtle stripe, tracked gets accent.
        ctx.fillStyle = i % 2 === 0 ? '#10141d' : '#0e121b';
        roundRect(ctx, padX, rowY, W - padX * 2, rowH - 2, 6);
        ctx.fill();
        if (isTracked) {
          ctx.save();
          ctx.strokeStyle = '#f0b232';
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1.5;
          roundRect(ctx, padX + 0.5, rowY + 0.5, W - padX * 2 - 1, rowH - 3, 6);
          ctx.stroke();
          ctx.restore();
        }

        const iconCy = rowY + (rowH - 2) / 2;

        // ── Rune column — keystone (primary) on top, secondary path under
        // Riot puts the primary perk at perks.styles[0].selections[0].perk
        // and the secondary style id at perks.styles[1].style.
        const primaryPerkId = p.perks?.styles?.[0]?.selections?.[0]?.perk;
        const secondaryStyleId = p.perks?.styles?.[1]?.style;
        const drawIconBox = async (loader, idArg, bx, by, sz, bgFill = '#1a1f2b') => {
          ctx.fillStyle = bgFill;
          roundRect(ctx, bx, by, sz, sz, 3);
          ctx.fill();
          if (!idArg) return;
          const img = await loader(idArg);
          if (img) {
            ctx.save();
            ctx.beginPath();
            roundRect(ctx, bx + 1, by + 1, sz - 2, sz - 2, 2);
            ctx.clip();
            ctx.drawImage(img, bx + 1, by + 1, sz - 2, sz - 2);
            ctx.restore();
          }
        };
        const runeTopY = iconCy - RUNE_BOX - 1;
        const runeBotY = iconCy + 1;
        await drawIconBox(getRuneIcon,      primaryPerkId,    RUNE_COL_X, runeTopY, RUNE_BOX);
        await drawIconBox(getRuneStyleIcon, secondaryStyleId, RUNE_COL_X, runeBotY, RUNE_BOX);

        // ── Summoner-spell column ────────────────────────────────────────
        const summTopY = iconCy - SUMM_BOX - 1;
        const summBotY = iconCy + 1;
        await drawIconBox(getSummonerSpellIcon, p.summoner1Id, SUMM_COL_X, summTopY, SUMM_BOX);
        await drawIconBox(getSummonerSpellIcon, p.summoner2Id, SUMM_COL_X, summBotY, SUMM_BOX);

        // ── Champion icon ────────────────────────────────────────────────
        const iconR = CHAMP_R;
        const iconCx = CHAMP_COL_X + iconR;
        const internalId = getChampionInternalId(p.championId);
        const icon = internalId ? await getChampionIcon(internalId) : null;
        ctx.save();
        ctx.beginPath();
        ctx.arc(iconCx, iconCy, iconR, 0, Math.PI * 2);
        ctx.clip();
        if (icon) ctx.drawImage(icon, iconCx - iconR, iconCy - iconR, iconR * 2, iconR * 2);
        else { ctx.fillStyle = '#2a2e38'; ctx.fillRect(iconCx - iconR, iconCy - iconR, iconR * 2, iconR * 2); }
        ctx.restore();
        ctx.strokeStyle = isTracked ? '#f0b232' : teamColor;
        ctx.lineWidth = isTracked ? 2 : 1.5;
        ctx.beginPath();
        ctx.arc(iconCx, iconCy, iconR - 0.5, 0, Math.PI * 2);
        ctx.stroke();

        // Champion level pip on the lower-right of the avatar
        if (p.champLevel) {
          const pipR = 9;
          const pipX = iconCx + iconR - 4;
          const pipY = iconCy + iconR - 4;
          ctx.fillStyle = '#0c0f17';
          ctx.beginPath();
          ctx.arc(pipX, pipY, pipR, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = isTracked ? '#f0b232' : teamColor;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = `900 10px ${FONT_STACK}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(p.champLevel), pipX, pipY + 1);
        }

        // Player + champion text
        const labelX = COL.playerX;
        const playerName = p.riotIdGameName || p.summonerName || '—';
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = isTracked ? '#f0b232' : WHITE;
        ctx.font = `${isTracked ? 'italic ' : ''}bold 13px ${FONT_STACK}`;
        const displayName = playerName.length > 14 ? playerName.slice(0, 13) + '…' : playerName;
        ctx.fillText(displayName, labelX, iconCy - 2);
        ctx.fillStyle = SUBTLE;
        ctx.font = `11px ${FONT_STACK}`;
        const champName = getChampionName(p.championId) || '';
        ctx.fillText(champName, labelX, iconCy + 14);

        // K / D / A — colored segments
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `bold 14px ${FONT_STACK}`;
        const kStr = String(p.kills || 0);
        const dStr = String(p.deaths || 0);
        const aStr = String(p.assists || 0);
        const slash = ' / ';
        const wK = ctx.measureText(kStr).width;
        const wS = ctx.measureText(slash).width;
        const wD = ctx.measureText(dStr).width;
        const wA = ctx.measureText(aStr).width;
        const total = wK + wD + wA + 2 * wS;
        let kdaCursor = COL.kdaX - total / 2;
        ctx.textAlign = 'left';
        ctx.fillStyle = WIN;
        ctx.fillText(kStr, kdaCursor, iconCy);   kdaCursor += wK;
        ctx.fillStyle = SUBTLE;
        ctx.fillText(slash, kdaCursor, iconCy);  kdaCursor += wS;
        ctx.fillStyle = LOSE;
        ctx.fillText(dStr, kdaCursor, iconCy);   kdaCursor += wD;
        ctx.fillStyle = SUBTLE;
        ctx.fillText(slash, kdaCursor, iconCy);  kdaCursor += wS;
        ctx.fillStyle = '#5ad6ff';
        ctx.fillText(aStr, kdaCursor, iconCy);

        // CS
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = WHITE;
        ctx.font = `bold 14px ${FONT_STACK}`;
        const cs = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
        ctx.fillText(String(cs), COL.csX, iconCy);

        // DMG
        const dmg = p.totalDamageDealtToChampions || 0;
        ctx.fillText(formatNumber(dmg), COL.dmgX, iconCy);

        // KP
        const kp = teamKills > 0
          ? Math.round((((p.kills || 0) + (p.assists || 0)) / teamKills) * 100)
          : 0;
        ctx.fillText(`${kp}%`, COL.kpX, iconCy);

        // Gold
        ctx.fillText(formatNumber(p.goldEarned || 0), COL.goldX, iconCy);

        // Items
        for (let s = 0; s < 7; s++) {
          const slotX = COL.itemsX + s * (ITEM_SIZE + ITEM_GAP);
          const slotY = iconCy - ITEM_SIZE / 2;
          // Empty slot background
          ctx.fillStyle = '#1a1f2b';
          roundRect(ctx, slotX, slotY, ITEM_SIZE, ITEM_SIZE, 4);
          ctx.fill();
          const itemId = p[`item${s}`] || 0;
          if (itemId) {
            const img = await getItemIcon(itemId);
            if (img) {
              ctx.save();
              ctx.beginPath();
              roundRect(ctx, slotX + 1, slotY + 1, ITEM_SIZE - 2, ITEM_SIZE - 2, 3);
              ctx.clip();
              ctx.drawImage(img, slotX + 1, slotY + 1, ITEM_SIZE - 2, ITEM_SIZE - 2);
              ctx.restore();
            }
          }
        }
      }
    };

    let yOff = titleH + colHeaderH;
    await drawTeam(blueTeam, 'BLUE', BLUE, yOff);
    yOff += teamHdrH + 5 * rowH + teamGap;
    await drawTeam(redTeam,  'RED',  RED,  yOff);

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: scoreboard render failed');
    return null;
  }
}

// Full Match Over recap as a single image: header + per-player cards + bets /
// parlay / achievements sections + the gold-lead chart embedded at the bottom.
// All text is rendered (no Discord markdown / mentions), so callers must pass
// already-resolved display names in the bet/parlay/achievement line arrays.
//
// opts shape:
//   { won, durationStr,
//     players: [{ name, championId, champName, k, d, a, kda, cs, dmg, dailyW, dailyL, wonLane }],
//     getChampionInternalId,
//     bets: [string], parlay: [string], achievements: [string],
//     lead, objectives, kills }
export async function renderMatchOverPng(opts = {}) {
  const {
    won = false,
    durationStr = '',
    players = [],
    getChampionInternalId,
    bets = [],
    parlay = [],
    achievements = [],
    lead = null,
    objectives = [],
    kills = [],
  } = opts;

  if (!players.length) return null;

  // Splash-art layout for any number of tracked players. Duos stack two
  // splash cards inside the same image so the visual language stays
  // consistent with the single-player case. The legacy compact layout
  // further below is now a fallback if the splash renderer fails.
  const splash = await renderMatchOverSplashPng({
    won, durationStr, players,
    getChampionInternalId, bets, parlay, achievements,
    lead, objectives, kills,
  });
  if (splash) return splash;

  const CARD = '#1e1f22';
  const WHITE = '#ffffff';
  const GREY = '#b5bac1';
  const SUBTLE = '#80848e';
  const WIN = '#3ba55d';
  const LOSE = '#ed4245';
  const accent = won ? WIN : LOSE;

  try {
    const SCALE = 2;
    const W = 560;
    const padX = 20;

    // Pre-render the gold chart so we know its drawn height.
    let goldImg = null;
    if (lead && lead.length > 0) {
      try {
        const buf = await renderGoldLeadPng(lead, { objectives, kills });
        if (buf) goldImg = await loadImage(buf);
      } catch (err) {
        logger.warn({ err: err.message }, 'matchGraph: gold chart render failed inside match-over');
      }
    }
    const chartW = W - padX * 2;
    const chartH = goldImg ? Math.round(goldImg.height * (chartW / goldImg.width)) : 0;

    const headerH = 58;
    const cardH = 78;
    const cardsH = players.length * cardH + (players.length - 1) * 8;
    const sectionGap = 16;
    const betsH = bets.length ? (24 + bets.length * 24 + sectionGap) : 0;
    const parlayH = parlay.length ? (24 + parlay.length * 24 + sectionGap) : 0;
    const chartBlockH = goldImg ? chartH + 12 : 0;
    const padBottom = 16;
    // Achievements section intentionally dropped from the image.
    const H = headerH + 10 + cardsH + sectionGap + betsH + parlayH + chartBlockH + padBottom;

    const canvas = createCanvas(W * SCALE, H * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // Header — accent top strip + "MATCH OVER" title (left) + VICTORY/DEFEAT
    // pill (right).
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 4);

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = WHITE;
    ctx.font = `800 30px ${FONT_STACK}`;
    ctx.fillText('MATCH OVER', padX, 42);

    ctx.font = `bold 15px ${FONT_STACK}`;
    const pillText = `${won ? 'VICTORY' : 'DEFEAT'} · ${durationStr}`;
    const ptw = ctx.measureText(pillText).width;
    const pillW = ptw + 24;
    const pillH = 30;
    const pillX = W - padX - pillW;
    const pillY = 16;
    ctx.fillStyle = accent;
    roundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = WHITE;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pillText, pillX + pillW / 2, pillY + pillH / 2 + 1);

    let y = headerH + 10;

    for (const p of players) {
      ctx.fillStyle = CARD;
      roundRect(ctx, padX, y, W - padX * 2, cardH, 12);
      ctx.fill();

      const iconR = 28;
      const icx = padX + 18 + iconR;
      const icy = y + cardH / 2;
      const internalId = getChampionInternalId ? getChampionInternalId(p.championId) : null;
      const icon = internalId ? await getChampionIcon(internalId) : null;
      ctx.save();
      ctx.beginPath();
      ctx.arc(icx, icy, iconR, 0, Math.PI * 2);
      ctx.clip();
      if (icon) ctx.drawImage(icon, icx - iconR, icy - iconR, iconR * 2, iconR * 2);
      ctx.restore();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(icx, icy, iconR - 1.5, 0, Math.PI * 2);
      ctx.stroke();

      const tx = icx + iconR + 16;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = WHITE;
      ctx.font = `bold 18px ${FONT_STACK}`;
      ctx.fillText(p.name, tx, y + 28);

      ctx.fillStyle = GREY;
      ctx.font = `13px ${FONT_STACK}`;
      ctx.fillText(p.champName, tx, y + 46);

      ctx.fillStyle = WHITE;
      ctx.font = `bold 14px ${FONT_STACK}`;
      const kdaStr = `${p.k}/${p.d}/${p.a}`;
      ctx.fillText(kdaStr, tx, y + 66);
      const kw = ctx.measureText(kdaStr).width;
      ctx.fillStyle = GREY;
      ctx.font = `13px ${FONT_STACK}`;
      ctx.fillText(`  ${p.kda} KDA · ${p.cs} CS · ${p.dmg} DMG`, tx + kw, y + 66);

      // Right side: daily record + lane tag
      ctx.textAlign = 'right';
      const rx = W - padX - 16;
      const total = p.dailyW + p.dailyL;
      const flame = total > 0 && p.dailyW / total > 0.5 ? ' 🔥' : '';
      ctx.fillStyle = GREY;
      ctx.font = `bold 13px ${FONT_STACK}`;
      ctx.fillText(`Today: ${p.dailyW}W ${p.dailyL}L${flame}`, rx, y + 30);
      ctx.font = `12px ${FONT_STACK}`;
      const laneMargin = (typeof p.laneDiff === 'number')
        ? (() => { const ab = Math.abs(p.laneDiff); const s = p.laneDiff >= 0 ? '+' : '-'; return ` (${s}${ab >= 1000 ? (ab / 1000).toFixed(1) + 'k' : ab})`; })()
        : '';
      if (p.wonLane === true) {
        ctx.fillStyle = WIN;
        ctx.fillText(`✅ Won Lane${laneMargin}`, rx, y + 50);
      } else if (p.wonLane === false) {
        ctx.fillStyle = LOSE;
        ctx.fillText(`❌ Lost Lane${laneMargin}`, rx, y + 50);
      }

      y += cardH + 8;
    }

    y += sectionGap - 8;

    const drawSection = (label, rows) => {
      if (!rows.length) return;
      ctx.textAlign = 'left';
      ctx.fillStyle = SUBTLE;
      ctx.font = `bold 12px ${FONT_STACK}`;
      ctx.fillText(label.toUpperCase(), padX, y + 13);
      y += 24;
      ctx.font = `15px ${FONT_STACK}`;
      for (const r of rows) {
        ctx.fillStyle = WHITE;
        ctx.fillText(r, padX, y + 15);
        y += 24;
      }
      y += sectionGap;
    };

    drawSection('Bets Settled', bets);
    drawSection('Parlay', parlay);

    if (goldImg) {
      ctx.save();
      roundRect(ctx, padX, y, chartW, chartH, 10);
      ctx.clip();
      ctx.drawImage(goldImg, padX, y, chartW, chartH);
      ctx.restore();
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: match-over render failed');
    return null;
  }
}
