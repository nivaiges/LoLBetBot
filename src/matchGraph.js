import { createCanvas, loadImage } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './utils/logger.js';
import { toAbsoluteLP, rankLabel } from './utils/rankMath.js';
import { displayName } from './utils/displayName.js';
import { getChampionIcon } from './utils/championIcons.js';

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

    ctx.fillStyle = BG;
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
    title: opts.title || 'Gold Graph',
    yAxisLabel: 'Team Gold Lead',
    peakSuffix: 'm',
    objectives: opts.objectives || [],
    kills: opts.kills || [],
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
export function renderRankLadderPng(players, opts = {}) {
  if (!players?.length) return null;
  const {
    title = 'Tracked Players — Rank Ladder',
    decorateFirstLast = false, // 👑 on first, 🥀 on last — only when /rank passes this
    bg = BG, // override canvas background for one-off tests
  } = opts;

  try {
    const sorted = [...players].sort((a, b) =>
      (toAbsoluteLP(b.tier, b.rank, b.lp) || 0) - (toAbsoluteLP(a.tier, a.rank, a.lp) || 0)
    );

    const rowH = 40;
    const padT = 44;
    const padB = 32;
    const padL = 18;
    const padR = 18;
    const nameW = 120;
    const labelW = 260;
    const W = 820;
    const H = padT + rowH * sorted.length + padB;
    const barX = padL + nameW;
    const barAreaW = W - padL - padR - nameW - labelW;
    const barH = 20;

    const allAbs = sorted.flatMap(p => [
      toAbsoluteLP(p.tier, p.rank, p.lp) || 0,
      p.peak_tier ? (toAbsoluteLP(p.peak_tier, p.peak_rank, p.peak_lp) || 0) : 0,
    ]);
    const maxAbs = Math.max(...allAbs, 0);
    const xMax = Math.max(2800, Math.ceil((maxAbs * 1.05) / 100) * 100);
    const xPx = v => barX + barAreaW * v / xMax;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = TITLE;
    ctx.font = `bold 16px ${FONT_STACK}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(title, padL, 12);

    // Tier band backgrounds (vertical zones across all rows)
    const bandTop = padT - 2;
    const bandBot = H - padB + 2;
    for (const band of TIER_BANDS) {
      const xLo = xPx(Math.max(0, band.min));
      const xHi = xPx(Math.min(xMax, band.max));
      if (xHi <= xLo) continue;
      ctx.fillStyle = band.color;
      ctx.fillRect(xLo, bandTop, xHi - xLo, bandBot - bandTop);
    }

    // Tier boundary dashed lines
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const band of TIER_BANDS) {
      if (band.min > 0 && band.min <= xMax) {
        const x = xPx(band.min);
        ctx.beginPath();
        ctx.moveTo(x, bandTop);
        ctx.lineTo(x, bandBot);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const rowCenter = padT + rowH * i + rowH / 2;
      const absCur = toAbsoluteLP(p.tier, p.rank, p.lp) || 0;
      const absPeak = p.peak_tier ? (toAbsoluteLP(p.peak_tier, p.peak_rank, p.peak_lp) || 0) : 0;
      const color = TIER_BAR_COLORS[p.tier] || '#999';
      const peakColor = TIER_BAR_COLORS[p.peak_tier] || color;
      const isPeaking = !p.peak_tier || absCur >= absPeak;

      // Player name — last place gets a 🥀 prefix when decorateFirstLast
      let namePrefix = '';
      if (decorateFirstLast && sorted.length > 1 && i === sorted.length - 1) {
        namePrefix = '🥀 ';
      }
      ctx.fillStyle = '#fff';
      ctx.font = `bold 15px ${FONT_STACK}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(namePrefix + displayName(p.riot_tag), padL, rowCenter);

      // Background bar
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(barX, rowCenter - barH / 2, barAreaW, barH);

      // Peak extension (drawn first so current overlays it)
      if (absPeak > absCur) {
        const peakX = xPx(absPeak);
        const curX = xPx(absCur);
        ctx.fillStyle = peakColor + '40';
        ctx.fillRect(curX, rowCenter - barH / 2, peakX - curX, barH);
      }

      // Solid current bar
      const fillW = Math.max(2, xPx(absCur) - barX);
      ctx.fillStyle = color;
      ctx.fillRect(barX, rowCenter - barH / 2, fillW, barH);

      // End-cap dot with optional yellow halo
      const capX = barX + fillW;
      if (isPeaking) {
        ctx.fillStyle = PEAK_YELLOW;
        ctx.beginPath();
        ctx.arc(capX, rowCenter, barH / 2 + 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(capX, rowCenter, barH / 2 + 1, 0, Math.PI * 2);
      ctx.fill();

      // Peak tick marker
      if (absPeak > absCur) {
        const peakX = xPx(absPeak);
        ctx.strokeStyle = peakColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(peakX, rowCenter - barH / 2 - 3);
        ctx.lineTo(peakX, rowCenter + barH / 2 + 3);
        ctx.stroke();
      }

      // Right-side label
      const labelX = W - padR - labelW + 4;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      const curLabel = rankLabel(p.tier, p.rank, p.lp);
      ctx.fillStyle = isPeaking ? PEAK_YELLOW : '#fff';
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.fillText(curLabel, labelX, rowCenter);
      const curW = ctx.measureText(curLabel).width;

      if (isPeaking) {
        ctx.fillStyle = PEAK_YELLOW;
        ctx.font = `bold 13px ${FONT_STACK}`;
        ctx.fillText('  ·  CURRENT PEAK!!', labelX + curW, rowCenter);
      } else if (p.peak_tier) {
        ctx.fillStyle = AXIS;
        ctx.font = `13px ${FONT_STACK}`;
        ctx.fillText(`  ·  peak: ${rankLabel(p.peak_tier, p.peak_rank, p.peak_lp)}`, labelX + curW, rowCenter);
      }
    }

    // Tier labels along the bottom
    ctx.fillStyle = AXIS;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const band of TIER_BANDS) {
      const mid = (band.min + Math.min(band.max, xMax)) / 2;
      if (mid > xMax) continue;
      ctx.fillText(band.name, xPx(mid), H - padB + 6);
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: rank ladder render failed');
    return null;
  }
}

// Lane-aligned team composite for Match Detected — two rows of 5 champion
// icons (blue team top, red team bottom) with a "VS" divider between, and
// the tracked player's icon outlined in yellow.
//
// Expects `blueTeam` and `redTeam` already ordered TOP → JUNGLE → MID → BOT → SUP.
export async function renderTeamsCompositePng(opts = {}) {
  const {
    blueTeam = [],
    redTeam = [],
    trackedPuuid = null,
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
    teamLabels = false,    // change 1: BLUE/RED header per team (no side pill, no VS)
    autoBetStyle = 'plain',// 'plain' | 'card' (change 2: separated auto-bet card)
  } = opts;

  if (!blueTeam.length || !redTeam.length || !getChampionInternalId || !getChampionName) return null;

  const labelFor = (p) => (getLabel ? getLabel(p) : getChampionName(p.championId)) || getChampionName(p.championId) || '?';

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
    const achH = achievements.length ? (24 + achievements.length * 24 + sectionGap) : 0;
    const chartBlockH = goldImg ? chartH + 12 : 0;
    const padBottom = 16;
    const H = headerH + 10 + cardsH + sectionGap + betsH + parlayH + achH + chartBlockH + padBottom;

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
    drawSection('Achievements', achievements);

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
