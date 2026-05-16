import { createCanvas, loadImage } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './utils/logger.js';
import { toAbsoluteLP, rankLabel } from './utils/rankMath.js';

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

  return tg > og;
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
// generic stack so the chart renders in something close on any host.
const FONT_STACK = '"gg sans", "Whitney", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';

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
    const W = 520;
    const H = 200;
    const padL = 52;
    const padR = 14;
    const padT = 28;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    if (title) {
      ctx.fillStyle = TITLE;
      ctx.font = `bold 13px ${FONT_STACK}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(title, padL, 8);
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
      ctx.fillStyle = AXIS;
      ctx.font = `11px ${FONT_STACK}`;
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
      drawCallout(ctx, px, py - 8, `+${formatK(maxVal2)} @ ${idx}${peakSuffix}`, BLUE, 'above', W, padR);
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
      drawCallout(ctx, px, py + 8, `${formatK(minVal2)} @ ${idx}${peakSuffix}`, RED, 'below', W, padR);
    }

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn({ err: err.message }, 'matchGraph: canvas render failed');
    return null;
  }
}

export function renderGoldLeadPng(lead, opts = {}) {
  return renderSignedLineChart(lead, {
    title: opts.title || 'Team Gold Lead',
    yAxisLabel: 'Gold Lead',
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
function drawCallout(ctx, x, y, text, color, anchor, W, padR) {
  ctx.font = `bold 11px ${FONT_STACK}`;
  const tw = ctx.measureText(text).width;
  const padX = 6;
  const boxW = tw + padX * 2;
  const boxH = 18;
  let boxX = Math.round(x - boxW / 2);
  // Clamp horizontally to canvas
  boxX = Math.max(2, Math.min(W - padR - boxW, boxX));
  const boxY = anchor === 'above' ? Math.round(y - boxH) : Math.round(y);

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
    drawCallout(ctx, xPx(maxIdx), yPx(series[maxIdx]) - 8, `${rankLabel(peak.tier, peak.rank, peak.lp)}`, BLUE, 'above', W, padR);

    // Current (last) label — only if different from peak
    if (maxIdx !== series.length - 1) {
      const last = entries[series.length - 1];
      drawCallout(ctx, xPx(series.length - 1), yPx(series[series.length - 1]) + 8, `now: ${rankLabel(last.tier, last.rank, last.lp)}`, AXIS, 'below', W, padR);
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
