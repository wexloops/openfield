/**
 * Shot lists from a local LLM: parse what it wrote into SceneShots, forgiving
 * the small JSON slips a 12B model makes ("framing:"high", trailing commas,
 * code fences), and snap every field to an option the Director has.
 * Pure: no I/O, so scripts/check-shotlist.ts can pin it.
 */
import {
  DIRECTOR_MOVES, SCENE_FRAMINGS, SCENE_MAX_SHOTS, SCENE_MIN_SHOTS, SHOT_SECONDS, type SceneShot,
} from '../src/catalog.js';

const FRAMING_WORDS: [RegExp, string][] = [
  [/extreme|ecu|macro|detail/i, 'ecu'],
  [/over.?the.?shoulder|ots/i, 'ots'],
  [/top.?down|overhead|bird/i, 'top'],
  [/low/i, 'low'],
  [/high/i, 'high'],
  [/close/i, 'close'],
  [/medium|mid|waist/i, 'medium'],
  [/wide|establish|long|full/i, 'wide'],
];

const MOVE_WORDS: [RegExp, string][] = [
  [/dolly.?zoom|vertigo/i, 'dolly-zoom'],
  [/crash/i, 'crash-zoom'],
  [/fpv|drone|dive/i, 'fpv-dive'],
  [/whip/i, 'whip-pan'],
  [/aerial/i, 'aerial-pull'],
  [/frozen|freeze/i, 'freeze-orbit'],
  [/body|snorri/i, 'snorricam'],
  [/orbit.*right|arc.*right/i, 'orbit-right'],
  [/orbit|arc|circle/i, 'orbit-left'],
  [/crane|rise|boom|jib/i, 'crane-up'],
  [/pull|back|reveal|retreat/i, 'pull-back'],
  [/push|dolly|in\b|forward|approach/i, 'push-in'],
  [/track|truck|side|lateral|follow/i, 'truck-left'],
  [/hand.?held|shaky/i, 'handheld'],
  [/rack|focus/i, 'rack-focus'],
  [/static|still|locked|lock|tripod|none/i, 'static'],
];

export function snapFraming(v: unknown, i: number): string {
  const s = String(v ?? '').trim();
  if (SCENE_FRAMINGS.some((f) => f.id === s)) return s;
  const byLabel = SCENE_FRAMINGS.find((f) => f.label.toLowerCase() === s.toLowerCase());
  if (byLabel) return byLabel.id;
  for (const [re, id] of FRAMING_WORDS) if (re.test(s)) return id;
  return ['wide', 'medium', 'close'][i % 3];
}

export function snapMove(v: unknown): string {
  const s = String(v ?? '').trim();
  if (DIRECTOR_MOVES.some((m) => m.id === s)) return s;
  const byName = DIRECTOR_MOVES.find((m) => m.name.toLowerCase() === s.toLowerCase());
  if (byName) return byName.id;
  for (const [re, id] of MOVE_WORDS) if (re.test(s)) return id;
  return 'push-in';
}

export function snapSeconds(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(SHOT_SECONDS.min, Math.min(SHOT_SECONDS.max, n)) : 3;
}

function normalize(raw: Record<string, unknown>[], max: number): SceneShot[] {
  return raw
    .filter((r) => r && typeof r === 'object' && String(r.action ?? r.description ?? '').trim())
    .slice(0, max)
    .map((r, i) => ({
      framing: snapFraming(r.framing ?? r.shot ?? r.size, i),
      move: snapMove(r.move ?? r.camera ?? r.movement),
      action: String(r.action ?? r.description).trim().replace(/\s+/g, ' '),
      seconds: snapSeconds(r.seconds ?? r.duration),
    }));
}

/** The shots array out of a parsed reply: {"shots":[...]}, a bare array, or {"shot_list":[...]}. */
function shotsOf(d: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === 'object') {
    for (const v of Object.values(d as Record<string, unknown>)) if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return null;
}

/** Repairs for the slips seen from Gemma 3 12B fp4 (2026-10-17). */
function repair(s: string): string {
  return s
    .replace(/"(\w+):"/g, '"$1":"')        // "framing:"high"  -> "framing":"high"
    .replace(/"(\w+)":\s*"?(\d+)"?\s*([,}])/g, '"$1":$2$3') // "seconds":"3" -> 3
    .replace(/,\s*([}\]])/g, '$1')          // trailing commas
    .replace(/[“”]/g, '"');
}

/**
 * Parse an LLM reply into 2..max shots, or null when there is nothing usable.
 * Tries strict JSON, then repaired JSON, then field-by-field per {...} block.
 */
export function parseShotList(text: string, max = SCENE_MAX_SHOTS): SceneShot[] | null {
  const body = text.replace(/```(?:json)?/gi, '').trim();
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  const arrA = body.indexOf('[');
  const candidates: string[] = [];
  if (a >= 0 && b > a) candidates.push(body.slice(a, b + 1));
  if (arrA >= 0) candidates.push(body.slice(arrA, body.lastIndexOf(']') + 1));
  for (const c of candidates) {
    for (const src of [c, repair(c)]) {
      try {
        const shots = shotsOf(JSON.parse(src));
        if (shots) {
          const out = normalize(shots, max);
          if (out.length >= SCENE_MIN_SHOTS) return out;
        }
      } catch { /* next */ }
    }
  }
  const out = partialShots(body, max);
  return out.length >= SCENE_MIN_SHOTS ? out : null;
}

/**
 * Field by field: every complete {...} block that names an action. Also reads
 * the shots of a reply that is still being written or broke off: a shot counts
 * once its closing brace is there. Returns 0..max shots.
 */
export function partialShots(text: string, max = SCENE_MAX_SHOTS): SceneShot[] {
  const body = text.replace(/```(?:json)?/gi, '');
  const field = (blk: string, k: string) => new RegExp(`"?${k}"?\\s*:?\\s*"([^"]*)"`, 'i').exec(blk)?.[1];
  const num = (blk: string, k: string) => new RegExp(`"?${k}"?\\s*:?\\s*"?(\\d+)`, 'i').exec(blk)?.[1];
  const blocks = body.match(/\{[^{}]*\}/g) ?? [];
  const loose = blocks.map((blk) => ({ framing: field(blk, 'framing'), move: field(blk, 'move'), action: field(blk, 'action'), seconds: num(blk, 'seconds') }));
  return normalize(loose as Record<string, unknown>[], max);
}

/**
 * Last resort when no LLM answered: one shot per sentence (or per ", then"),
 * cycling wide, medium, close. Always returns at least two shots.
 */
export function splitScene(scene: string, want: number): SceneShot[] {
  let parts = scene.split(/(?<=[.!?])\s+|,?\s+then\s+|;\s*/i).map((s) => s.trim()).filter((s) => s.length > 2);
  if (parts.length < SCENE_MIN_SHOTS) parts = [scene.trim(), scene.trim()];
  const n = Math.max(SCENE_MIN_SHOTS, Math.min(SCENE_MAX_SHOTS, want || parts.length, parts.length));
  const moves = ['push-in', 'static', 'handheld', 'pull-back', 'orbit-left', 'crane-up'];
  return parts.slice(0, n).map((p, i) => ({
    framing: ['wide', 'medium', 'close'][i % 3],
    move: moves[i % moves.length],
    action: `${p[0].toUpperCase()}${p.slice(1)}`.replace(/[.!?]*$/, '.'),
    seconds: 3,
  }));
}
