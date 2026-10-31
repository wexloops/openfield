/**
 * Director scenes: one scene in, a shot list, N shot renders, one cut out.
 *
 *   plan     the shot list from a local LLM. First the engine itself
 *            (TextGenerateLTX2Prompt on the Gemma 3 12B encoder, see
 *            ./graphs/director.ts), then an OpenAI-compatible server when
 *            OPENFIELD_LLM_URL names one, then Ollama when it answers on this
 *            machine, then a plain sentence split so a scene always plans.
 *            Runs as a background job the client polls; a busy GPU queue can
 *            hold the engine planner for minutes.
 *   shoot    the cut is a take of its own. Its settings hold the shot list,
 *            and each shot records the takes made for it (a Qwen hero frame
 *            when asked for, then the LTX shot). Shots are ordinary takes
 *            tagged with `sceneOf`. Whenever one finishes, advance() moves the
 *            scene on: a finished hero frame queues its shot, and when every
 *            shot is done the cut graph joins them. State lives in the
 *            database, so a restart picks up where it was (reconcile calls
 *            advance for waiting cuts).
 *   reuse    a shot that carries `take` is not shot again. Re-rolling one
 *            shot, reordering or re-cutting is the same request with the
 *            other shots' takes kept, and makes a new cut take.
 */
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import * as comfy from './comfy.js';
import { appTier, tierSize, type RenderTier } from '../src/renderTier.js';
import * as eng from './engine.js';
import { config } from './config.js';
import { cast as castDb, takes, type Take } from './jobs.js';
import { castHeroFrame, mentioned } from './cast.js';
import { buildCutGraph, buildPlannerGraph, PLANNER_ENCODER, PLANNER_SYSTEM, type CutClip } from './graphs/director.js';
import { parseShotList, snapFraming, snapMove, snapSeconds, splitScene } from './shotlist.js';
import {
  DIRECTOR_MOVES, SCENE_FRAMINGS, SCENE_MAX_SHOTS, SCENE_MIN_SHOTS, clampEra, directorDirection, isRamp, presetById, shotPrompt,
  type RampId, type SceneShot,
} from '../src/catalog.js';

export interface SceneDeps {
  /** index.ts queueTakes: builds, records and submits one or more takes. */
  queueTakes: (b: any, count: number) => Promise<number[]>;
  broadcast: (msg: unknown) => void;
  recordWorkflow: (takeId: number, jobId: string, graph: Record<string, unknown>) => Promise<void>;
  probeMedia: (path: string) => Promise<{ w: number; h: number; fps: number; frames: number; seconds: number; audio: boolean }>;
}
let deps: SceneDeps;
export const initScenes = (d: SceneDeps) => { deps = d; };

const settings = (t: Take) => JSON.parse(t.settings) as Record<string, any>;
const pushTake = (id: number) => deps.broadcast({ type: 'take', take: takes.get(id) });

// ---------------------------------------------------------------- engine checks

const nodeCache = new Map<string, { ok: boolean; at: number }>();
/** Does the engine have this node class? Cached for a minute. */
export async function hasNode(cls: string): Promise<boolean> {
  const hit = nodeCache.get(cls);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  let ok = false;
  try {
    const r = await fetch(`${config.comfyUrl}/object_info/${encodeURIComponent(cls)}`, { signal: AbortSignal.timeout(10_000) });
    ok = r.ok && !!((await r.json()) as Record<string, unknown>)[cls];
  } catch { /* engine down: report missing */ }
  nodeCache.set(cls, { ok, at: Date.now() });
  return ok;
}

/** Why a grade or a ramp cannot run on this engine, or null. */
export async function postBlockingReason(b: { era?: unknown; eraGrade?: unknown; ramp?: unknown }): Promise<string | null> {
  if (b.era != null && b.eraGrade !== false && !(await hasNode('GLSLShader'))) {
    return 'The era grade needs ComfyUI 0.38 or newer (the GLSLShader node). Turn the grade off or update ComfyUI.';
  }
  if (isRamp(b.ramp) && b.ramp !== 'linear') {
    if (!(await hasNode('RIFE VFI'))) return 'Speed ramps need the ComfyUI-Frame-Interpolation pack (RIFE VFI). See docs/INSTALL.md, the upres bundle.';
    if (!(await hasNode('GetImagesFromBatchIndexed'))) return 'Speed ramps need the KJNodes pack (GetImagesFromBatchIndexed). See docs/INSTALL.md, the ltx-tools bundle.';
  }
  return null;
}

// ---------------------------------------------------------------- plan

export type Planner = 'engine' | 'llm' | 'ollama' | 'split';
export interface Plan {
  id: string;
  status: 'running' | 'done' | 'failed';
  scene: string;
  shots?: SceneShot[];
  planner?: Planner;
  /** Which planners were tried and why each was passed over. */
  notes: string[];
  raw?: string;
  seconds?: number;
  error?: string;
}
const plans = new Map<string, Plan>();
export const getPlan = (id: string) => plans.get(id);

const OLLAMA = (process.env.OPENFIELD_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODELS = (process.env.OPENFIELD_OLLAMA_MODEL || 'gpt-oss:20b,qwen3:30b,qwen3:8b,gemma3:12b').split(',').map((s) => s.trim()).filter(Boolean);
/** An OpenAI-compatible server (llama.cpp, LM Studio, vLLM, ...): its base URL up to and including /v1. Unset = not used. */
const LLM = (process.env.OPENFIELD_LLM_URL || '').trim().replace(/\/+$/, '');
const LLM_MODEL = (process.env.OPENFIELD_LLM_MODEL || '').trim();
const LLM_KEY = (process.env.OPENFIELD_LLM_KEY || '').trim();
const LLM_TIMEOUT = 300_000;

function systemPrompt(want: number): string {
  const n = want ? { min: want, max: want } : { min: SCENE_MIN_SHOTS, max: 4 };
  return PLANNER_SYSTEM(n, SCENE_FRAMINGS.map((f) => f.id), DIRECTOR_MOVES.map((m) => m.id));
}

/** Run the planner graph on the engine and return the text it wrote. */
async function planOnEngine(scene: string, want: number, seed: number): Promise<string> {
  const have = await comfy.comboOptions('CLIPLoader', 'clip_name');
  if (!have.includes(PLANNER_ENCODER)) throw new Error(`the engine has no ${PLANNER_ENCODER} (it ships in the ltx23 bundle)`);
  if (!(await hasNode('TextGenerateLTX2Prompt'))) throw new Error('the engine has no TextGenerateLTX2Prompt node (ComfyUI 0.38+)');
  const jobId = await eng.submit(buildPlannerGraph({ scene, system: systemPrompt(want), seed }));
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await eng.result(jobId);
    if (!r.done) continue;
    if (!r.success || !r.output) throw new Error(r.error || 'the planner produced no text');
    return r.output.data.toString('utf8');
  }
  await eng.cancel(jobId).catch(() => {});
  throw new Error('the engine planner timed out (the GPU queue is busy)');
}

/** Ask a local Ollama, if one answers. Optional: OpenField never needs it. */
async function planOnOllama(scene: string, want: number): Promise<string> {
  const tags = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json() as Promise<{ models?: { name: string }[] }>);
  const names = new Set((tags.models ?? []).map((m) => m.name));
  const model = OLLAMA_MODELS.find((m) => names.has(m));
  if (!model) throw new Error(`Ollama has none of ${OLLAMA_MODELS.join(', ')}`);
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model, stream: false, format: 'json', think: false,
      options: { temperature: 0.4 },
      messages: [{ role: 'system', content: systemPrompt(want) }, { role: 'user', content: scene }],
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${model} answered ${r.status}`);
  const d = (await r.json()) as { message?: { content?: string } };
  return `${d.message?.content ?? ''}`;
}

/** Ask the OpenAI-compatible server named by OPENFIELD_LLM_URL. Optional: OpenField never needs it. */
async function planOnLlm(scene: string, want: number): Promise<string> {
  if (!LLM) throw new Error('OPENFIELD_LLM_URL is not set');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (LLM_KEY) headers.Authorization = `Bearer ${LLM_KEY}`;
  let model = LLM_MODEL;
  if (!model) {
    const r = await fetch(`${LLM}/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`${LLM}/models answered ${r.status}`);
    const list = (await r.json()) as { data?: { id?: string }[] };
    model = list.data?.find((m) => m.id)?.id ?? '';
    if (!model) throw new Error(`${LLM}/models lists no model; set OPENFIELD_LLM_MODEL`);
  }
  const ask = (jsonMode: boolean) => fetch(`${LLM}/chat/completions`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(LLM_TIMEOUT),
    body: JSON.stringify({
      model, stream: false, temperature: 0.4,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: systemPrompt(want) }, { role: 'user', content: scene }],
    }),
  });
  // JSON mode where the server has it; some (LM Studio) refuse json_object with a 400, so ask again without it.
  let r = await ask(true);
  if (r.status === 400) r = await ask(false);
  if (!r.ok) throw new Error(`${model} at ${LLM} answered ${r.status}`);
  const d = (await r.json()) as { choices?: { message?: { content?: string | null } }[] };
  // Reasoning models may put their thinking into the content; the shot list follows it.
  return `${d.choices?.[0]?.message?.content ?? ''}`.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Carry the scene's @mentions onto its shots: every shot whose action names a
 * mentioned member (with or without the @, since planners tend to drop it)
 * gets that member's id in `cast`, and a bare name gets its @ back so the
 * shot text resolves on its own. Mutates and returns `shots`.
 */
export function attachCast(shots: SceneShot[], scene: string): SceneShot[] {
  const members = mentioned(scene, castDb.list());
  if (!members.length) return shots;
  for (const shot of shots) {
    const ids = new Set(shot.cast ?? []);
    for (const m of members) {
      const at = new RegExp(`@${escapeRe(m.name)}(?![\\w-])`, 'i');
      const bare = new RegExp(`(^|[^@\\w])(${escapeRe(m.name)})(?![\\w-])`, 'i');
      if (at.test(shot.action)) ids.add(m.id);
      else if (bare.test(shot.action)) {
        ids.add(m.id);
        shot.action = shot.action.replace(bare, (_x, pre: string) => `${pre}@${m.name}`);
      }
    }
    if (ids.size) shot.cast = [...ids].slice(0, 8);
  }
  return shots;
}

/**
 * Start planning a scene. `planner` 'auto' tries the engine, then the
 * OpenAI-compatible server (only when OPENFIELD_LLM_URL is set), then Ollama,
 * then the sentence split; naming one runs only that one (plus the split
 * when it fails, so the user always gets a list to edit).
 */
export function startPlan(scene: string, opts: { shots?: number; planner?: string; seed?: number }): Plan {
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const want = opts.shots ? Math.max(SCENE_MIN_SHOTS, Math.min(SCENE_MAX_SHOTS, Math.round(opts.shots))) : 0;
  const plan: Plan = { id, status: 'running', scene, notes: [] };
  plans.set(id, plan);
  const started = Date.now();
  const order: Planner[] =
    opts.planner === 'engine' ? ['engine']
    : opts.planner === 'llm' ? ['llm']
    : opts.planner === 'ollama' ? ['ollama']
    : opts.planner === 'split' ? []
    : LLM ? ['engine', 'llm', 'ollama'] : ['engine', 'ollama'];
  void (async () => {
    for (const p of order) {
      try {
        const raw =
          p === 'engine' ? await planOnEngine(scene, want, opts.seed ?? Math.floor(Math.random() * 1e9))
          : p === 'llm' ? await planOnLlm(scene, want)
          : await planOnOllama(scene, want);
        const shots = parseShotList(raw, want || SCENE_MAX_SHOTS);
        if (shots) {
          attachCast(shots, scene);
          Object.assign(plan, { status: 'done', shots, planner: p, raw, seconds: (Date.now() - started) / 1000 });
          return;
        }
        plan.notes.push(`${p}: the reply had no usable shot list`);
        plan.raw = raw;
      } catch (e) {
        plan.notes.push(`${p}: ${e instanceof Error ? e.message : e}`);
      }
    }
    Object.assign(plan, { status: 'done', shots: attachCast(splitScene(scene, want), scene), planner: 'split', seconds: (Date.now() - started) / 1000 });
  })().catch((e) => Object.assign(plan, { status: 'failed', error: e instanceof Error ? e.message : String(e) }));
  // Plans are small; keep the last hundred.
  if (plans.size > 100) plans.delete(plans.keys().next().value!);
  return plan;
}

// ---------------------------------------------------------------- shoot

/** One shot as the cut take stores it. `hero` and `take` fill in as renders are queued. */
export interface StoredShot extends SceneShot {
  key?: string;
  hero?: number;
  /** The hero frame is a Cast hero frame; castHeroSeam queues the shot when it lands. */
  castHero?: boolean;
}

export interface SceneRequest {
  scene: string;
  shots: StoredShot[];
  picks?: Record<string, string>;
  era?: number | null;
  eraGrade?: boolean;
  ramp?: RampId;
  withAudio?: boolean;
  heroFrames?: boolean;
  imageModel?: 'qwen' | 'flux2';
  width: number;
  height: number;
  seed?: number;
  projectId?: number | null;
}

/**
 * Validate and normalize a scene request. Throws a message the user can act on.
 * Without a width and height the shots render 16:9 at `tier` (scenes stop at 720p).
 */
export function cleanScene(b: any, tier: RenderTier): SceneRequest {
  const shots: StoredShot[] = Array.isArray(b.shots) ? b.shots : [];
  if (shots.length < 1) throw new Error('A scene needs at least one shot');
  if (shots.length > SCENE_MAX_SHOTS) throw new Error(`A scene takes up to ${SCENE_MAX_SHOTS} shots`);
  const own = Number(b.width) > 0 && Number(b.height) > 0;
  const frame = tierSize(appTier('scene', tier), 16 / 9);
  const width = own ? Number(b.width) : frame.w;
  const height = own ? Number(b.height) : frame.h;
  return {
    scene: String(b.scene ?? '').trim(),
    shots: shots.map((s, i) => {
      const action = String(s.action ?? '').trim();
      if (!action) throw new Error(`Shot ${i + 1} has no action`);
      const take = Number(s.take);
      return {
        key: typeof s.key === 'string' ? s.key.slice(0, 40) : undefined,
        framing: snapFraming(s.framing, i),
        move: snapMove(s.move),
        action,
        seconds: snapSeconds(s.seconds),
        ramp: isRamp(s.ramp) ? s.ramp : undefined,
        cast: Array.isArray(s.cast) ? s.cast.map(Number).filter((c) => Number.isInteger(c) && c > 0).slice(0, 8) : undefined,
        take: Number.isFinite(take) && take > 0 ? take : undefined,
      };
    }),
    picks: b.picks && typeof b.picks === 'object' ? b.picks : {},
    era: b.era == null || b.era === '' ? null : clampEra(Number(b.era)),
    eraGrade: b.eraGrade !== false,
    ramp: isRamp(b.ramp) ? b.ramp : 'linear',
    withAudio: !!b.withAudio,
    heroFrames: !!b.heroFrames,
    imageModel: b.imageModel === 'flux2' ? 'flux2' : 'qwen',
    width, height,
    seed: Number.isFinite(b.seed) ? Number(b.seed) : Math.floor(Math.random() * 1e9),
    projectId: b.projectId ?? null,
  };
}

/** A shot's direction: the scene's picks with this shot's framing. */
function shotDirection(r: SceneRequest) {
  return directorDirection({ ...r.picks, framing: 'auto' }, r.era ?? null);
}

/** Hero frame size: the shot's aspect at about one megapixel, 16-aligned. */
function heroSize(w: number, h: number) {
  const k = Math.sqrt(1.0e6 / (w * h));
  const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return { width: snap(w * k), height: snap(h * k) };
}

/** The /api/generate-style body of one shot (the video). */
function shotBody(r: SceneRequest, cutId: number, i: number, startImage?: string) {
  const s = r.shots[i];
  const direction = shotDirection(r);
  return {
    app: 'director', kind: 'video', videoModel: 'ltx25',
    scene: r.scene, picks: { ...r.picks, framing: s.framing }, era: r.era, eraGrade: r.eraGrade,
    ramp: s.ramp ?? r.ramp, preset: s.move, presetName: presetById(s.move).name,
    prompt: shotPrompt(s, direction), userPrompt: s.action,
    width: r.width, height: r.height, seconds: s.seconds, withAudio: r.withAudio,
    startImage, cast: s.cast,
    shotName: `${(r.scene || s.action).slice(0, 32)}_s${i + 1}`,
    seed: (r.seed ?? 0) + i * 7, projectId: r.projectId,
    sceneOf: cutId, sceneIndex: i,
  };
}

/** The body of one shot's hero frame: same words without the move, ungraded (the shot carries the grade). */
function heroBody(r: SceneRequest, cutId: number, i: number) {
  const s = r.shots[i];
  const size = heroSize(r.width, r.height);
  return {
    app: 'director', kind: 'still', model: r.imageModel, quality: 'quality',
    scene: r.scene, picks: { ...r.picks, framing: s.framing }, era: r.era, eraGrade: false,
    prompt: shotPrompt({ ...s, move: 'free' }, shotDirection(r)), userPrompt: s.action,
    ...size, cast: s.cast,
    shotName: `${(r.scene || s.action).slice(0, 32)}_s${i + 1}_frame`,
    seed: (r.seed ?? 0) + i * 7, projectId: r.projectId,
    sceneOf: cutId, sceneIndex: i, sceneStep: 'hero',
  };
}

/**
 * Create the cut take and queue every shot that is not already shot.
 * Returns the cut take id; the shots' take ids land in its settings.
 */
export async function shootScene(r: SceneRequest): Promise<number> {
  for (const [i, s] of r.shots.entries()) {
    if (!s.take) continue;
    const t = takes.get(s.take);
    if (!t || t.kind !== 'video') throw new Error(`Shot ${i + 1}: take ${s.take} is not a video take`);
    if (t.status === 'failed' || t.status === 'stopped') throw new Error(`Shot ${i + 1}: take ${s.take} ${t.status}; re-roll it`);
  }
  const total = r.shots.reduce((n, s) => n + s.seconds, 0);
  const cutId = takes.create({
    project_id: r.projectId ?? null,
    kind: 'video',
    shot_name: (r.scene || r.shots[0].action).slice(0, 40),
    settings: {
      app: 'director', cut: true, ...r, shots: r.shots.map((s) => ({ ...s, hero: undefined })),
      prompt: r.scene || r.shots.map((s) => s.action).join(' '), userPrompt: r.scene || r.shots[0].action,
      seconds: total, shotName: (r.scene || r.shots[0].action).slice(0, 40),
    },
  });
  pushTake(cutId);
  try {
    for (let i = 0; i < r.shots.length; i++) {
      if (r.shots[i].take) continue;
      if (r.shots[i].cast?.length && castHeroSeam(r, cutId, i)) continue;
      const [id] = await deps.queueTakes(r.heroFrames ? heroBody(r, cutId, i) : shotBody(r, cutId, i), 1);
      updateShot(cutId, i, r.heroFrames ? { hero: id } : { take: id });
    }
  } catch (e) {
    takes.fail(cutId, `Could not queue the shots: ${e instanceof Error ? e.message : e}`);
    pushTake(cutId);
    throw e;
  }
  await advance(cutId);
  return cutId;
}

/** Cast hero frames this process is still waiting on, as `${cutId}:${i}`. */
const liveCastHeroes = new Set<string>();

/**
 * CAST SEAM. A shot with `cast` ids starts from a Cast hero frame of those
 * members (castHeroFrame in ./cast.ts: a Qwen-Image-Edit still composed from
 * their pictures, an ordinary take), then LTX shoots the shot from it.
 *
 * The shot is marked `castHero` before anything is awaited, so step() leaves
 * it alone while the frame renders, and `hero` is set the moment the frame is
 * queued. The frame take carries `sceneOf`, so when it settles the scene is
 * advanced. If the server restarts mid-frame the promise below is gone; step()
 * then treats the shot like any other hero-frame shot.
 *
 * Returns false (the shot renders as usual) when none of its cast members has
 * a reference picture.
 */
function castHeroSeam(r: SceneRequest, cutId: number, i: number): boolean {
  const s = r.shots[i];
  const all = castDb.list();
  if (!s.cast?.some((id) => all.find((m) => m.id === id)?.refs.length)) return false;
  const key = `${cutId}:${i}`;
  liveCastHeroes.add(key);
  updateShot(cutId, i, { castHero: true });
  void castHeroFrame(s.cast, shotPrompt({ ...s, move: 'free' }, shotDirection(r)), {
    ...heroSize(r.width, r.height),
    seed: (r.seed ?? 0) + i * 7,
    projectId: r.projectId,
    extra: { sceneOf: cutId, sceneIndex: i, sceneStep: 'hero' },
    onQueued: (takeId) => updateShot(cutId, i, { hero: takeId }),
  }).then(async (h) => {
    const t = takes.get(cutId);
    if (!t || t.status !== 'queued' || t.prompt_id) return; // cancelled or failed meanwhile
    if (settings(t).shots?.[i]?.take) return;
    const [id] = await deps.queueTakes(shotBody(r, cutId, i, h.token), 1);
    updateShot(cutId, i, { take: id });
  }).catch((e) => failCut(cutId, `Shot ${i + 1}: the cast frame failed (${e instanceof Error ? e.message : e})`))
    .finally(() => { liveCastHeroes.delete(key); void advance(cutId); });
  return true;
}

function failCut(cutId: number, error: string) {
  const t = takes.get(cutId);
  if (t && t.status === 'queued' && !t.prompt_id) {
    takes.fail(cutId, error);
    pushTake(cutId);
  }
}

function updateShot(cutId: number, i: number, patch: Partial<StoredShot>) {
  const t = takes.get(cutId)!;
  const s = settings(t);
  s.shots[i] = { ...s.shots[i], ...patch };
  takes.setSettings(cutId, s);
  pushTake(cutId);
}

const locks = new Map<number, Promise<void>>();
/** Move a scene on. Serialized per cut, since several shots can finish at once. */
export function advance(cutId: number): Promise<void> {
  const prev = locks.get(cutId) ?? Promise.resolve();
  const next = prev.then(() => step(cutId)).catch((e) => {
    console.error(`[openfield] scene ${cutId}:`, e instanceof Error ? e.message : e);
    const t = takes.get(cutId);
    if (t && t.status === 'queued' && !t.prompt_id) {
      takes.fail(cutId, e instanceof Error ? e.message : 'the cut failed');
      pushTake(cutId);
    }
  });
  locks.set(cutId, next);
  void next.finally(() => { if (locks.get(cutId) === next) locks.delete(cutId); });
  return next;
}

async function step(cutId: number) {
  const cut = takes.get(cutId);
  // Waiting = queued with no engine job yet. Anything else is cut, cutting or over.
  if (!cut || cut.status !== 'queued' || cut.prompt_id) return;
  const s = settings(cut);
  const r = s as unknown as SceneRequest;
  const done: Take[] = [];
  for (let i = 0; i < r.shots.length; i++) {
    const shot = r.shots[i];
    if (!shot.take && shot.castHero && liveCastHeroes.has(`${cutId}:${i}`)) continue;
    if (!shot.take && shot.hero) {
      const h = takes.get(shot.hero);
      if (!h) throw new Error(`Shot ${i + 1}: its frame was deleted`);
      if (h.status === 'failed' || h.status === 'stopped') throw new Error(`Shot ${i + 1}: the hero frame ${h.status}${h.error ? ` (${h.error})` : ''}`);
      if (h.status !== 'done' || !h.output_path) continue;
      const token = await eng.uploadInput(`openfield_hero_${h.id}.png`, await readFile(h.output_path), 'image/png');
      const [id] = await deps.queueTakes(shotBody(r, cutId, i, token), 1);
      updateShot(cutId, i, { take: id });
      continue;
    }
    if (!shot.take) throw new Error(`Shot ${i + 1} was never queued`);
    const t = takes.get(shot.take);
    if (!t) throw new Error(`Shot ${i + 1}: take ${shot.take} was deleted`);
    if (t.status === 'failed' || t.status === 'stopped') throw new Error(`Shot ${i + 1} ${t.status}${t.error ? `: ${t.error}` : ''}`);
    if (t.status !== 'done' || !t.output_path) continue;
    if (!existsSync(t.output_path)) throw new Error(`Shot ${i + 1}: its file is gone (${t.output_path})`);
    done.push(t);
  }
  if (done.length < r.shots.length) return;

  // Every shot is in: join them. Each file goes up as an input; frame counts and
  // sound come from probing the real files, since ramps change the length.
  const clips: CutClip[] = [];
  for (const t of done) {
    const m = await deps.probeMedia(t.output_path!);
    const ext = extname(t.output_path!) || '.mp4';
    clips.push({
      file: await eng.uploadInput(`openfield_shot_${t.id}${ext}`, await readFile(t.output_path!), 'video/mp4'),
      frames: m.frames > 0 ? m.frames : Math.max(1, Math.round(m.seconds * 24)),
      hasAudio: m.audio,
    });
  }
  const withAudio = !!r.withAudio && clips.some((c) => c.hasAudio);
  const graph = buildCutGraph({ clips, width: r.width, height: r.height, withAudio, filenamePrefix: 'openfield/scene' });
  const frames = clips.reduce((n, c) => n + c.frames, 0);
  takes.setSettings(cutId, { ...s, seconds: Math.round((frames / 24) * 10) / 10, cutFrames: frames, cutAudio: withAudio, shotTakes: done.map((t) => t.id) });
  const jobId = await eng.submit(graph);
  takes.setPrompt(cutId, jobId);
  void deps.recordWorkflow(cutId, jobId, graph);
  pushTake(cutId);
}

/** Cuts still waiting on shots, for reconcile after a restart. */
export function waitingCuts(): number[] {
  return takes.active().filter((t) => !t.prompt_id && t.status === 'queued' && settings(t).cut).map((t) => t.id);
}

/** Cancelling a waiting cut also cancels the shots still rendering for it. */
export function shotsOf(cutId: number): Take[] {
  const t = takes.get(cutId);
  if (!t) return [];
  const s = settings(t);
  const ids = (s.shots as StoredShot[] ?? []).flatMap((x) => [x.hero, x.take]).filter((x): x is number => !!x);
  return ids.map((id) => takes.get(id)).filter((x): x is Take => !!x);
}
