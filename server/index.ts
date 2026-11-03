/**
 * OpenField server: Fastify on OPENFIELD_PORT (default 3161).
 * Owns: generate/stop/queue API, job history, project folders, the live
 * relay (per-step previews from the Comfy SDK event stream), completion
 * handling, whisper transcription, and media serving. The browser never
 * talks to ComfyUI directly; every job goes through engine.ts (Comfy SDK).
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, realpathSync, statSync } from 'fs';
import { dirname, extname, join, resolve, sep } from 'path';
import type { WebSocket } from 'ws';
import * as comfy from './comfy.js';
import * as eng from './engine.js';
import { config, ROOT } from './config.js';
import { buildH3Graph, snapH3Length, turboProblem } from './graphs/h3.js';
import { buildLtxGraph } from './graphs/ltx.js';
import { buildLtx25Graph, ltx25EffectiveSize, ltx25Mode, LTX25_FPS, snapFrames } from './graphs/ltx25.js';
import { applyPost } from './graphs/director.js';
import { advance, cleanScene, getPlan, initScenes, plannerReasoningOverride, postBlockingReason, shootScene, shotsOf, startPlan, waitingCuts } from './scene.js';
import { buildStillsGraph } from './graphs/stills.js';
import { listUserLoras, pickLoras, type LoraFamily } from './loras.js';
import { buildDreamGraph, buildRedrawGraph, buildSharpenGraph, redrawBatch, type UpscaleSource } from './graphs/upscale.js';
import {
  CUTOUT_MAX_SECONDS, DREAM_CREATIVITY, REDRAW_HEIGHTS, REDRAW_MAX_SECONDS, clampEra, cutoutSize, dreamFrames, eraGrade, isRamp, restyleInstruction, restyleLook, restylePrompt,
  sharpenMaxSeconds, swapPrompt, upscaleSize, type UpscaleMode,
} from '../src/catalog.js';
import { EDIT_ANGLES_LORA, buildEditGraph, editLightning, editSize, expandLayout } from './graphs/edit.js';
import { buildMirrorGraph } from './graphs/mirror.js';
import { buildCutoutStillGraph, buildCutoutVideoGraph, type CutoutBackground, type CutoutMethod } from './graphs/cutout.js';
import { buildRestyleGraph, buildSwapGraph } from './graphs/restyle.js';
import { checkerPreview } from './cutout.js';
import { buildReshootGraph, buildReshootWarpPreviewGraph } from './graphs/reshoot.js';
import { buildExtendGraph, buildSoundGraph, buildSpeakGraph, buildTransitionGraph } from './graphs/ltxtools.js';
import { takes, projects, speed, preambles, takeWorkflows, cast as castDb, type CastKind } from './jobs.js';
import {
  CAST_KINDS, MAX_REFS, allocate, isCastFile, castHeroFrame, composeInstruction, liveRefs, mentioned, plainText, refFrom, renameFiles,
  setCastQueue, sheetPlan, type HeroOpts,
} from './cast.js';
import { buildCastVideoGraph } from './graphs/cast.js';
import { imageDims, saveToProject, safeShotName } from './files.js';
import { transcribe } from './whisper.js';
import { bundlesFor } from './models.js';
import { modelsUnloaded } from './modelSwitch.js';
import { blockingReason, clearPreflightCache, effectBlockingReason, preflight } from './preflight.js';
import { effectById, effectPrompt } from '../src/effects.js';
import { closePhoneSession, openPhoneSession, phoneSession } from './phone.js';
import { load as loadClip, measureLoop, planBridge, planRegen, planTrim, scoreWindow, videoInfo, type SeamMeasure } from './seam.js';
import { buildSeamBridgeGraph, buildSeamRegenGraph, buildSeamTrimGraph } from './graphs/seam.js';
import { buildHdrGraph } from './graphs/hdr.js';
import { OBJECT_QUALITY, TURNTABLE, buildTrellisGraph, type ObjectQuality } from './graphs/trellis.js';
import { collectHdr } from './hdr.js';
import { buildStageLookGraph, buildStageShotGraph, lookEditInstruction, lookPrompt } from './graphs/stage.js';
import { checkSize, ingestBlocking, rasterBlocking, stageLookFrame } from './stage.js';
import { cleanStageScene, lookSize, stageTier } from '../src/stage.js';
import { appTier, isRenderTier, parseTier, tierSizeOf, type RenderTier, type TierApp } from '../src/renderTier.js';
import { currentTier, setTier, tierState } from './renderTier.js';
import { isVideoDecode, type VideoDecode } from '../src/videoDecode.js';
import { setVideoDecode, videoDecodeState } from './videoDecode.js';
import { MIN_PASSWORD, installJudge, type JudgeState } from './judge.js';
import { estimate } from './estimate.js';

if (config.judge.on && config.judge.password.length < MIN_PASSWORD) {
  console.error(`OPENFIELD_JUDGE is on, so OPENFIELD_JUDGE_PASSWORD must be set (${MIN_PASSWORD} characters or more). Not starting.`);
  process.exit(1);
}

const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
await app.register(websocket);

let judgeState: (() => JudgeState) | undefined;
if (config.judge.on) {
  // Judge mode: a password on every route replaces the loopback-only rule.
  judgeState = installJudge(app, { password: config.judge.password, cap: config.judge.cap, usageFile: join(config.dataDir, 'judge-usage.json') });
} else {
  // No auth by design (loopback only), so refuse requests whose Host is not this
  // machine. That stops a web page from reaching the API through DNS rebinding.
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', config.host]);
  // and refuse requests a page on another site sends here: browsers attach Origin to those,
  // and a form or text/plain POST would otherwise reach a handler without a preflight
  const localOrigin = (o: string) => {
    try { const u = new URL(o); return LOCAL_HOSTS.has(u.hostname.toLowerCase()) || LOCAL_HOSTS.has(`[${u.hostname}]`); } catch { return false; }
  };
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!LOCAL_HOSTS.has(host)) return reply.code(403).send({ error: 'OpenField only answers on this machine' });
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !localOrigin(origin)) return reply.code(403).send({ error: 'OpenField only answers its own pages' });
    if (origin === 'null' && req.method !== 'GET') return reply.code(403).send({ error: 'OpenField only answers its own pages' });
  });
}

/** Settings keys only the server writes. A request body must never set them: some are file paths we later serve. */
const SERVER_KEYS = ['alphaPath', 'hdr', 'hdrTag', 'seam', 'seamFix', 'output_path', 'outputPath'] as const;
function stripServerKeys(b: any): void {
  if (b && typeof b === 'object') for (const k of SERVER_KEYS) delete b[k];
}

/** Serve a side file only if it sits in the same folder as the take's own output. */
function besideOutput(outputPath: string | null | undefined, file: string | undefined): string | undefined {
  if (!outputPath || !file || !existsSync(file) || !existsSync(outputPath)) return undefined;
  return dirname(realpathSync(file)) === dirname(realpathSync(outputPath)) ? file : undefined;
}

// ---------- live relay ----------

const browsers = new Set<WebSocket>();
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const ws of browsers) if (ws.readyState === 1) ws.send(s);
}
function broadcastBinary(buf: Buffer) {
  for (const ws of browsers) if (ws.readyState === 1) ws.send(buf);
}

let lastProgressAt = 0;

eng.engine.on('progress', (p: { jobId: string; value: number; step: number | null; steps: number | null }) => {
  const now = Date.now();
  const step = p.step ?? Math.round(p.value * 100);
  const max = p.steps ?? 100;
  // Measure seconds/step for ETA (ignore first step: includes model load)
  if (lastProgressAt && p.step && p.step > 1) {
    const t = takes.byPrompt(p.jobId);
    if (t) {
      const s = JSON.parse(t.settings);
      const key = `${t.kind}|${s.width}x${s.height}|${s.lengthFrames ?? 0}`;
      const prev = speed.get(key);
      const sps = (now - lastProgressAt) / 1000;
      speed.set(key, prev ? prev * 0.7 + sps * 0.3 : sps);
    }
  }
  lastProgressAt = now;
  broadcast({ type: 'progress', promptId: p.jobId, value: step, max });
});

eng.engine.on('preview', ({ jobId, data }: { jobId: string; data: Buffer }) => {
  // The socket keeps order, so the browser pairs the next binary frame with this job.
  broadcast({ type: 'preview', promptId: jobId });
  broadcastBinary(data);
});

eng.engine.on('status', ({ jobId, status }: { jobId: string; status: string }) => {
  // the engine started this job: until then a take is waiting in the engine's line
  if (status === 'running') broadcast({ type: 'started', promptId: jobId });
  broadcast({ type: 'queue', remaining: takes.active().length });
});

eng.engine.on('finished', ({ jobId }: { jobId: string }) => void onPromptFinished(jobId));

async function onPromptFinished(promptId: string) {
  const take = takes.byPrompt(promptId);
  // A stopped take stays stopped: its job's late end (canceled, expired) is not news.
  if (!take || take.status === 'done' || take.status === 'stopped') return;
  try {
    const h = await eng.result(promptId);
    if (!h.done) return;
    if (!h.success || !h.output) {
      takes.fail(take.id, h.error || 'No output produced', !!h.canceled);
      broadcast({ type: 'take', take: takes.get(take.id) });
      nextInScene(take);
      return;
    }
    const out = { filename: h.output.name };
    const data = h.output.data;
    const s = JSON.parse(take.settings);
    const project = take.project_id ? projects.get(take.project_id) : undefined;
    const folder = project?.folder || config.outputDir;
    const ext = extname(out.filename).slice(1) || (take.kind === 'still' ? 'png' : 'mp4');
    // An upscale keeps its source's name: <shot>_<source seed>_UP.
    const path = await saveToProject(folder, s.shotName || 'shot', s.fileSeed ?? s.seed ?? 0, data, {
      ext,
      upres: take.kind === 'upres' || s.app === 'upscale',
      suffix: s.app === 'seam' ? '_LOOP' : s.app === 'hdr' ? '_HDR' : undefined,
    });
    await saveSidecars(path, h.extras ?? []);
    let shown = path;
    if (s.app === 'cutout' && ext === 'mov') {
      // ProRes 4444 is the deliverable; browsers cannot play it, so the take
      // shows a preview of the cut out over a checkerboard.
      shown = await checkerPreview(path);
      takes.patchSettings(take.id, { alphaPath: path });
    }
    takes.finish(take.id, shown, h.renderSeconds);
    broadcast({ type: 'take', take: takes.get(take.id) });
    nextInScene(take);
    // Seam check for loops (and the next fix if it is still visible), HDR downloads.
    void afterRender(take.id).catch((e) => console.error(`[openfield] after take ${take.id}:`, e instanceof Error ? e.message : e));
    // Voice transcript for videos, best-effort in the background
    if (take.kind !== 'still' && take.kind !== 'object') {
      transcribe(path).then((t) => {
        if (t) {
          takes.setTranscript(take.id, t);
          broadcast({ type: 'take', take: takes.get(take.id) });
        }
      });
    }
  } catch (e) {
    takes.fail(take.id, e instanceof Error ? e.message : 'post-processing failed');
    broadcast({ type: 'take', take: takes.get(take.id) });
    nextInScene(take);
  }
}

/**
 * Side outputs saved next to a take's file: an object's turntable
 * (<file>.turntable.mp4, also its poster) and its isolated subject
 * (<file>.subject.png). Best effort; the take stands without them.
 */
async function saveSidecars(path: string, extras: NonNullable<eng.JobResult['extras']>) {
  const { writeFile } = await import('fs/promises');
  for (const x of extras) {
    const ext = x.nodeId === 'turntable' ? 'mp4' : x.nodeId === 'subject' ? 'png' : null;
    if (!ext) continue;
    await writeFile(`${path}.${x.nodeId}.${ext}`, x.data).catch((e) => console.error(`[openfield] could not save the ${x.nodeId} of ${path}:`, e instanceof Error ? e.message : e));
  }
}

/** A Director scene shot (or its hero frame) settled: move its scene on. */
function nextInScene(take: { settings: string }) {
  const cut = Number(JSON.parse(take.settings).sceneOf);
  if (cut) void advance(cut);
}

app.get('/live', { websocket: true }, (conn) => {
  browsers.add(conn);
  conn.on('close', () => browsers.delete(conn));
});

// ---------- API ----------

app.get('/api/status', async () => {
  const [st, api, renderTier, videoDecode] = await Promise.all([comfy.getStatus(), eng.apiUp(), tierState(), videoDecodeState()]);
  return {
    ...st,
    // Cloud target: the local ComfyUI server is irrelevant, the v2 API is the engine.
    up: eng.isLocal() ? st.up && api : api,
    api,
    target: eng.isLocal() ? 'local' : 'cloud',
    active: takes.active(),
    canLaunch: comfy.canLaunchEngine(),
    comfyUrl: config.comfyUrl,
    renderTier,
    videoDecode,
    // OPENFIELD_LLM_REASONING overrides the Director's "Think first" switch; the page shows it as set by the server.
    plannerReasoning: plannerReasoningOverride(),
    judge: judgeState?.(),
  };
});

/**
 * Machine-wide settings; each state says where its value came from.
 * renderTier: the video render size. videoDecode: whole-clip or chunked video decode.
 */
app.get('/api/settings', async () => ({ renderTier: await tierState(), videoDecode: await videoDecodeState() }));
app.put('/api/settings', async (req, reply) => {
  const b = (req.body ?? {}) as { renderTier?: unknown; videoDecode?: unknown };
  if ('renderTier' in b && b.renderTier !== null && !isRenderTier(b.renderTier)) {
    return reply.code(400).send({ error: 'renderTier is 480p, 720p, 1080p, or null for the default' });
  }
  if ('videoDecode' in b && b.videoDecode !== null && !isVideoDecode(b.videoDecode)) {
    return reply.code(400).send({ error: 'videoDecode is whole, chunked, or null for the default' });
  }
  if ('renderTier' in b) setTier(b.renderTier as RenderTier | null);
  if ('videoDecode' in b) setVideoDecode(b.videoDecode as VideoDecode | null);
  return { renderTier: await tierState(), videoDecode: await videoDecodeState() };
});

app.post('/api/upload', async (req, reply) => {
  const { name, dataUrl } = req.body as { name: string; dataUrl: string };
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl || '');
  if (!m) return reply.code(400).send({ error: 'dataUrl required' });
  const sub = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9-]/gi, '');
  // Audio and video MIME subtypes are not file extensions; LoadAudio and the
  // video loaders pick a decoder by extension.
  const ext = ({ mpeg: 'mp3', 'x-wav': 'wav', wave: 'wav', 'x-m4a': 'm4a', mp4a: 'm4a', quicktime: 'mov', 'x-flac': 'flac', 'gltf-binary': 'glb' } as Record<string, string>)[sub] ?? sub.replace(/-/g, '');
  const stored = await eng.uploadInput(`openfield_${Date.now()}_${safeShotName(name)}.${ext}`, Buffer.from(m[2], 'base64'), m[1]);
  return { name: stored };
});

// ---------- film it on your phone ----------
// The phone never talks to this server. phone.ts runs its own single-use LAN
// listener; we hand it a place to put the clip and relay its state on /live.

app.post('/api/phone/start', async (_req, reply) => {
  try {
    const info = await openPhoneSession({
      port: config.phonePort,
      host: config.phoneHost,
      onClip: async (clip) => ({
        token: await eng.uploadInput(`openfield_phone_${Date.now()}_${safeShotName(clip.name.replace(/\.[^.]+$/, ''))}.${clip.ext}`, clip.data, clip.mime),
        name: clip.name,
        bytes: clip.data.length,
      }),
      onState: (id, st) => broadcast({ type: 'phone', id, ...st }),
    });
    return info;
  } catch (e) {
    return reply.code(503).send({ error: e instanceof Error ? e.message : 'could not open the phone link' });
  }
});

app.post('/api/phone/stop', async (req) => {
  const id = (req.body as { id?: string } | undefined)?.id;
  if (!id || phoneSession()?.id === id) closePhoneSession('cancelled');
  return { ok: true };
});

app.get('/api/phone', async () => ({ session: phoneSession() }));

interface Built {
  graph: Record<string, unknown>;
  kind: string;
  /** Server-measured facts that replace what the client sent (sizes, frame counts). */
  settings?: Record<string, unknown>;
  parent?: number;
}

/** What the continue tools need to know about an uploaded clip or sound file. */
interface Probe { seconds: number; frames: number; w: number; h: number; audio: boolean; video: boolean }
const probes = new Map<string, Probe>();
async function probeInput(token: string): Promise<Probe> {
  const hit = probes.get(token);
  if (hit) return hit;
  const inp = await eng.readInput(token);
  if (!inp) throw new Error('That input is no longer on this machine. Add it again.');
  const { mkdtemp, writeFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const dir = await mkdtemp(join(tmpdir(), 'openfield-probe-'));
  const file = join(dir, `in${extname(inp.name) || '.bin'}`);
  try {
    await writeFile(file, inp.data);
    const ffprobe = config.ffprobeBin;
    const { execFile } = await import('child_process');
    const out = await new Promise<string>((res, rej) =>
      execFile(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json', file], (e, o) => (e ? rej(e) : res(o))),
    );
    const d = JSON.parse(out);
    const streams: any[] = d.streams ?? [];
    const v = streams.find((x) => x.codec_type === 'video');
    const seconds = Number(v?.duration) || Number(d.format?.duration) || 0;
    const p: Probe = {
      seconds,
      frames: Math.floor(seconds * LTX25_FPS + 1e-6),
      w: v?.width ?? 0,
      h: v?.height ?? 0,
      audio: streams.some((x) => x.codec_type === 'audio'),
      video: !!v,
    };
    probes.set(token, p);
    return p;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A request's frame: its own width and height when it sends both, else the
 * render tier (Setup, OPENFIELD_RENDER_TIER or the GPU; a `resolution` field
 * overrides it for this request) at the source's shape, held at the app's
 * largest safe size (APP_MAX_TIER). 64-aligned for two-stage renders and
 * IC-LoRA guides, 32 for the single-stage continue tools.
 */
async function frameFor(b: any, app: TierApp, src: { w?: number; h?: number } | null | undefined, align: 32 | 64): Promise<{ width: number; height: number }> {
  const w = Number(b.width), h = Number(b.height);
  if (w > 0 && h > 0) return { width: w, height: h };
  const s = tierSizeOf(appTier(app, parseTier(b.resolution) ?? (await currentTier())), src?.w, src?.h, align);
  return { width: s.w, height: s.h };
}

/** Pixel size of an uploaded still, or null. */
async function stillDims(token: unknown): Promise<{ w: number; h: number } | null> {
  if (typeof token !== 'string' || !token) return null;
  const inp = await eng.readInput(token).catch(() => null);
  return inp ? imageDims(inp.data) : null;
}

/** Frame size of an uploaded clip, or null when it cannot be read. */
async function clipDims(token: unknown): Promise<{ w: number; h: number } | null> {
  if (typeof token !== 'string' || !token) return null;
  const p = await probeInput(token).catch(() => null);
  return p?.w && p.h ? { w: p.w, h: p.h } : null;
}

/**
 * Edit: Qwen-Image-Edit on 1 to 3 input images. The output keeps the first
 * image's aspect (or, for Expand, takes the target aspect), so its size is read
 * from the uploaded file's header. Returns the size so the take records it.
 */
async function editGraph(b: any, seed: number) {
  const images: string[] = Array.isArray(b.images) ? b.images.filter((x: unknown) => typeof x === 'string' && x).slice(0, 3) : [];
  if (!images.length) throw new Error('Edit needs an image');
  if (typeof b.instruction !== 'string' || !b.instruction.trim()) throw new Error('Edit needs an instruction');
  const src = await eng.readInput(images[0]);
  const dims = src ? imageDims(src.data) : null;
  if (!dims) throw new Error('Could not read the size of the image being edited (use PNG, JPEG or WebP)');
  const mp = Math.max(0.25, Math.min(2, Number(b.mp) || 1));
  const quality = b.quality === 'draft' ? 'draft' : 'quality';
  const steps = Number.isFinite(b.steps) ? Math.max(4, Math.min(50, Math.round(b.steps))) : undefined;
  // Optional LoRAs are used only when the engine lists them, so an install
  // without them still renders (on the base-model Lightning, without angles).
  const have = new Set(await comfy.comboOptions('LoraLoaderModelOnly', 'lora_name'));
  const lightning = editLightning(have);
  const loras = (b.mode === 'angle' || b.mode === 'pushin') && have.has(EDIT_ANGLES_LORA) ? [{ name: EDIT_ANGLES_LORA, strength: 1 }] : [];
  const common = { images, instruction: b.instruction, seed, quality, steps, lightning, loras } as const;
  if (b.expand) {
    const aspect = Number(b.expand.aspect) || dims.w / dims.h;
    const lay = expandLayout(dims.w, dims.h, aspect, Number(b.expand.zoom) || 1, mp);
    return {
      graph: buildEditGraph({ ...common, width: lay.width, height: lay.height, pad: lay.pad }),
      // Where the original sits on the new canvas, for the before/after view.
      size: { width: lay.width, height: lay.height, inner: { x: lay.pad.left, y: lay.pad.top, w: lay.pad.inner.width, h: lay.pad.inner.height } },
    };
  }
  const size = editSize(dims.w, dims.h, mp);
  return {
    graph: buildEditGraph({
      ...common, width: size.width, height: size.height,
      mask: typeof b.mask === 'string' && b.mask ? b.mask : undefined,
    }),
    size,
  };
}

/**
 * A finished take as an input file: its output uploaded as an asset, with the
 * names the new take inherits. Shared by Cut out (and anything else that
 * starts from a take by id).
 */
async function stageTake(id: number): Promise<{ file: string; localPath: string; parent: number; shotName: string; fileSeed?: number }> {
  const src = takes.get(id);
  if (!src?.output_path) throw new Error(`take ${id} not found or unfinished`);
  if (!existsSync(src.output_path)) throw new Error(`take ${src.id}'s file is no longer on disk: ${src.output_path}`);
  const ext = extname(src.output_path).toLowerCase() || '.mp4';
  const data = await import('fs/promises').then((fs) => fs.readFile(src.output_path!));
  const file = await eng.uploadInput(`openfield_take_${src.id}${ext}`, data, ext === '.png' ? 'image/png' : 'video/mp4');
  const ss = JSON.parse(src.settings);
  return { file, localPath: src.output_path, parent: src.id, shotName: ss.shotName || src.shot_name, fileSeed: ss.fileSeed ?? ss.seed };
}

/**
 * Cut out (Remove background): a still or a clip, from a take or an upload.
 * Sizes and frame counts come from the real file.
 */
async function cutoutGraph(b: any): Promise<Built> {
  const background: CutoutBackground = ['color', 'blur', 'image'].includes(b.background) ? b.background : 'transparent';
  const bg = {
    background,
    color: typeof b.color === 'string' ? b.color : undefined,
    backgroundImage: background === 'image' ? (typeof b.backgroundImage === 'string' && b.backgroundImage ? b.backgroundImage : undefined) : undefined,
  };
  if (background === 'image' && !bg.backgroundImage) throw new Error('A new background needs a picture');
  let file: string;
  let localPath: string | null;
  let parent: number | undefined;
  let named: { shotName?: string; fileSeed?: number } = {};
  if (b.sourceTake) {
    const st = await stageTake(Number(b.sourceTake));
    ({ file, localPath, parent } = st);
    named = { shotName: `${st.shotName}_cutout`.slice(0, 60), fileSeed: st.fileSeed };
  } else {
    file = typeof b.image === 'string' && b.image ? b.image : typeof b.sourceVideo === 'string' ? b.sourceVideo : '';
    if (!file) throw new Error('Remove background needs a still or a clip');
    localPath = eng.inputPath(file);
    if (!localPath) throw new Error('the uploaded source is gone; add it again');
  }
  const m = await probeMedia(localPath);
  const common = { app: 'cutout', background, color: bg.color, backgroundImage: bg.backgroundImage, sourceKind: m.kind, sourceTake: parent, sourceWidth: m.w, sourceHeight: m.h, ...named };
  if (m.kind === 'image') {
    return {
      kind: 'still', parent,
      graph: buildCutoutStillGraph({ image: file, width: m.w, height: m.h, ...bg }),
      settings: { ...common, mode: 'matte', image: file, width: m.w, height: m.h },
    };
  }
  const mode: CutoutMethod = b.mode === 'hybrid' || b.mode === 'track' ? b.mode : 'matte';
  const size = cutoutSize(m.w, m.h);
  const cap = Math.floor(Math.min(CUTOUT_MAX_SECONDS, Number(b.seconds) || CUTOUT_MAX_SECONDS) * m.fps);
  const frames = Math.max(1, Math.min(m.frames || cap, cap));
  const withAudio = !!b.withAudio && m.audio;
  return {
    kind: 'video', parent,
    graph: buildCutoutVideoGraph({
      sourceVideo: file, width: size.w, height: size.h, frames, fps: m.fps, method: mode,
      subject: typeof b.subject === 'string' ? b.subject : undefined, withAudio, ...bg,
    }),
    settings: {
      ...common, mode, subject: b.subject || undefined, sourceVideo: file, width: size.w, height: size.h, fps: m.fps, frames,
      seconds: Math.round((frames / m.fps) * 10) / 10, withAudio,
    },
  };
}

/**
 * Restyle and Object swap (Mirror): an edited first frame carried through the
 * clip's motion. The page compiles the edit instruction and the shot prompt;
 * they are rebuilt here from the style and words when a caller leaves them out.
 */
async function motionEditGraph(b: any, seed: number): Promise<Built> {
  if (!b.sourceVideo) throw new Error(`${b.kind === 'swap' ? 'Object swap' : 'Restyle'} needs a source clip`);
  const quality = b.quality === 'quality' || (b.kind === 'swap' && b.quality !== 'draft') ? 'quality' : 'draft';
  const lightning = editLightning(new Set(await comfy.comboOptions('LoraLoaderModelOnly', 'lora_name')));
  const { width, height } = await frameFor(b, b.kind === 'swap' ? 'swap' : 'restyle', await clipDims(b.sourceVideo), 64);
  if (b.kind === 'restyle') {
    const look = restyleLook(b.style, String(b.text ?? ''));
    if (!look && !b.instruction) throw new Error('Pick a style or describe the look');
    return {
      kind: 'video',
      graph: buildRestyleGraph({
        sourceVideo: b.sourceVideo,
        instruction: typeof b.instruction === 'string' && b.instruction ? b.instruction : restyleInstruction(look),
        prompt: typeof b.prompt === 'string' && b.prompt ? b.prompt : restylePrompt(look),
        negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
        width, height, seconds: Math.max(1, Math.min(12, Number(b.seconds) || 5)), seed,
        control: b.control === 'edges' ? 'edges' : 'depth',
        guideStrength: Number.isFinite(b.guideStrength) ? b.guideStrength : undefined,
        lightning, quality, withAudio: !!b.withAudio,
      }),
      settings: { width, height },
    };
  }
  const target = String(b.target ?? '').trim();
  const replacement = String(b.replacement ?? '').trim();
  if (!target) throw new Error('Say what to replace');
  if (!replacement && !b.reference) throw new Error('Say what it becomes, or add a picture of it');
  const point = b.point && Number.isFinite(b.point.x) && Number.isFinite(b.point.y)
    ? { x: Math.max(0, Math.min(1, Number(b.point.x))), y: Math.max(0, Math.min(1, Number(b.point.y))) } : undefined;
  return {
    kind: 'video',
    graph: buildSwapGraph({
      sourceVideo: b.sourceVideo, target, point, replacement: replacement || 'the object in image 2',
      reference: typeof b.reference === 'string' && b.reference ? b.reference : undefined,
      prompt: typeof b.prompt === 'string' && b.prompt ? b.prompt : swapPrompt(replacement || 'the new object'),
      width, height, seconds: Math.max(1, Math.min(8, Number(b.seconds) || 4)), seed, lightning, quality,
    }),
    settings: { width, height },
  };
}

async function graphFor(b: any, seed: number): Promise<Built> {
  let graph: Record<string, unknown>;
  let kind: string;

  if (b.kind === 'upscale') return upscaleGraph(b, seed);
  if (b.kind === 'cutout') return cutoutGraph(b);
  if (b.kind === 'restyle' || b.kind === 'swap') return motionEditGraph(b, seed);
  if (b.kind === 'seam') return seamGraph(b, seed);
  if (b.kind === 'hdr') return hdrGraph(b, seed);
  if (b.kind === 'stage-look') return stageLookGraph(b, seed);
  if (b.kind === 'stage') return stageShotGraph(b, seed);
  if (b.kind === 'object') return objectGraph(b, seed);

  // Cast engines (resolveCast decided them from the @mentions).
  if (b.castEngine === 'sheet' && b.castSheet) {
    return {
      kind: 'video',
      graph: buildCastVideoGraph({
        prompt: b.prompt,
        negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
        layout: b.castSheet,
        seconds: Math.max(1, Math.min(10, Number(b.seconds) || 5)),
        seed,
        withAudio: !!b.withAudio,
        loras: await pickLoras(b.loras, 'ltx', 'Video'),
      }),
    };
  }
  if (b.kind === 'still' && b.castEngine === 'compose') {
    const images: string[] = (Array.isArray(b.castImages) ? b.castImages : []).slice(0, 3);
    if (!images.length) throw new Error('No cast pictures to compose from');
    const have = new Set(await comfy.comboOptions('LoraLoaderModelOnly', 'lora_name'));
    const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
    // Qwen-Image-Edit is happiest near 1 MP; keep the requested aspect.
    const ratio = (Number(b.width) || 1328) / (Number(b.height) || 752);
    const h = Math.sqrt(Math.min(1.3e6, (Number(b.width) || 1328) * (Number(b.height) || 752)) / ratio);
    const size = { width: snap(h * ratio), height: snap(h) };
    return {
      kind: 'still',
      graph: buildEditGraph({
        images, instruction: String(b.castInstruction ?? b.prompt ?? ''), ...size, seed,
        quality: b.quality === 'draft' ? 'draft' : 'quality',
        lightning: editLightning(have),
        compose: true,
        loras: await pickLoras(b.loras, 'qwen', 'Image'),
      }),
      settings: size,
    };
  }

  if (b.kind === 'edit') {
    const e = await editGraph(b, seed);
    return { graph: e.graph, kind: 'still', settings: e.size };
  }

  if (b.kind === 'extend') {
    if (!b.sourceVideo) throw new Error('Extend needs a clip');
    const src = await probeInput(b.sourceVideo);
    if (!src.video || src.frames < 17) throw new Error('Extend needs a video clip of at least 1 second');
    const size = await frameFor(b, 'extend', src, 32);
    return {
      kind: 'video',
      graph: buildExtendGraph({
        prompt: b.prompt || '',
        negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
        sourceVideo: b.sourceVideo,
        sourceFrames: Math.min(src.frames, 20 * LTX25_FPS),
        sourceHasAudio: src.audio,
        ...size,
        seconds: Math.max(1, Math.min(10, Number(b.seconds) || 3)),
        direction: b.direction === 'backward' ? 'backward' : 'forward',
        seed,
        withAudio: b.withAudio !== false,
      }),
      settings: size,
    };
  }
  if (b.kind === 'transition') {
    const end = async (video?: string, image?: string) => {
      if (video) {
        const p = await probeInput(video);
        return { e: { file: video, kind: 'video' as const, frames: Math.min(p.frames, 20 * LTX25_FPS), hasAudio: p.audio }, p };
      }
      if (image) return { e: { file: image, kind: 'image' as const } };
      throw new Error('Transition needs a take on each side');
    };
    const A = await end(b.startVideo, b.startImage);
    const B = await end(b.endVideo, b.endImage);
    const size = await frameFor(b, 'transition', A.p ?? B.p ?? (await stillDims(b.startImage)) ?? (await stillDims(b.endImage)), 32);
    return {
      kind: 'video',
      graph: buildTransitionGraph({
        // The page compiles the style chip and the user's words into the prompt.
        prompt: b.prompt || 'One continuous shot. The first scene fluidly morphs into the second without a cut.',
        a: A.e, b: B.e,
        ...size,
        seconds: Math.max(1, Math.min(6, Number(b.seconds) || 2)),
        seed,
        withAudio: b.withAudio ?? !!(A.e.hasAudio || (B.e as any).hasAudio),
      }),
      settings: size,
    };
  }
  if (b.kind === 'speak') {
    if (!b.startImage) throw new Error('Speak needs a face or a start frame');
    if (!b.audio) throw new Error('Speak needs a sound file');
    const a = await probeInput(b.audio);
    const start = Math.max(0, Number(b.audioStart) || 0);
    const left = Math.max(1, a.seconds - start);
    const size = await frameFor(b, 'speak', await stillDims(b.startImage), 64);
    return {
      kind: 'video',
      graph: buildSpeakGraph({
        prompt: b.prompt || 'A person speaks to the camera.',
        negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
        image: b.startImage,
        audio: b.audio,
        audioStart: start,
        seconds: Math.max(1, Math.min(10, Number(b.seconds) || left, left)),
        ...size,
        seed,
      }),
      settings: size,
    };
  }
  if (b.kind === 'sound') {
    if (!b.sourceVideo) throw new Error('Add sound needs a clip');
    const src = await probeInput(b.sourceVideo);
    if (!src.video || src.frames < 9) throw new Error('Add sound needs a video clip');
    // The picture is only read, never redrawn, so encode it small: the sound comes out the same.
    const ratio = (src.w || 16) / (src.h || 9);
    const h = Math.sqrt(0.37e6 / ratio);
    return {
      kind: 'video',
      graph: buildSoundGraph({
        prompt: b.prompt || 'Natural ambient sound that matches the scene.',
        negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
        sourceVideo: b.sourceVideo,
        sourceFrames: Math.min(src.frames, 20 * LTX25_FPS),
        width: h * ratio,
        height: h,
        seed,
      }),
    };
  }

  let size: { width: number; height: number } | undefined;
  if (b.kind === 'effect') {
    kind = 'video';
    const fx = effectById(b.effect);
    size = await frameFor(b, 'effects', fx?.input === 'still' ? await stillDims(b.startImage) : await clipDims(b.sourceVideo), 64);
    graph = buildEffectGraph({ ...b, ...size }, seed);
  } else if (b.kind === 'reshoot' || b.kind === 'reshoot-preview') {
    kind = 'video';
    if (!b.sourceVideo) throw new Error('Reshoot needs a source clip');
    size = await frameFor(b, 'reshoot', await clipDims(b.sourceVideo), 32);
    const common = {
      sourceVideo: b.sourceVideo,
      ...size,
      seconds: Math.max(1, Math.min(8, b.seconds || 4)),
      azimuth: Number(b.azimuth) || 0,
      elevation: Number(b.elevation) || 0,
      keyframes: Array.isArray(b.keyframes) ? b.keyframes : undefined,
      pivotDepth: Number.isFinite(b.pivotDepth) ? b.pivotDepth : undefined,
    };
    graph = b.kind === 'reshoot-preview'
      ? buildReshootWarpPreviewGraph(common)
      : buildReshootGraph({ ...common, prompt: b.prompt || '', seed, withAudio: !!b.withAudio });
  } else if (b.kind === 'mirror') {
    kind = 'video';
    if (!b.sourceVideo) throw new Error('Mirror needs a source clip');
    size = await frameFor(b, 'mirror', await clipDims(b.sourceVideo), 64);
    graph = buildMirrorGraph({
      prompt: b.prompt,
      negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
      sourceVideo: b.sourceVideo,
      firstFrame: b.startImage || undefined,
      ...size,
      seconds: Math.max(1, Math.min(12, b.seconds || 5)),
      seed,
      control: b.control === 'depth' || b.control === 'edges' ? b.control : 'pose',
      guideStrength: Number.isFinite(b.guideStrength) ? b.guideStrength : undefined,
      withAudio: !!b.withAudio,
    });
  } else if (b.kind === 'still') {
    kind = 'still';
    const flux2 = b.model === 'flux2';
    graph = buildStillsGraph({
      model: flux2 ? 'flux2' : 'qwen',
      quality: b.quality === 'draft' ? 'draft' : 'quality',
      prompt: b.prompt,
      negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
      width: b.width || 1328,
      height: b.height || 752,
      seed,
      loras: await pickLoras(b.loras, flux2 ? 'flux2' : 'qwen', 'Image'),
      // FLUX.2 references: your own pictures first, then the cast's (resolveCast).
      refImages: flux2 ? flux2Refs(b) : undefined,
    });
  } else if (b.videoModel === 'ltx25') {
    kind = 'video';
    // LTX-2.5 loads its transformer / encoder / VAEs by fixed name, so there is
    // no checkpoint to pick. Supplying both a start and an end image switches
    // the builder to flf2v; passing the same file for both closes a loop.
    size = await frameFor(b, 'video', await stillDims(b.startImage), 64);
    graph = buildLtx25Graph({
      prompt: b.prompt,
      negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
      ...size,
      seconds: Math.max(1, Math.min(20, b.seconds || 5)),
      seed,
      fps: b.fps || LTX25_FPS,
      startImage: b.startImage,
      endImage: b.endImage,
      withAudio: !!b.withAudio,
      videoCfg: b.videoCfg,
      audioCfg: b.audioCfg,
      transformer: typeof b.checkpoint === 'string' && b.checkpoint ? b.checkpoint : undefined,
      loras: (await pickLoras(b.loras, 'ltx', 'Video')).map((l) => ({ file: l.name, strength: l.strength })),
    });
  } else if (b.videoModel === 'ltx') {
    kind = 'video';
    if (!b.checkpoint) {
      throw new Error('LTX requires a checkpoint selection');
    }
    // Transformer-only files (SpiceModels quants) appear in the UNETLoader
    // enum; they load there and borrow VAE/audio-VAE from the donor checkpoint.
    const families = await comfy.listCheckpoints().catch(() => ({} as Record<string, string[]>));
    const modelIsUnet = (families['unets_all'] ?? []).includes(b.checkpoint);
    size = await frameFor(b, 'video', await stillDims(b.startImage), 64);
    graph = buildLtxGraph({
      prompt: b.prompt,
      ...size,
      seconds: Math.max(1, Math.min(10, b.seconds || 5)),
      seed,
      checkpoint: b.checkpoint,
      modelIsUnet,
      // Default: fine-tunes (unet-loaded) get dev sampling, official gets distilled
      sampling: b.sampling === 'dev' || b.sampling === 'distilled'
        ? b.sampling
        : modelIsUnet ? 'dev' : 'distilled',
      extraLora: typeof b.extraLora === 'string' && b.extraLora ? b.extraLora : undefined,
      extraLoraStrength: b.extraLoraStrength,
      startImage: b.startImage,
    });
  } else {
    kind = 'video';
    const turbo = typeof b.h3Turbo === 'string' && b.h3Turbo ? b.h3Turbo : undefined;
    if (turbo) {
      const problem = turboProblem(turbo, !!b.refImages?.length, new Set(await comfy.comboOptions('LoraLoaderModelOnly', 'lora_name')));
      if (problem) throw new Error(problem);
    }
    graph = buildH3Graph({
      prompt: b.prompt,
      width: b.width || 864,
      height: b.height || 480,
      lengthFrames: snapH3Length(b.lengthFrames || 124),
      seed,
      steps: b.steps || 20,
      startImage: b.startImage,
      endImage: b.endImage,
      refImages: b.refImages,
      checkpoint: typeof b.checkpoint === 'string' ? b.checkpoint : undefined,
      extraLora: typeof b.extraLora === 'string' && b.extraLora ? b.extraLora : undefined,
      extraLoraStrength: b.extraLoraStrength,
      // Turbo overrides steps/shift inside the builder; '' = full sampling.
      turbo,
      // House rule: no audio on visual loops. Opt in per shot for dialogue.
      withAudio: !!b.withAudio,
    });
  }

  const post = directorPost(b, graph);
  return { graph, kind, settings: size || post ? { ...size, ...post } : undefined };
}

/**
 * Director post passes on a still or an LTX-2.5 shot: the era grade (when an
 * era is set and the grade is on) and the speed ramp. Returns what the take
 * should record about them: the length after the ramp, and that it is silent.
 */
function directorPost(b: any, graph: Record<string, unknown>): Record<string, unknown> | undefined {
  const still = b.kind === 'still';
  const ltx = b.kind === 'video' && b.videoModel === 'ltx25';
  if (!still && !ltx) return undefined;
  const era = b.era == null || b.era === '' || !Number.isFinite(Number(b.era)) ? null : clampEra(Number(b.era));
  const grade = era != null && b.eraGrade !== false ? eraGrade(era) : undefined;
  const ramp = ltx && isRamp(b.ramp) && b.ramp !== 'linear' ? b.ramp : undefined;
  if (!grade && !ramp) return undefined;
  const fps = b.fps || LTX25_FPS;
  const frames = ltx ? snapFrames(Math.max(1, Math.min(20, b.seconds || 5)), fps) : undefined;
  const r = applyPost(graph as Record<string, any>, { grade, ramp, frames });
  return {
    era, eraGraded: !!grade,
    ...(ramp ? { ramp, outFrames: r.outFrames, outSeconds: Math.round(((r.outFrames ?? 0) / fps) * 10) / 10, rampSilent: r.silent } : {}),
  };
}

/**
 * Effects: the LoRA file, strength, trigger and negative come from the effect
 * definition (src/effects.ts), never from the request. Clip effects are
 * IC-LoRA video-to-video; still effects are image-to-video with a plain LoRA.
 */
function buildEffectGraph(b: any, seed: number): Record<string, unknown> {
  const fx = effectById(b.effect);
  if (!fx) throw new Error(`Unknown effect "${b.effect}"`);
  if (fx.input === 'clip' && !b.sourceVideo) throw new Error(`${fx.name} needs a source clip`);
  if (fx.input === 'still' && !b.startImage) throw new Error(`${fx.name} needs a still`);
  const prompt = typeof b.prompt === 'string' ? b.prompt : effectPrompt(fx, String(b.text ?? ''));
  const lora = { file: fx.lora, strength: fx.strength, trigger: fx.trigger };
  return buildLtx25Graph({
    prompt,
    negative: fx.negative,
    width: b.width,
    height: b.height,
    seconds: Math.max(1, Math.min(fx.maxSeconds, b.seconds || 5)),
    seed,
    startImage: fx.input === 'still' ? b.startImage : undefined,
    endImage: fx.input === 'still' && fx.loopable && b.loop ? b.startImage : undefined,
    withAudio: !!b.withAudio,
    ...(fx.ic ? { icLora: { ...lora, video: b.sourceVideo } } : { loras: [lora] }),
    filenamePrefix: `openfield/effect_${fx.id}`,
  });
}

/**
 * Keep the graph behind a take so it can be opened in ComfyUI later. Our own
 * copy is stored at once; the engine's record of what actually ran (with the
 * input filenames ComfyUI really has) replaces it as soon as it answers.
 */
async function recordWorkflow(takeId: number, jobId: string, graph: Record<string, unknown>) {
  try {
    takeWorkflows.set(takeId, await eng.withInputNames(graph), 'submitted');
    const ran = await eng.executedWorkflow(jobId);
    if (ran) takeWorkflows.set(takeId, ran, 'engine');
  } catch (e) {
    console.error(`[openfield] could not record the workflow for take ${takeId}:`, e instanceof Error ? e.message : e);
  }
}

app.post('/api/generate', async (req, reply) => {
  const b = req.body as any;
  stripServerKeys(b);
  // Scene bookkeeping is set by the scene runner only; a recreated shot is a plain take.
  delete b.sceneOf; delete b.sceneIndex; delete b.sceneStep;
  if (b.cut) return reply.code(400).send({ error: 'A cut is made from its shots. Use /api/director/scene (Recreate in the app does).' });
  const status = eng.isLocal() ? await comfy.getStatus() : { up: true };
  if (status.up && !(await eng.ensureProxy())) {
    return reply.code(503).send({
      error: `Comfy API v2 is not answering at ${config.comfyBaseUrl}. Install comfy-api-proxy (pip install comfy-api-proxy) or set COMFY_BASE_URL.`,
    });
  }
  if (!status.up) {
    return reply.code(503).send({
      error: comfy.canLaunchEngine()
        ? 'ComfyUI is not running — press START ENGINE'
        : `ComfyUI is not answering at ${config.comfyUrl}. Start it, or set COMFY_URL / COMFY_LAUNCH in .env.`,
    });
  }

  // Say exactly which weights are missing rather than letting ComfyUI reject
  // the graph with a node id the user has never heard of.
  const missing = eng.isLocal() ? await blockingReason(bundlesFor({ ...b, castEngine: castEngineFor(b) })) : null;
  if (missing) return reply.code(412).send({ error: missing });
  const postMissing = eng.isLocal() ? await postBlockingReason(b) : null;
  if (postMissing) return reply.code(412).send({ error: postMissing });
  if (eng.isLocal() && b.kind === 'effect') {
    const fx = effectById(b.effect);
    const fxMissing = fx ? await effectBlockingReason(fx.bundle, fx.lora, fx.name) : null;
    if (fxMissing) return reply.code(412).send({ error: fxMissing });
  }

  if (Array.isArray(b.loras) && b.loras.length) {
    const fam = loraFamily(b);
    if (!fam) return reply.code(400).send({ error: 'Your own LoRAs work in Image and Video (LTX-2.5) for now.' });
    try { await pickLoras(b.loras, fam, b.kind === 'still' ? 'Image' : 'Video'); }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : 'bad LoRA' }); }
  }

  const count = Math.max(1, Math.min(8, Number(b.count) || 1));
  try {
    const takeIds = await queueTakes(b, count);
    if (b.projectId) projects.touch(b.projectId);
    return { takeIds, takeId: takeIds[0] };
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'bad request', takeIds: (e as any)?.takeIds });
  }
});

// ---------- cast ----------

/** The text a body's @mentions live in. */
const castField = (b: any) => (b.kind === 'edit' ? 'instruction' : 'prompt');
const isLtxShot = (b: any) => (b.kind === undefined || b.kind === 'video') && b.videoModel === 'ltx25';

/** FLUX.2 reads up to this many reference pictures per still (each is ~1 MP of latent). */
const FLUX2_REFS = 6;
const ownRefs = (b: any): string[] =>
  (Array.isArray(b.refImages) ? b.refImages : []).filter((x: unknown): x is string => typeof x === 'string' && !!x).slice(0, FLUX2_REFS);
/** A FLUX.2 still's references: the user's own, then the cast pictures resolveCast picked. */
const flux2Refs = (b: any): string[] => {
  const cast = b.castEngine === 'flux2ref' && Array.isArray(b.castImages) ? b.castImages : [];
  return [...ownRefs(b), ...cast].slice(0, FLUX2_REFS);
};

/** The model family an app's own LoRAs must match, or null where they do not apply. */
function loraFamily(b: any): LoraFamily | null {
  if (b.kind === 'still') return b.model === 'flux2' ? 'flux2' : 'qwen';
  if (isLtxShot(b)) return 'ltx';
  return null;
}

/** A hero frame this take waits for before it can be built. */
interface HeroPlan { castIds: number[]; shot: string; opts: HeroOpts; poseFrom?: string }

/** Hero frames are composed near 1 MP at the shot's aspect. */
function heroSize(w: number, h: number) {
  const ratio = (w || 16) / (h || 9);
  const hh = Math.sqrt(1e6 / ratio);
  const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return { width: snap(hh * ratio), height: snap(hh) };
}

/**
 * Turn @mentions in a request into prompt words and engine inputs (see
 * server/cast.ts for the routing table). Returns the rewritten body, plus a
 * hero frame plan when the take needs a composed first frame before it runs.
 * The original text is kept as castSource, so Recreate resolves it afresh.
 */
async function resolveCast(input: any): Promise<{ body: any; hero?: HeroPlan }> {
  const b = { ...input };
  // A hero frame carries its pictures already.
  if (b.app === 'cast' && b.castEngine === 'compose') return { body: b };
  const key = castField(b);
  if (typeof b.castSource === 'string') b[key] = b.castSource;
  if (Array.isArray(b.castOwnImages)) b.images = b.castOwnImages;
  for (const k of ['castEngine', 'castImages', 'castInstruction', 'castSheet', 'castHeroTake', 'cast']) delete b[k];
  const text = typeof b[key] === 'string' ? b[key] : '';
  const all = castDb.list();
  const members = mentioned(text, all);
  if (!members.length) return { body: b };
  for (const m of members) m.refs = await liveRefs(m);
  b.castSource = text;
  b.cast = members.map((m) => m.id);
  const withRefs = members.filter((m) => m.refs.length);
  const words = () => {
    b.castEngine = 'words';
    b[key] = plainText(text, all);
    if (key === 'instruction') b.prompt = b.instruction;
    return { body: b };
  };
  if (!withRefs.length) return words();

  if (b.kind === 'still' && b.model === 'flux2') {
    // FLUX.2 reads the cast pictures as reference latents and renders the frame itself.
    const c = composeInstruction(text, allocate(withRefs, FLUX2_REFS - ownRefs(b).length), { offset: ownRefs(b).length, newFrame: true, all, nameless: true });
    Object.assign(b, { castEngine: 'flux2ref', castImages: c.images, prompt: c.instruction });
    return { body: b };
  }
  if (b.kind === 'still') {
    const c = composeInstruction(text, allocate(withRefs, 3), { newFrame: true, all });
    Object.assign(b, { castEngine: 'compose', castImages: c.images, castInstruction: c.instruction, prompt: c.instruction });
    return { body: b };
  }
  if (b.kind === 'edit') {
    const own: string[] = Array.isArray(b.images) ? b.images.filter((x: unknown) => typeof x === 'string' && x).slice(0, 3) : [];
    if (own.length >= 3 || b.expand) return words();
    const c = composeInstruction(text, allocate(withRefs, 3 - own.length), { offset: own.length, all });
    Object.assign(b, { castEngine: 'edit', castOwnImages: own, images: [...own, ...c.images], instruction: c.instruction, prompt: c.instruction });
    return { body: b };
  }
  if (isLtxShot(b) && !b.startImage && !b.endImage) {
    if (b.castMode === 'frame') {
      b.castEngine = 'frame';
      b.prompt = plainText(text, all);
      return { body: b, hero: { castIds: b.cast, shot: text, opts: { ...heroSize(b.width, b.height), seed: b.seed } } };
    }
    const plan = sheetPlan(text, withRefs, Number(b.width) || 768, Number(b.height) || 448, all);
    Object.assign(b, {
      castEngine: 'sheet', castSheet: plan.layout, prompt: plan.prompt,
      width: plan.layout.width, height: plan.layout.height,
      // The LoRA reads a reference of at least 121 frames: 5 seconds at 24 fps.
      seconds: Math.max(5, Math.min(10, Number(b.seconds) || 5)),
    });
    return { body: b };
  }
  if (b.kind === 'mirror' && !b.startImage && b.sourceVideo) {
    b.castEngine = 'frame';
    b.prompt = plainText(text, all);
    return { body: b, hero: { castIds: b.cast, shot: text, opts: heroSize(b.width, b.height), poseFrom: b.sourceVideo } };
  }
  if (b.kind === 'speak' && !b.startImage) {
    b.castEngine = 'frame';
    b.prompt = plainText(text, all);
    return {
      body: b,
      hero: { castIds: b.cast, shot: text, opts: { ...heroSize(b.width, b.height), framing: 'Head and shoulders, facing the camera, mouth closed and clearly visible, even light on the face.' } },
    };
  }
  return words();
}

/** Which cast engine a request will use, for the missing-weights check before queuing. */
function castEngineFor(b: any): string | undefined {
  const key = castField(b);
  const texts = [b.castSource ?? b[key], ...(Array.isArray(b.variants) ? b.variants.map((v: any) => v?.[key]) : [])]
    .filter((t): t is string => typeof t === 'string');
  const all = castDb.list();
  const ms = texts.flatMap((t) => mentioned(t, all)).filter((m) => m.refs.length);
  if (!ms.length) return undefined;
  if (b.kind === 'still') return b.model === 'flux2' ? 'flux2ref' : 'compose';
  if (isLtxShot(b) && !b.startImage && !b.endImage) return b.castMode === 'frame' ? 'frame' : 'sheet';
  if ((b.kind === 'mirror' || b.kind === 'speak') && !b.startImage) return 'frame';
  return undefined;
}

/** The first frame of an uploaded clip, uploaded as a still (Mirror's pose reference). */
async function firstFrame(token: string): Promise<string> {
  const inp = await eng.readInput(token);
  if (!inp) throw new Error('The clip is no longer on this machine. Add it again.');
  const { mkdtemp, writeFile, readFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { execFile } = await import('child_process');
  const dir = await mkdtemp(join(tmpdir(), 'openfield-frame-'));
  try {
    const src = join(dir, `in${extname(inp.name) || '.mp4'}`);
    const out = join(dir, 'frame.png');
    await writeFile(src, inp.data);
    await new Promise<void>((res, rej) => execFile(config.ffmpegBin, ['-v', 'error', '-y', '-i', src, '-frames:v', '1', out], (e) => (e ? rej(e) : res())));
    return await eng.uploadInput(`openfield_pose_${Date.now()}.png`, await readFile(out), 'image/png');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Submit a built graph for an existing take row. */
async function submitTake(takeId: number, built: Built) {
  const promptId = await eng.submit(built.graph);
  takes.setPrompt(takeId, promptId);
  // Cancelled while it was being submitted: the take stays stopped, so drop the job too.
  if (takes.get(takeId)?.status === 'stopped') await eng.cancel(promptId).catch(() => {});
  void recordWorkflow(takeId, promptId, built.graph);
  broadcast({ type: 'take', take: takes.get(takeId) });
}

/**
 * Build, record and submit takes. A request is either `count` takes of one
 * setup (each with the next seed), or a list of `variants` (the image apps: one
 * take per angle, shot, beat...), each overriding fields of the shared body. A
 * variant's take stores the merged body, so Recreate reruns just that one.
 * Throws with the ids queued so far.
 */
async function queueTakes(b: any, count: number): Promise<number[]> {
  const firstSeed = Number.isFinite(b.seed) ? b.seed : Math.floor(Math.random() * 1e9);
  const variants: Record<string, unknown>[] = Array.isArray(b.variants)
    ? b.variants.filter((v: unknown) => v && typeof v === 'object').slice(0, 9)
    : [];
  stripServerKeys(b);
  variants.forEach(stripServerKeys);
  const n = variants.length || count;
  const batch = variants.length ? `b${Date.now().toString(36)}` : undefined;
  const takeIds: number[] = [];
  let hero: Promise<{ takeId: number; token: string }> | undefined;
  // Stage: the blocking is drawn once and one look frame serves every take of the batch.
  let staged: Promise<any> | undefined;
  let look: Promise<{ takeId: number; token: string }> | undefined;
  for (let i = 0; i < n; i++) {
    const seed = firstSeed + i;
    const raw = variants.length ? { ...b, ...variants[i], variants: undefined, batch, batchIndex: i, batchSize: n }
      : { ...b, batch: undefined, batchIndex: undefined, batchSize: undefined };
    let one: any;
    let built: Built;
    try {
      const r = await resolveCast(raw);
      one = r.body;
      if (r.hero) {
        // The take waits for its hero frame; one frame serves the whole batch.
        hero ??= (async () => {
          const opts = { ...r.hero!.opts, projectId: b.projectId ?? null };
          if (r.hero!.poseFrom) opts.poseImage = await firstFrame(r.hero!.poseFrom);
          return castHeroFrame(r.hero!.castIds, r.hero!.shot, opts);
        })();
        takeIds.push(queueAfter(one, seed, hero, b.projectId ?? null, (body, h) => ({ ...body, startImage: h.token, castHeroTake: h.takeId })));
        continue;
      }
      if (one.kind === 'stage') {
        one = { ...(await (staged ??= prepareStage(one))), seed: one.seed, batch: one.batch, batchIndex: one.batchIndex, batchSize: one.batchSize };
        if (!one.lookImage) {
          const shot = one;
          look ??= stageLookFrame(queueTakes, { ...shot, seed, projectId: b.projectId });
          takeIds.push(queueAfter(one, seed, look, b.projectId ?? null, (body, h) => ({ ...body, lookImage: h.token, lookTake: h.takeId })));
          continue;
        }
      }
      built = await graphFor(one, seed);
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error('bad request'), { takeIds });
    }
    const takeId = takes.create({
      project_id: b.projectId ?? (built.parent ? takes.get(built.parent)?.project_id ?? null : null),
      kind: built.kind,
      shot_name: String(built.settings?.shotName ?? one.shotName ?? 'shot'),
      settings: { ...one, ...built.settings, seed, count: undefined },
      parent_take_id: built.parent,
    });
    try {
      takeIds.push(takeId);
      await submitTake(takeId, built);
    } catch (e) {
      takeIds.pop();
      takes.fail(takeId, e instanceof Error ? e.message : 'submit failed');
      broadcast({ type: 'take', take: takes.get(takeId) });
      throw Object.assign(e instanceof Error ? e : new Error('submit failed'), { takeIds });
    }
  }
  return takeIds;
}

/**
 * A take that needs a still first (a cast hero frame, a Stage look frame): its
 * row exists at once (queued, no engine job yet), and it is built and submitted
 * when the still is done. `apply` puts the still into the take's body.
 */
function queueAfter(
  one: any, seed: number, first: Promise<{ takeId: number; token: string }>, projectId: number | null,
  apply: (body: any, still: { takeId: number; token: string }) => any,
): number {
  const takeId = takes.create({ project_id: projectId, kind: 'video', shot_name: String(one.shotName ?? 'shot'), settings: { ...one, seed, count: undefined } });
  broadcast({ type: 'take', take: takes.get(takeId) });
  void (async () => {
    try {
      const h = await first;
      if (takes.get(takeId)?.status !== 'queued') return; // cancelled while waiting
      const body = apply(one, h);
      const built = await graphFor(body, seed);
      takes.setSettings(takeId, { ...body, ...built.settings, seed, count: undefined });
      await submitTake(takeId, built);
    } catch (e) {
      takes.fail(takeId, e instanceof Error ? e.message : 'the first frame failed');
      broadcast({ type: 'take', take: takes.get(takeId) });
    }
  })();
  return takeId;
}

interface MediaProbe { kind: 'video' | 'image'; w: number; h: number; fps: number; seconds: number; frames: number; audio: boolean }

/** Size, rate, length and whether there is a sound track, from ffprobe. */
async function probeMedia(path: string): Promise<MediaProbe> {
  const { execFile } = await import('child_process');
  const ffprobe = config.ffprobeBin;
  const out = await new Promise<string>((res, rej) =>
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,nb_frames:format=duration,format_name', '-of', 'json', path],
      (err, stdout) => (err ? rej(new Error(`could not read the source file (${err.message.split('\n')[0]})`)) : res(stdout))),
  );
  const d = JSON.parse(out);
  const streams: any[] = d.streams ?? [];
  const v = streams.find((x) => x.codec_type === 'video');
  if (!v) throw new Error('the source has no picture');
  const fmt = String(d.format?.format_name ?? '');
  const image = /image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe/.test(fmt);
  const [n, dd] = String(v.r_frame_rate ?? '24/1').split('/').map(Number);
  const fps = n && dd ? n / dd : 24;
  const seconds = Number(d.format?.duration) || 0;
  return {
    kind: image ? 'image' : 'video',
    w: v.width, h: v.height, fps: Math.round(fps * 1000) / 1000, seconds,
    frames: Number(v.nb_frames) || Math.round(seconds * fps),
    audio: streams.some((x) => x.codec_type === 'audio'),
  };
}

/**
 * Upscale app: stage the source (a finished take, or an uploaded file),
 * measure it, and build the graph for the chosen mode. Sizes are computed
 * here from the real file, with the same upscaleSize() the page shows.
 */
async function upscaleGraph(b: any, seed: number): Promise<Built> {
  const mode: UpscaleMode = b.mode === 'redraw' || b.mode === 'dream' ? b.mode : 'sharpen';
  let localPath: string;
  let file: string;
  let parent: number | undefined;
  let named: { shotName?: string; fileSeed?: number } = {};
  if (b.sourceTake) {
    const src = takes.get(Number(b.sourceTake));
    if (!src?.output_path) throw new Error(`take ${b.sourceTake} not found or unfinished`);
    if (!existsSync(src.output_path)) throw new Error(`take ${src.id}'s file is no longer on disk: ${src.output_path}`);
    localPath = src.output_path;
    const ext = extname(localPath).toLowerCase() || '.mp4';
    const data = await import('fs/promises').then((fs) => fs.readFile(localPath));
    file = await eng.uploadInput(`openfield_up_${src.id}${ext}`, data, ext === '.png' ? 'image/png' : 'video/mp4');
    parent = src.id;
    const ss = JSON.parse(src.settings);
    named = { shotName: b.shotName || ss.shotName || src.shot_name, fileSeed: ss.fileSeed ?? ss.seed };
  } else if (typeof b.source === 'string' && b.source) {
    const p = eng.inputPath(b.source);
    if (!p) throw new Error('the uploaded source is gone; add it again');
    localPath = p;
    file = b.source;
  } else {
    throw new Error('Upscale needs a source: a take or a file');
  }

  const m = await probeMedia(localPath);
  if (mode === 'dream' && m.kind === 'image') throw new Error('Dream upscales video. Use Sharpen or Redraw for a still.');
  const height = REDRAW_HEIGHTS.includes(Number(b.upHeight) as any) ? Number(b.upHeight) : REDRAW_HEIGHTS[0];
  const out = upscaleSize(mode, m.w, m.h, height);
  const source: UpscaleSource = { kind: m.kind, file, withAudio: m.kind === 'video' && m.audio, fps: m.fps };
  const kind = m.kind === 'image' ? 'still' : 'upres';
  const common = {
    app: 'upscale', mode, sourceKind: m.kind, sourceWidth: m.w, sourceHeight: m.h,
    width: out.w, height: out.h, upresOf: parent, sourceTake: parent, source: b.source || undefined, ...named,
  };

  if (mode === 'sharpen') {
    const model = b.model === 'ultrasharp' ? 'ultrasharp' : 'esrgan';
    const rife = m.kind === 'video' && !!b.rife;
    const cap = m.kind === 'video' ? Math.floor(sharpenMaxSeconds(m.w, m.h) * m.fps) : 0;
    const frames = m.kind === 'video' ? Math.min(m.frames, cap) : 1;
    return {
      graph: buildSharpenGraph({ source: { ...source, frameCap: m.kind === 'video' && m.frames > cap ? cap : 0 }, model, scale: out.w / m.w, rife }),
      kind, parent,
      settings: { ...common, model, rife, seconds: m.kind === 'video' ? Math.round((frames / m.fps) * 10) / 10 : undefined },
    };
  }

  if (mode === 'redraw') {
    const model = b.model === '7b' ? '7b' : '3b';
    const color = b.color === 'wavelet' || b.color === 'none' ? b.color : 'lab';
    const cap = m.kind === 'video' ? Math.floor(REDRAW_MAX_SECONDS * m.fps) : 0;
    const frames = m.kind === 'video' ? Math.min(m.frames, cap) : 1;
    // Frames per batch that fit beside the tiled VAE on a 32 GB card.
    const fit = (model === '7b' ? 21 : 33) * (height > 1080 ? 0.6 : 1);
    return {
      graph: buildRedrawGraph({
        source: { ...source, frameCap: m.kind === 'video' && m.frames > cap ? cap : 0 },
        model, resolution: Math.min(out.w, out.h), maxResolution: Math.max(out.w, out.h),
        batchSize: redrawBatch(frames, Math.floor(fit)), color, seed,
      }),
      kind, parent,
      settings: { ...common, model, color, upHeight: height, seconds: m.kind === 'video' ? Math.round((frames / m.fps) * 10) / 10 : undefined },
    };
  }

  const frames = dreamFrames(m.seconds);
  const creativity = Math.max(DREAM_CREATIVITY.min, Math.min(DREAM_CREATIVITY.max, Number.isFinite(b.creativity) ? Number(b.creativity) : DREAM_CREATIVITY.default));
  const prompt = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt.trim() : 'The same shot in sharp, rich, high-resolution detail.';
  return {
    graph: buildDreamGraph({
      source: { ...source, kind: 'video' }, prompt, creativity, width: out.w, height: out.h, frames, seed,
      negative: typeof b.negative === 'string' && b.negative ? b.negative : undefined,
    }),
    kind, parent,
    settings: { ...common, creativity, prompt, frames, seconds: Math.round((frames / 24) * 10) / 10 },
  };
}

// ---------- Object (image to 3D) ----------

const ASSET_TOKEN_RE = /^asset:[0-9a-f-]{36}$/i;

/**
 * Image to 3D on TRELLIS.2: a still (an upload token or a still take) becomes
 * a textured GLB, plus a turntable mp4 and the isolated subject as sidecars.
 * Only tokens and take ids are accepted, never a path.
 */
async function objectGraph(b: any, seed: number): Promise<Built> {
  if (!eng.isLocal()) throw new Error('Make 3D collects its GLB from a local ComfyUI; it does not run on a cloud engine yet.');
  const quality: ObjectQuality = b.quality === 'quality' ? 'quality' : 'draft';
  const removeBackground = b.removeBackground !== false;
  let image: string;
  let parent: number | undefined;
  let named: { shotName?: string } = {};
  if (b.sourceTake) {
    const src = takes.get(Number(b.sourceTake));
    if (!src?.output_path || src.status !== 'done') throw new Error(`take ${b.sourceTake} not found or unfinished`);
    if (src.kind !== 'still') throw new Error(`Make 3D starts from a still; take ${src.id} is a ${src.kind === 'object' ? '3D model' : 'video'}.`);
    if (!existsSync(src.output_path)) throw new Error(`take ${src.id}'s file is no longer on disk: ${src.output_path}`);
    image = await stageTakeFile(src, 'object');
    parent = src.id;
    const ss = settingsOf(src);
    named = { shotName: b.shotName || ss.shotName || src.shot_name };
  } else if (typeof b.image === 'string' && ASSET_TOKEN_RE.test(b.image)) {
    const inp = await eng.readInput(b.image);
    if (!inp) throw new Error('That image is no longer on this machine. Add it again.');
    if (!imageDims(inp.data)) throw new Error('Make 3D needs a PNG, JPEG or WebP still');
    image = b.image;
  } else {
    throw new Error('Make 3D needs a still: an uploaded image or a take');
  }
  const q = OBJECT_QUALITY[quality];
  return {
    kind: 'object', parent,
    graph: buildTrellisGraph({ image, seed, quality, removeBackground }),
    settings: {
      app: 'object', quality, removeBackground, image, sourceTake: parent, ...named,
      faces: q.faces, texture: q.texture, resolution: q.resolution,
      width: TURNTABLE.size, height: TURNTABLE.size,
    },
  };
}

// ---------- Director scenes ----------

initScenes({ queueTakes, broadcast, recordWorkflow, probeMedia });

/** Start planning a scene into shots. Poll GET /api/director/plan/:id. */
app.post('/api/director/plan', async (req, reply) => {
  const b = (req.body ?? {}) as { scene?: string; shots?: number; planner?: string; seed?: number; think?: boolean };
  const scene = String(b.scene ?? '').trim();
  if (!scene) return reply.code(400).send({ error: 'Write the scene first' });
  return startPlan(scene, { shots: Number(b.shots) || undefined, planner: b.planner, seed: Number.isFinite(b.seed) ? Number(b.seed) : undefined, think: b.think === true });
});

app.get('/api/director/plan/:id', async (req, reply) => {
  const p = getPlan(String((req.params as any).id));
  return p ?? reply.code(404).send({ error: 'no such plan (the server restarted?)' });
});

/** Shoot a scene: queue the shots that are not shot yet, then cut. Returns the cut take. */
app.post('/api/director/scene', async (req, reply) => {
  const b = (req.body ?? {}) as any;
  let r;
  const tier = parseTier(b.resolution) ?? (await currentTier());
  try { r = cleanScene(b, tier); } catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : 'bad scene' }); }
  const status = eng.isLocal() ? await comfy.getStatus() : { up: true };
  if (!status.up || !(await eng.ensureProxy())) return reply.code(503).send({ error: 'The engine is not answering. Start ComfyUI first.' });
  if (eng.isLocal()) {
    const need = [...new Set([...bundlesFor({ kind: 'video', videoModel: 'ltx25' }), ...(r.heroFrames ? bundlesFor({ kind: 'still', model: r.imageModel }) : []),
      ...(r.shots.some((s) => s.cast?.length) ? bundlesFor({ kind: 'still', castEngine: 'compose' }) : []), 'ltx-tools'])];
    const missing = await blockingReason(need);
    if (missing) return reply.code(412).send({ error: missing });
    for (const s of r.shots) {
      const why = await postBlockingReason({ era: r.era, eraGrade: r.eraGrade, ramp: s.ramp ?? r.ramp });
      if (why) return reply.code(412).send({ error: why });
    }
  }
  try {
    const cutId = await shootScene(r);
    if (r.projectId) projects.touch(r.projectId);
    return { cutId, take: takes.get(cutId) };
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not shoot the scene' });
  }
});

// ---------- Seam Doctor ----------

type SeamFix = 'trim' | 'regen' | 'bridge' | 'reseed';
/**
 * Order the doctor tries fixes in when asked to fix a seam automatically. A
 * trim is free and keeps every original frame, so it goes first whenever one
 * closes; then the bridge; a re-render with a new seed is the last resort.
 * Measured on loops rendered at 832x448 (see CHANGELOG, Seam Doctor).
 */
const SEAM_ORDER: SeamFix[] = ['trim', 'regen', 'reseed'];
/** Re-noise level for a re-render across the wrap (measured, see CHANGELOG). */
const SEAM_REGEN_SIGMA = 0.65;

const settingsOf = (t: { settings: string }) => JSON.parse(t.settings) as Record<string, any>;

/** A take that is meant to loop: the Seamless loop tab, a looping effect, or a seam fix. */
function isLoopTake(s: Record<string, any>): boolean {
  return s.app === 'seam' || (!!s.startImage && s.startImage === s.endImage) || (s.app === 'effects' && !!s.loop);
}

/** A finished video take's file, checked. */
function finishedVideo(id: number) {
  const t = takes.get(id);
  if (!t?.output_path || t.status !== 'done') throw new Error(`take ${id} not found or unfinished`);
  if (t.kind === 'still' || /\.png$/i.test(t.output_path)) throw new Error(`take ${id} is a still, not a video`);
  if (!existsSync(t.output_path)) throw new Error(`take ${t.id}'s file is no longer on disk: ${t.output_path}`);
  return t;
}

/** Hand a finished take's file to the engine as an input. */
async function stageTakeFile(t: { id: number; output_path: string | null }, prefix: string): Promise<string> {
  const ext = extname(t.output_path!).toLowerCase() || '.mp4';
  const data = await import('fs/promises').then((fs) => fs.readFile(t.output_path!));
  return eng.uploadInput(`openfield_${prefix}_${t.id}${ext}`, data, ext === '.png' ? 'image/png' : 'video/mp4');
}

/** The loop a chain of seam fixes started from. */
function originOf(id: number): number {
  let t = takes.get(id);
  for (let i = 0; t && i < 20; i++) {
    const s = settingsOf(t);
    if (s.app !== 'seam' || !s.sourceTake) return t.id;
    t = takes.get(Number(s.sourceTake));
  }
  return t?.id ?? id;
}

/** Measure a take as a loop, store the result on it, and tell the browsers. */
async function measureTake(id: number): Promise<SeamMeasure> {
  const t = finishedVideo(id);
  const s = settingsOf(t);
  const splices = s.app !== 'seam' || !s.plan ? [] : s.mode === 'bridge' ? [s.plan.splice] : s.mode === 'regen' ? s.plan.splices : [];
  const m = await measureLoop(t.output_path!, splices);
  takes.patchSettings(id, { seam: m });
  broadcast({ type: 'take', take: takes.get(id) });
  return m;
}

async function seamGraph(b: any, seed: number): Promise<Built> {
  const src = finishedVideo(Number(b.sourceTake));
  const ss = settingsOf(src);
  const mode: 'trim' | 'regen' | 'bridge' = b.mode === 'trim' || b.mode === 'regen' ? b.mode : 'bridge';
  const clip = await loadClip(src.output_path!);
  const n = clip.tex.length;
  const before = scoreWindow(clip);
  const named = { shotName: b.shotName || ss.shotName || src.shot_name, fileSeed: ss.fileSeed ?? ss.seed };
  const common = {
    app: 'seam', mode, sourceTake: src.id, ...named,
    prompt: ss.prompt, userPrompt: ss.userPrompt, width: clip.w, height: clip.h, fps: clip.fps,
    before: { ratio: before.ratio, verdict: before.verdict },
  };
  if (mode === 'trim') {
    const plan = planTrim(clip);
    if (!plan) throw new Error('No trim of this clip closes the loop. Bridge the wrap instead.');
    const video = await stageTakeFile(src, 'seam');
    return {
      graph: buildSeamTrimGraph({ video, start: plan.start, frames: plan.frames, fps: clip.fps }),
      kind: 'video', parent: src.id,
      settings: { ...common, plan: { start: plan.start, frames: plan.frames, predicted: plan.predicted.ratio }, seconds: Math.round((plan.frames / clip.fps) * 10) / 10 },
    };
  }
  const prompt = typeof ss.prompt === 'string' && ss.prompt.trim() ? ss.prompt : 'The same shot, continuous natural motion.';
  const negative = typeof ss.negative === 'string' && ss.negative ? ss.negative : undefined;
  if (Math.max(clip.w, clip.h) > 1920) throw new Error('The bridge renders at the clip\'s own size, up to 1920 px on the long edge. Improve the seam before upscaling.');
  if (clip.w % 32 || clip.h % 32) throw new Error(`The bridge needs a frame size in multiples of 32; this clip is ${clip.w}x${clip.h}.`);
  if (mode === 'regen') {
    const plan = planRegen(n);
    const sigma = Number.isFinite(b.sigma) ? Math.max(0.2, Math.min(0.85, Number(b.sigma))) : SEAM_REGEN_SIGMA;
    const video = await stageTakeFile(src, 'seam');
    return {
      graph: buildSeamRegenGraph({ video, n, ...plan, width: clip.w, height: clip.h, fps: clip.fps, seed, prompt, negative, sigma }),
      kind: 'video', parent: src.id,
      settings: { ...common, plan, sigma, seconds: Math.round((n / clip.fps) * 10) / 10 },
    };
  }
  const plan = planBridge(n, clip.fps, Number(b.bridgeSeconds) || 1);
  const video = await stageTakeFile(src, 'seam');
  return {
    graph: buildSeamBridgeGraph({
      video, n, anchorA: plan.anchorA, anchorB: plan.anchorB, bridgeFrames: plan.bridgeFrames,
      width: clip.w, height: clip.h, fps: clip.fps, seed, prompt, negative,
      guideStrength: Number.isFinite(b.guideStrength) ? Math.max(0.1, Math.min(1, Number(b.guideStrength))) : undefined,
    }),
    kind: 'video', parent: src.id,
    settings: { ...common, plan, seconds: Math.round((n / clip.fps) * 10) / 10 },
  };
}

/**
 * Queue one fix of `fix` kind for the loop `rootId`. `next` is what the doctor
 * tries if this one still measures as a visible seam.
 */
async function queueSeamFix(rootId: number, fix: SeamFix, next: SeamFix[]): Promise<number[]> {
  const root = finishedVideo(rootId);
  const doctor = { root: rootId, next };
  if (fix === 'reseed') {
    // The original loop again with a new seed; measured like any loop when it lands.
    const origin = finishedVideo(originOf(rootId));
    const s = settingsOf(origin);
    if (!isLoopTake(s) || s.app === 'seam') throw new Error('Only a rendered loop can be re-rendered with a new seed.');
    const body = { ...s, seed: undefined, seam: undefined, hdr: undefined, seamFix: undefined, doctor: { ...doctor, root: origin.id } };
    return queueTakes(body, 1);
  }
  return queueTakes({ kind: 'seam', mode: fix, sourceTake: root.id, doctor, projectId: root.project_id ?? undefined }, 1);
}

/**
 * Fix a take's seam. `auto` measures first, then tries SEAM_ORDER: a trim
 * only when one is predicted to close, and each later step only if the one
 * before still measures as visible (afterRender follows the chain).
 */
async function startSeamFix(id: number, strategy: 'auto' | SeamFix) {
  const t = finishedVideo(id);
  const s = settingsOf(t);
  const before = s.seam ?? (await measureTake(id));
  if (strategy !== 'auto') return { fix: strategy, before, takeIds: await queueSeamFix(id, strategy, []) };
  if (before.verdict === 'seamless') return { fix: null, before, takeIds: [] as number[] };
  const order = [...SEAM_ORDER];
  if (!planTrim(await loadClip(t.output_path!))) order.splice(order.indexOf('trim'), 1);
  if (!isLoopTake(s) || s.app === 'seam') order.splice(order.indexOf('reseed'), 1);
  const [first, ...rest] = order;
  return { fix: first, before, takeIds: await queueSeamFix(id, first, rest) };
}

app.get('/api/takes/:id/seam', async (req, reply) => {
  try {
    return await measureTake(Number((req.params as any).id));
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not measure' });
  }
});

app.post('/api/takes/:id/fix-seam', async (req, reply) => {
  const id = Number((req.params as any).id);
  const b = (req.body ?? {}) as { strategy?: string };
  const strategy = (['trim', 'regen', 'bridge', 'reseed'] as const).find((x) => x === b.strategy) ?? 'auto';
  try {
    if (strategy !== 'trim' && eng.isLocal()) {
      const missing = await blockingReason(bundlesFor({ kind: 'seam', mode: 'bridge' }));
      if (missing) return reply.code(412).send({ error: missing });
    }
    return await startSeamFix(id, strategy);
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not fix the seam', takeIds: (e as any)?.takeIds });
  }
});

// ---------- Stage ----------
// A shot blocked in 3D (src/stage.ts) renders through LTX-2.5 Layout to Render.

const ASSET = /^asset:[0-9a-f-]{36}$/i;
const STAGE_INPUTS = ['clayVideo', 'depthVideo', 'depthImage', 'clayImage', 'lookImage'] as const;

/**
 * Make a Stage shot body ready to build: a clean scene, upload tokens only
 * (never a path), and the blocking drawn here when an agent sent just the scene.
 */
async function prepareStage(b: any): Promise<any> {
  const out = { ...b };
  if (out.scene !== undefined) out.scene = cleanStageScene(out.scene);
  // A model prop by take id must be a 3D take; the server draws it as its box either way.
  for (const p of out.scene?.props ?? []) {
    if (p.type !== 'glb' || !p.take) continue;
    const t = takes.get(p.take);
    if (!t || t.kind !== 'object') throw new Error(`prop ${p.label ?? p.id}: take ${p.take} is not a 3D model take`);
  }
  for (const k of STAGE_INPUTS) {
    if (out[k] === undefined || out[k] === null || out[k] === '') { delete out[k]; continue; }
    if (typeof out[k] !== 'string' || !ASSET.test(out[k])) throw new Error(`${k} must be an upload token (POST /api/upload or /api/stage/blocking)`);
  }
  if (!out.clayVideo) {
    if (!out.scene) throw new Error('Stage needs a blocked scene, or the clay clip from /api/stage/blocking');
    // The size asked for (a tier, or the older draft/final), else the machine-wide tier, held at Stage's cap.
    const tier = stageTier(out.resolution) ?? stageTier(out.quality) ?? appTier('stage', await currentTier());
    out.resolution = tier;
    delete out.quality;
    const t0 = Date.now();
    Object.assign(out, await rasterBlocking(out.scene, tier), { blockedOn: 'server' });
    console.log(`[openfield] stage blocking drawn on the CPU in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const ls = lookSize(out.scene?.aspect ?? '16:9');
  out.lookWidth = Number(out.lookWidth) || ls.w;
  out.lookHeight = Number(out.lookHeight) || ls.h;
  if (!out.lookImage && !out.depthImage) throw new Error('Stage needs a look frame, or the depth pass to make one from');
  return out;
}

/** The look frame: Z-Image Turbo on the depth pass, or Qwen-Image-Edit on the clay frame. */
async function stageLookGraph(b: any, seed: number): Promise<Built> {
  for (const k of ['depthImage', 'clayImage'] as const) {
    if (b[k] !== undefined && (typeof b[k] !== 'string' || !ASSET.test(b[k]))) throw new Error(`${k} must be an upload token`);
  }
  const snap16 = (v: unknown, d: number) => Math.max(256, Math.min(2048, Math.round((Number(v) || d) / 16) * 16));
  const ls = lookSize('16:9');
  const width = snap16(b.width, ls.w);
  const height = snap16(b.height, ls.h);
  const text = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt.trim() : 'A finished film still of this set.';
  if (b.engine === 'edit') {
    if (!b.clayImage) throw new Error('A look frame from the clay needs the clay frame');
    const images = [b.clayImage as string];
    let instruction = lookEditInstruction(text);
    // Cast members with pictures fill the free image slots, named in the instruction.
    const ids: number[] = Array.isArray(b.cast) ? b.cast.map(Number) : [];
    if (ids.length && typeof b.castSource === 'string') {
      const all = castDb.list();
      const members = ids.map((id) => all.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
      for (const m of members) m.refs = await liveRefs(m);
      const c = composeInstruction(b.castSource, allocate(members.filter((m) => m.refs.length), 2), { offset: 1, all });
      images.push(...c.images);
      instruction = lookEditInstruction(c.instruction);
    }
    const have = new Set(await comfy.comboOptions('LoraLoaderModelOnly', 'lora_name'));
    return {
      kind: 'still',
      graph: buildEditGraph({ images, instruction, width, height, seed, quality: 'draft', lightning: editLightning(have) }),
      settings: { width, height, compiledLook: instruction },
    };
  }
  if (!b.depthImage) throw new Error('A look frame needs the depth pass of the first frame');
  const figures = Array.isArray(b.scene?.props) ? b.scene.props.filter((x: any) => x?.type === 'figure').length : 0;
  const compiled = lookPrompt(text, figures);
  return {
    kind: 'still',
    graph: buildStageLookGraph({ depth: b.depthImage, prompt: compiled, width, height, seed }),
    settings: { width, height, compiledLook: compiled },
  };
}

/** The shot: the clay clip and the look frame through Layout to Render. */
async function stageShotGraph(b: any, seed: number): Promise<Built> {
  if (!b.clayVideo || !b.lookImage) throw new Error('A Stage shot needs its clay clip and a look frame');
  const clip = await probeInput(b.clayVideo);
  checkSize(clip.w, clip.h);
  const prompt = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt.trim() : 'A finished film shot.';
  return {
    kind: 'video',
    graph: buildStageShotGraph({ clay: b.clayVideo, height: clip.h, look: b.lookImage, prompt, seed, filenamePrefix: 'openfield/stage' }),
    settings: { width: clip.w, height: clip.h, seconds: Math.round(clip.seconds * 10) / 10, lengthFrames: b.frames },
  };
}

/** The page's WebGL blocking (clay + depth frames) becomes engine inputs. */
app.post('/api/stage/blocking', async (req, reply) => {
  try {
    const t0 = Date.now();
    const r = await ingestBlocking(req.body);
    return { ...r, took: Math.round((Date.now() - t0) / 100) / 10 };
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not read the blocking' });
  }
});

// ---------- Finish in HDR ----------

/** LTX's SDR-to-HDR pass holds the whole clip at once: keep it to what fits beside the model on a 32 GB card. */
const HDR_MAX_PIXELS = 1280 * 736;
const HDR_MAX_FRAMES = 241;

async function hdrGraph(b: any, seed: number): Promise<Built> {
  if (!eng.isLocal()) throw new Error('Finish in HDR collects its EXR frames from a local ComfyUI; it does not run on a cloud engine yet.');
  const src = finishedVideo(Number(b.sourceTake));
  const ss = settingsOf(src);
  const info = await videoInfo(src.output_path!);
  if (info.w * info.h > HDR_MAX_PIXELS) throw new Error(`Finish in HDR runs up to about 1280x720; this take is ${info.w}x${info.h}. Finish before upscaling.`);
  if (info.frames > HDR_MAX_FRAMES) throw new Error(`Finish in HDR runs up to ${HDR_MAX_FRAMES} frames (10 s); this take has ${info.frames}.`);
  const video = await stageTakeFile(src, 'hdr');
  const tag = `${src.id}_${Date.now().toString(36)}`;
  return {
    graph: buildHdrGraph({ video, frames: info.frames, loop: isLoopTake(ss), withAudio: info.audio, seed, tag }),
    kind: 'video', parent: src.id,
    settings: {
      app: 'hdr', sourceTake: src.id, hdrTag: tag, frames: info.frames, fps: info.fps, width: info.w, height: info.h,
      seconds: Math.round((info.frames / info.fps) * 10) / 10,
      shotName: b.shotName || ss.shotName || src.shot_name, fileSeed: ss.fileSeed ?? ss.seed,
      prompt: ss.prompt, userPrompt: ss.userPrompt,
    },
  };
}

/** Pull the HDR finish's EXRs and HLG master out of ComfyUI and write the downloads. */
async function finishHdr(id: number) {
  const t = finishedVideo(id);
  const s = settingsOf(t);
  try {
    const r = await collectHdr(s.hdrTag, s.frames, t.output_path!.replace(/\.[^.\/]+$/, ''));
    takes.patchSettings(id, { hdr: r });
  } catch (e) {
    takes.patchSettings(id, { hdr: { error: e instanceof Error ? e.message : String(e) } });
  }
  broadcast({ type: 'take', take: takes.get(id) });
}

/** Collect an HDR finish's files again (after a failed or partial collection). */
app.post('/api/takes/:id/collect-hdr', async (req, reply) => {
  const t = takes.get(Number((req.params as any).id));
  if (!t || settingsOf(t).app !== 'hdr') return reply.code(404).send({ error: 'not an HDR finish' });
  await finishHdr(t.id);
  return settingsOf(takes.get(t.id)!).hdr;
});

/** HDR downloads: exr (zip), hlg (HEVC .mov), prores (.mov). */
app.get('/api/takes/:id/file/:which', async (req, reply) => {
  const t = takes.get(Number((req.params as any).id));
  const hdr = t ? settingsOf(t).hdr : undefined;
  const which = String((req.params as any).which);
  const named: string | undefined = which === 'exr' ? hdr?.exrZip : which === 'hlg' ? hdr?.hlgMov : which === 'prores' ? hdr?.proresMov : undefined;
  if (named && !existsSync(named)) return reply.code(410).send({ error: `file no longer on disk: ${named}` });
  const path = besideOutput(t?.output_path, named);
  if (!path) return reply.code(404).send({ error: 'no such file for this take' });
  if (!existsSync(path)) return reply.code(410).send({ error: `file no longer on disk: ${path}` });
  reply.headers({
    'Content-Type': which === 'exr' ? 'application/zip' : 'video/quicktime',
    'Content-Length': statSync(path).size,
    'Content-Disposition': `attachment; filename="${path.split(/[/\\]/).pop()}"`,
  });
  return reply.send(createReadStream(path));
});

/** Everything that runs once a take's file is on disk. */
async function afterRender(id: number) {
  const t = takes.get(id);
  if (!t || t.status !== 'done') return;
  const s = settingsOf(t);
  if (s.app === 'hdr') await finishHdr(id);
  if (t.kind !== 'video' || !isLoopTake(s)) return;
  const m = await measureTake(id);
  if (m.verdict === 'seamless') return;
  if (s.doctor) {
    const [next, ...rest] = (s.doctor.next ?? []) as SeamFix[];
    if (next) await queueSeamFix(Number(s.doctor.root), next, rest);
  } else if (s.seamFix === 'auto') {
    await startSeamFix(id, 'auto');
  }
}

/**
 * Legacy one-click 2x (Sharpen) of a finished take. The Upscale app and the
 * MCP server use /api/generate with kind 'upscale'; this stays for old clients.
 */
app.post('/api/takes/:id/upres', async (req, reply) => {
  const b = (req.body ?? {}) as any;
  const id = Number((req.params as any).id);
  const missing = eng.isLocal() ? await blockingReason(bundlesFor({ kind: 'upscale', mode: 'sharpen', model: b.model === 'ultrasharp' ? 'ultrasharp' : 'esrgan' })) : null;
  if (missing) return reply.code(412).send({ error: missing });
  try {
    const r = await queueTakes({ kind: 'upscale', mode: 'sharpen', sourceTake: id, model: b.model === 'ultrasharp' ? 'ultrasharp' : 'esrgan', rife: !!b.rife }, 1);
    return { takeId: r[0] };
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'submit failed' });
  }
});

app.post('/api/stop', async () => {
  for (const t of takes.active()) if (t.status === 'rendering' && t.prompt_id) await eng.cancel(t.prompt_id).catch(() => {});
  return { ok: true };
});

/** Cancel one take — interrupt if it's the live render, dequeue if waiting. */
app.post('/api/takes/:id/cancel', async (req, reply) => {
  const t = takes.get(Number((req.params as any).id));
  if (!t) return reply.code(404).send({ error: 'not found' });
  if (t.status !== 'rendering' && t.status !== 'queued') {
    return reply.code(400).send({ error: `take is ${t.status}` });
  }
  if (t.prompt_id) await eng.cancel(t.prompt_id).catch(() => {});
  takes.fail(t.id, 'cancelled', true);
  broadcast({ type: 'take', take: takes.get(t.id) });
  // A scene cut still waiting on its shots takes them down with it.
  if (!t.prompt_id && JSON.parse(t.settings).cut) {
    for (const s of shotsOf(t.id)) {
      if (s.status !== 'queued' && s.status !== 'rendering') continue;
      if (s.prompt_id) await eng.cancel(s.prompt_id).catch(() => {});
      takes.fail(s.id, 'cancelled with its scene', true);
      broadcast({ type: 'take', take: takes.get(s.id) });
    }
  }
  return { ok: true };
});

/** Nuke everything — pending queue and the live render. */
app.post('/api/queue/clear', async () => {
  const active = takes.active();
  await Promise.allSettled(active.filter((t) => t.prompt_id).map((t) => eng.cancel(t.prompt_id!)));
  await eng.cancelAll();
  for (const t of active) {
    takes.fail(t.id, 'queue cleared', true);
    broadcast({ type: 'take', take: takes.get(t.id) });
  }
  return { ok: true };
});

/** Start ComfyUI via the configured COMFY_LAUNCH command. */
app.post('/api/engine/start', async (_req, reply) => {
  if (!comfy.canLaunchEngine()) {
    return reply.code(501).send({
      error: 'No COMFY_LAUNCH command is configured — start ComfyUI yourself, or set one in .env (see .env.example).',
    });
  }
  const ok = await comfy.launchEngine();
  if (ok) clearPreflightCache(); // fresh engine may expose different weights
  return { ok };
});

/** What each feature needs on disk, and what is actually there. */
app.get('/api/preflight', async (req) => {
  const force = !!(req.query as any)?.refresh;
  return { bundles: await preflight(force) };
});

// ---------- style preambles ----------

app.get('/api/preambles', async () => preambles.list());

app.post('/api/preambles', async (req, reply) => {
  const { name, text } = (req.body ?? {}) as { name?: string; text?: string };
  if (!name?.trim() || !text?.trim()) return reply.code(400).send({ error: 'name and text required' });
  try {
    return { id: preambles.create(name.trim(), text.trim()) };
  } catch {
    return reply.code(409).send({ error: 'a preamble with that name already exists' });
  }
});

app.put('/api/preambles/:id', async (req, reply) => {
  const id = Number((req.params as any).id);
  if (!preambles.get(id)) return reply.code(404).send({ error: 'not found' });
  const { name, text } = (req.body ?? {}) as { name?: string; text?: string };
  try {
    preambles.update(id, { name: name?.trim(), text: text?.trim() });
  } catch {
    return reply.code(409).send({ error: 'a preamble with that name already exists' });
  }
  return preambles.get(id);
});

app.delete('/api/preambles/:id', async (req) => {
  preambles.delete(Number((req.params as any).id));
  return { ok: true };
});

// ---------- cast ----------
// Characters, props and places, @mentioned in any prompt (server/cast.ts).

type RefSource = { token?: string; takeId?: number };
/** Only an upload token or a take id; anything else (a file path) is refused. */
function refSources(v: unknown): RefSource[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: RefSource[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') return null;
    const keys = Object.keys(x);
    if (keys.some((k) => k !== 'token' && k !== 'takeId')) return null;
    const { token, takeId } = x as RefSource;
    if (typeof token === 'string' && /^asset:[0-9a-f-]{36}$/i.test(token)) out.push({ token });
    else if (Number.isInteger(takeId) && takeId! > 0) out.push({ takeId });
    else return null;
  }
  return out;
}
const BAD_REFS = 'Cast pictures come from an upload token (POST /api/upload) or a take id';
const castName = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^@+/, '').replace(/\s+/g, ' ') : '');
/** Names become @mentions: letters, digits, spaces, - _ ' and dots, up to 40 characters. */
const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{N} _'.-]{0,39}$/u;

function castOut(m: ReturnType<typeof castDb.get> & {}) {
  return { ...m, refs: m.refs.map((r, i) => ({ ...r, url: `/api/cast/${m.id}/ref/${i}?v=${encodeURIComponent(r.token)}` })) };
}

app.get('/api/cast', async () => castDb.list().map(castOut));

app.post('/api/cast', async (req, reply) => {
  const b = (req.body ?? {}) as { name?: string; kind?: string; notes?: string; refs?: RefSource[] };
  const name = castName(b.name);
  if (!NAME_OK.test(name)) return reply.code(400).send({ error: 'Give it a name: letters, numbers and spaces, up to 40 characters' });
  if (castDb.byName(name)) return reply.code(409).send({ error: `There is already a cast member called ${name}` });
  const kind = (CAST_KINDS as string[]).includes(String(b.kind)) ? (b.kind as CastKind) : 'character';
  const parsed = refSources(b.refs);
  if (!parsed) return reply.code(400).send({ error: BAD_REFS });
  const srcs = parsed.slice(0, MAX_REFS);
  if (!srcs.length) return reply.code(400).send({ error: 'Add at least one picture' });
  try {
    const refs = [];
    for (const r of srcs) refs.push(await refFrom(name, r));
    const id = castDb.create({ name, kind, refs, notes: String(b.notes ?? '').trim().slice(0, 1200) });
    return castOut(castDb.get(id)!);
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not save the pictures' });
  }
});

app.put('/api/cast/:id', async (req, reply) => {
  const m = castDb.get(Number((req.params as any).id));
  if (!m) return reply.code(404).send({ error: 'not found' });
  const b = (req.body ?? {}) as { name?: string; kind?: string; notes?: string; addRefs?: RefSource[]; removeRefs?: number[]; order?: number[] };
  const patch: Parameters<typeof castDb.update>[1] = {};
  if (b.name !== undefined) {
    const name = castName(b.name);
    if (!NAME_OK.test(name)) return reply.code(400).send({ error: 'Names are letters, numbers and spaces, up to 40 characters' });
    const clash = castDb.byName(name);
    if (clash && clash.id !== m.id) return reply.code(409).send({ error: `There is already a cast member called ${name}` });
    if (name !== m.name) { patch.name = name; patch.refs = await renameFiles(m, name); }
  }
  if (b.kind !== undefined && (CAST_KINDS as string[]).includes(b.kind)) patch.kind = b.kind as CastKind;
  if (b.notes !== undefined) patch.notes = String(b.notes).trim().slice(0, 1200);
  const adds = refSources(b.addRefs);
  if (!adds) return reply.code(400).send({ error: BAD_REFS });
  let refs = patch.refs ?? m.refs;
  if (Array.isArray(b.removeRefs)) refs = refs.filter((_, i) => !b.removeRefs!.includes(i));
  if (Array.isArray(b.order) && b.order.length === refs.length) refs = b.order.map((i) => refs[i]).filter(Boolean);
  try {
    for (const r of adds.slice(0, Math.max(0, MAX_REFS - refs.length))) {
      refs = [...refs, await refFrom(patch.name ?? m.name, r)];
    }
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not save the picture' });
  }
  if (!refs.length) return reply.code(400).send({ error: 'A cast member keeps at least one picture' });
  patch.refs = refs;
  castDb.update(m.id, patch);
  return castOut(castDb.get(m.id)!);
});

app.delete('/api/cast/:id', async (req) => {
  // The pictures stay on disk under <output>/Cast: deleting a member never deletes files.
  castDb.delete(Number((req.params as any).id));
  return { ok: true };
});

/** A cast picture, from our own copy on disk. */
app.get('/api/cast/:id/ref/:n', async (req, reply) => {
  const m = castDb.get(Number((req.params as any).id));
  const r = m?.refs[Number((req.params as any).n)];
  if (!r || !isCastFile(r.file)) return reply.code(404).send({ error: 'not found' });
  const ext = extname(r.file).toLowerCase();
  reply.header('Content-Type', ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png').header('Cache-Control', 'max-age=86400');
  return reply.send(createReadStream(r.file));
});

/**
 * Compose a hero frame of cast members in a shot (Qwen-Image-Edit), as a still
 * take. Returns at once with the take id; the frame lands like any still.
 */
app.post('/api/cast/hero', async (req, reply) => {
  const b = (req.body ?? {}) as { castIds?: number[]; shot?: string; width?: number; height?: number; projectId?: number; seed?: number };
  const missing = eng.isLocal() ? await blockingReason(['edit']) : null;
  if (missing) return reply.code(412).send({ error: missing });
  const ids = (Array.isArray(b.castIds) ? b.castIds : []).map(Number).filter(Boolean);
  const shot = String(b.shot ?? '');
  if (!ids.length && !mentioned(shot).length) return reply.code(400).send({ error: 'Name at least one cast member' });
  const size = heroSize(Number(b.width) || 1328, Number(b.height) || 752);
  // castHeroFrame waits for the render; answer as soon as the take is queued.
  try {
    const takeId = await new Promise<number>((res, rej) => {
      castHeroFrame(ids, shot, { ...size, projectId: b.projectId ?? null, seed: b.seed, onQueued: res })
        .catch((e) => { rej(e); console.error('[openfield] hero frame failed:', e instanceof Error ? e.message : e); });
    });
    return { takeId };
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : 'the hero frame did not queue' });
  }
});

/** Your own LoRAs: every LoRA file the engine sees that no app loads by itself, with its model family. */
app.get('/api/loras', async () => ({ loras: await listUserLoras().catch(() => []) }));

/** Available checkpoints by model family + the current model card. */
app.get('/api/models', async () => {
  const checkpoints = await comfy.listCheckpoints().catch(() => ({}));
  return {
    checkpoints,
    card: {
      video: {
        name: 'MiniMax H3 (Hailuo 3)',
        checkpoints: 'FL2VA / Ref2VA · pruned fp8 · 20GB each',
        encoder: 'Qwen3VL-32B NVFP4 (15GB)',
        native: '24fps · 768px-class · 5-15s (17k+5 frame grid) · audio always on',
        strengths: 'dialogue/voice, held stillness, direction-following, refs',
        license: 'Community license EXCLUDES US, EU, UK and South Korea; experiments only until licensed',
      },
      ltx25: {
        name: 'LTX-2.5 (22B distilled)',
        checkpoints: 'int8-convrot 21GB · Gemma-4-12B-with-proj encoder 15GB',
        native: '24fps · t2v/i2v/flf2v · two-stage (half-res base → 2x refine) · 8+4 steps · audio optional',
        strengths: 'multishot consistency across cuts, FLF2V loop closure, cleaner motion (neural decoder VAE)',
        license: 'LTX-2.x community license — free commercial use under $10M ARR',
      },
      ltx: {
        name: 'LTX-Video 2.3 (22B)',
        checkpoints: 'SpiceModels fine-tunes via dropdown · Gemma-3-12B encoder',
        native: '25fps · two-stage (half-res base → 2x refine) · distilled 8+4 steps · audio',
        strengths: 'fast animation-tuned generation; community checkpoint/LoRA playground',
        license: 'LTX-2 community license — check per-checkpoint terms for fine-tunes',
      },
      stills: {
        qwen: 'Qwen-Image fp8 · Apache 2.0 · text/layout specialist',
        flux2: 'FLUX.2 dev fp8mixed 34GB · non-commercial dev license · photoreal lead',
      },
    },
  };
});

app.delete('/api/queue/:promptId', async (req) => {
  const promptId = (req.params as any).promptId as string;
  await eng.cancel(promptId).catch(() => {});
  const t = takes.byPrompt(promptId);
  if (t) {
    takes.fail(t.id, 'removed from queue', true);
    broadcast({ type: 'take', take: takes.get(t.id) });
  }
  return { ok: true };
});

app.get('/api/takes', async (req) => {
  const pid = (req.query as any).project ? Number((req.query as any).project) : null;
  return takes.list(pid, 500);
});

/**
 * The ComfyUI origins allowed to fetch a take's workflow cross-origin. ComfyUI
 * fetches the URL itself when a workflow link is dropped on its canvas.
 * 127.0.0.1 and localhost are the same machine but different origins.
 */
function comfyOrigins(): Set<string> {
  const u = new URL(config.comfyUrl);
  const out = new Set([u.origin]);
  for (const [a, b] of [['127.0.0.1', 'localhost'], ['localhost', '127.0.0.1']]) {
    if (u.hostname === a) out.add(u.origin.replace(a, b));
  }
  return out;
}

/**
 * The API-format ComfyUI workflow that produced a take, as a plain JSON file
 * that loads in ComfyUI by dropping it on the canvas. ?download=1 saves it.
 * Takes from before workflows were recorded are backfilled from the engine
 * while it still remembers the job.
 */
async function takeWorkflow(req: FastifyRequest, reply: FastifyReply) {
  const t = takes.get(Number((req.params as any).id));
  if (!t) return reply.code(404).send({ error: 'take not found' });
  let wf = takeWorkflows.get(t.id)?.graph;
  if (!wf && t.prompt_id) {
    const ran = await eng.executedWorkflow(t.prompt_id);
    if (ran) {
      takeWorkflows.set(t.id, ran, 'engine');
      wf = ran;
    }
  }
  if (!wf) return reply.code(404).send({ error: 'no workflow was recorded for this take, and the engine no longer has it' });
  const origin = req.headers.origin;
  if (origin && comfyOrigins().has(origin)) reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
  const fname = `openfield_take_${t.id}_${safeShotName(t.shot_name)}.json`;
  if ((req.query as any).download) reply.header('Content-Disposition', `attachment; filename="${fname}"`);
  // Exactly application/json: ComfyUI only treats a dropped link as a workflow
  // when its MIME is that or its name ends in .json. A Buffer body keeps
  // Fastify from appending "; charset=utf-8".
  reply.header('Content-Type', 'application/json');
  return reply.send(Buffer.from(JSON.stringify(wf, null, 2)));
}
app.get('/api/takes/:id/workflow', takeWorkflow);
// Same file under a filename, which is what ComfyUI shows when a link is dropped on it.
app.get('/api/takes/:id/workflow/:file', takeWorkflow);

app.post('/api/takes/:id/star', async (req) => {
  const id = Number((req.params as any).id);
  takes.star(id, !!(req.body as any)?.on);
  return takes.get(id);
});

app.delete('/api/takes/:id', async (req) => {
  takes.delete(Number((req.params as any).id));
  return { ok: true };
});

app.get('/api/projects', async () => projects.list());
app.post('/api/projects', async (req, reply) => {
  const { name, folder } = req.body as any;
  if (!name || !folder) return reply.code(400).send({ error: 'name and folder required' });
  // takes are written under a project's folder, so it must live inside the output folder
  const root = resolve(config.outputDir);
  const dir = resolve(root, String(folder));
  if (dir !== root && !dir.startsWith(root + sep)) return reply.code(400).send({ error: 'A project folder must be inside the output folder' });
  return { id: projects.create(name, dir) };
});

/** Serve an uploaded input back to the browser (EDIT restores wells). */
app.get('/api/input-image/:name', async (req, reply) => {
  const name = String((req.params as any).name);
  const img = await eng.readInput(name);
  if (!img) return reply.code(404).send({ error: 'not found' });
  const ext = extname(img.name).toLowerCase();
  const AV: Record<string, string> = { '.glb': 'model/gltf-binary', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg' };
  reply.header('Content-Type', AV[ext] ?? (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'));
  return reply.send(img.data);
});

/**
 * Poster frame for a take (grid thumbnails). Videos get a JPEG pulled from
 * 0.5s in, made on first request and cached next to the file; stills serve
 * the image itself.
 */
app.get('/api/poster/:id', async (req, reply) => {
  const t = takes.get(Number((req.params as any).id));
  if (!t?.output_path || !existsSync(t.output_path)) return reply.code(404).send({ error: 'not found' });
  if (t.output_path.endsWith('.png')) {
    reply.header('Content-Type', 'image/png').header('Cache-Control', 'max-age=86400');
    return reply.send(createReadStream(t.output_path));
  }
  // An object's poster is the first turntable frame (a three-quarter view), or
  // the isolated subject when there is no turntable.
  const model = isModelFile(t.output_path);
  if (model && !existsSync(`${t.output_path}.turntable.mp4`)) {
    const subject = `${t.output_path}.subject.png`;
    if (!existsSync(subject)) return reply.code(404).send({ error: 'no poster for this object' });
    reply.header('Content-Type', 'image/png').header('Cache-Control', 'max-age=3600');
    return reply.send(createReadStream(subject));
  }
  const from = model ? `${t.output_path}.turntable.mp4` : t.output_path;
  const poster = `${t.output_path}.poster.jpg`;
  if (!existsSync(poster)) {
    const { execFile } = await import('child_process');
    await new Promise<void>((res) =>
      execFile(config.ffmpegBin, ['-v', 'error', '-y', '-ss', model ? '0' : '0.5', '-i', from, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', poster], () => res()),
    );
    if (!existsSync(poster)) return reply.code(500).send({ error: 'poster extraction failed' });
  }
  reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'max-age=86400');
  return reply.send(createReadStream(poster));
});

/** Typical render time for a shot like this one, from past takes on this machine. */
app.get('/api/estimate', async (req) => estimate(req.query as Record<string, string | undefined>, takes.list(null, 400)));

/** Unload models and free VRAM on the local engine. */
app.post('/api/free', async (_req, reply) => {
  if (!eng.isLocal()) return reply.code(400).send({ error: 'only for the local engine' });
  await fetch(`${config.comfyUrl}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  }).catch(() => null);
  modelsUnloaded();
  return { ok: true };
});

const isModelFile = (p: string) => /\.(glb|gltf|obj)$/i.test(p);
const mediaMime = (p: string) => {
  const ext = extname(p).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'model/obj', '.mov': 'video/quicktime' } as Record<string, string>)[ext] ?? 'video/mp4';
};

/**
 * An object take's sidecars: the turntable mp4 and the isolated subject the
 * model was built from.
 */
for (const side of ['turntable', 'subject'] as const) app.get(`/api/takes/:id/${side}`, async (req, reply) => {
  const t = takes.get(Number((req.params as any).id));
  if (!t?.output_path || !isModelFile(t.output_path)) return reply.code(404).send({ error: 'not an object take' });
  const path = `${t.output_path}.${side}.${side === 'turntable' ? 'mp4' : 'png'}`;
  if (!existsSync(path)) return reply.code(404).send({ error: `no ${side} for this take` });
  const size = statSync(path).size;
  const mime = side === 'turntable' ? 'video/mp4' : 'image/png';
  const range = req.headers.range;
  const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
  if (m) {
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    reply.code(206).headers({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.headers({ 'Content-Length': size, 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=86400' });
  return reply.send(createReadStream(path));
});

/** Stream a take's media with Range support so the <video> tag can scrub.
 *  ?download=1 forces a save-dialog with the take's real filename.
 *  An Object take's media is its GLB (model/gltf-binary): this URL is the
 *  stable address a scene (the Stage, GLTFLoader) loads the prop from. */
app.get('/api/media/:id', async (req, reply) => {
  const t = takes.get(Number((req.params as any).id));
  if (!t?.output_path) return reply.code(404).send({ error: 'not found' });
  const alpha = (req.query as any).alpha ? besideOutput(t.output_path, JSON.parse(t.settings).alphaPath as string | undefined) : undefined;
  if ((req.query as any).alpha && !alpha) return reply.code(404).send({ error: 'this take has no alpha version' });
  const path = alpha ?? t.output_path;
  // The file lives outside OpenField, in a project folder the user owns — it can
  // be moved or deleted behind our back. Say so instead of throwing a 500.
  if (!existsSync(path)) return reply.code(410).send({ error: `file no longer on disk: ${path}` });
  const size = statSync(path).size;
  const mime = mediaMime(path);
  if ((req.query as any).download || alpha) {
    const fname = path.split(/[/\\]/).pop() || 'take';
    reply.headers({
      'Content-Type': mime,
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${fname}"`,
    });
    return reply.send(createReadStream(path));
  }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    reply
      .code(206)
      .headers({
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      });
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.headers({ 'Content-Length': size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
  return reply.send(createReadStream(path));
});

/**
 * Reconciliation, every 20s: make DB truth match engine truth. Finish takes
 * whose completion we missed and re-attach to jobs still running (e.g. after
 * a restart). Polling the job is authoritative; the event stream is a bonus.
 */
async function reconcile() {
  for (const id of waitingCuts()) void advance(id);
  for (const t of takes.active()) {
    if (!t.prompt_id) continue;
    try {
      const h = await eng.result(t.prompt_id);
      if (h.done) void onPromptFinished(t.prompt_id);
      else await eng.reattach(t.prompt_id);
    } catch (e: any) {
      if (e?.name === 'NotFound' || e?.status === 404) {
        takes.fail(t.id, 'no longer known to the engine', true);
        broadcast({ type: 'take', take: takes.get(t.id) });
      }
      /* otherwise the engine is down; the status endpoint reports it */
    }
  }
}
setInterval(() => void reconcile(), 20_000);

// Cast hero frames are ordinary takes queued through the same path.
setCastQueue(queueTakes);
// A take still waiting on a hero frame when the server stopped can never run.
for (const t of takes.orphans()) takes.fail(t.id, 'interrupted: the server restarted while it waited for its hero frame', true);

// In production the sidecar also serves the built UI, so the whole app is one
// port with no Vite in the picture. In dev, Vite serves it and proxies here.
if (config.serveStatic) {
  const dist = join(ROOT, 'dist');
  if (!existsSync(dist)) {
    console.error('No dist/ — run `npm run build` before `npm start`.');
    process.exit(1);
  }
  await app.register(fastifyStatic, { root: dist });
  // SPA fallback: anything not under /api or /live is the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/live')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: config.port, host: config.host });
console.log(
  config.serveStatic
    ? `OpenField on http://${config.host}:${config.port}`
    : `OpenField server on http://${config.host}:${config.port} (UI: http://localhost:${config.uiPort} via vite)`
);
if (config.judge.on) console.log(`Judge mode: sign-in required, ${config.judge.cap} renders a day, draft limits on.`);
console.log(`ComfyUI: ${config.comfyUrl} · Comfy API v2: ${config.comfyBaseUrl}`);

// Engine autostart, only when the machine told us how. Never guesses.
if (comfy.canLaunchEngine()) {
  void comfy.launchEngine().then((ok) => {
    if (ok) clearPreflightCache();
    console.log(ok ? 'ComfyUI engine up' : 'ComfyUI engine did not start — use START ENGINE in the UI');
    if (ok) void eng.ensureProxy().then((up) => {
      console.log(up ? 'Comfy API v2 up' : `Comfy API v2 not answering at ${config.comfyBaseUrl}`);
      if (up) void reconcile();
    });
  });
} else {
  void eng.ensureProxy().then((up) => { if (up) void reconcile(); });
}
process.on('SIGINT', () => { eng.stopProxy(); closePhoneSession(); process.exit(0); });
process.on('SIGTERM', () => { eng.stopProxy(); closePhoneSession(); process.exit(0); });
