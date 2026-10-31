/**
 * OpenField MCP server (stdio). Lets any MCP agent drive every OpenField app.
 *
 * A thin client of the OpenField HTTP API (OPENFIELD_URL, default
 * http://127.0.0.1:3161): request bodies come from ./bodies.ts, which mirrors
 * the pages, and every render is queued, tracked and saved by the server.
 *
 *   npx tsx mcp/server.ts            (or: npm run mcp)
 *
 * stdout is the MCP channel. Log to stderr only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  DIRECTOR_AXES, DIRECTOR_MOVES, DREAM_CREATIVITY, DREAM_MAX_SECONDS, EDIT_APPS, ERA_DECADES, ERA_MAX, ERA_MIN, EXPAND_ASPECTS, IMAGE_MODELS, IMAGE_QUALITY, IMAGE_RES,
  MIRROR_CONTROLS, PRESETS, PRESET_CATS, RECIPES, REDRAW_HEIGHTS, RELIGHT_DIRECTIONS, RESHOOT_ANGLES, SCENE_FRAMINGS, SCENE_MAX_SHOTS, SCENE_MIN_SHOTS, SHOT_SECONDS,
  SPEED_RAMPS, TRANSITION_STYLES, UPSCALE_MODES, VIDEO_MODELS, compilePrompt, presetById, upscaleSize,
  CUTOUT_BACKGROUNDS, CUTOUT_MODES, RESTYLE_STYLES, SWAP_MAX_SECONDS,
  type EditMode, type RampId,
} from '../src/catalog.ts';
import {
  ASPECT_IDS, MIRROR_MODES, cutoutBody, restyleBody, swapBody, directorBody, editBody, sceneBody, stageBody, withGenre, effectBody, fixSeamBody, hdrBody, extendBody, imageBody, mirrorBody, reshootBody, soundBody, speakBody,
  transitionBody, upscaleBody, videoBody, videoSize, wire, objectBody, type Body, type DirectorPicks, type LoraPick, type SourceRef,
} from './bodies.ts';
import { EFFECTS, EFFECT_QUALITY, effectPrompt } from '../src/effects.ts';
import { APP_MAX_TIER, RENDER_TIERS, appTier, tierCapNote, tiersUpTo, type RenderTier, type TierApp } from '../src/renderTier.ts';
import { CAMERA_MOVES, LENS_MAX, LENS_MIN, MAX_KEYS, MAX_PROPS, MODEL_PROP_SIZE, PROP_DEFAULTS, STAGE_SECONDS, cleanStageScene, stageFrames, stageSize, stageTier, type CameraKey, type StageProp, type Vec3 } from '../src/stage.ts';
import { BASE, api, finishFileUrl, getTake, localPath, mediaUrl, posterImage, resolveInput, settingsOf, type Asset, type Take } from './client.ts';
import { OBJECT_DETAIL } from '../src/catalog.ts';

const server = new McpServer(
  { name: 'openfield', version: '0.1.0' },
  {
    instructions: [
      'OpenField is a local, open-weights creative suite (video, image, edit, remove background, director, loop, effects, mirror, restyle, object swap, reshoot, extend, transition, speak, add sound, upscale, stage, image to 3D) running on the user\'s own GPU through ComfyUI.',
      'Generate tools only QUEUE work and return take ids; renders take from ~20 s (stills) to several minutes (video). Call wait_for_take with those ids, then get_take for the output path and a preview image.',
      'Image and clip inputs are local file paths or `take:<id>` to reuse a finished take (e.g. animate a still made by generate_image).',
      'Cast: characters, props and places saved with create_cast are @mentioned by name in any prompt (e.g. "@Mara walks through the market"). Stills compose them from their pictures (Qwen-Image-Edit), videos hold them on a reference sheet (LTX-2.5 Ingredients IC-LoRA) or start from a composed hero frame, Mirror and Speak make a hero frame when no frame is given.',
      'Director: direct_shot for one frame or shot, direct_scene to plan a scene into shots with a local LLM and cut them together.',
      'Stage: stage_render blocks a shot in 3D (boxes, figures, walls, a camera path) and renders it with LTX-2.5 Layout to Render; the shot keeps the blocking\'s camera move and layout.',
      'Call status first if unsure whether the engine is up. Video renders occupy the GPU; prefer count 1 while iterating.',
      'Render size: every video tool renders at the machine-wide size set in Setup (720p on a 24 GB or larger card, 480p below; OPENFIELD_RENDER_TIER can set it) unless you pass `resolution`. 720p takes 1.3 to 2x the time of 480p; past 720p, use upscale.',
    ].join(' '),
  },
);

// ---------- helpers ----------

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (v: unknown): Content => ({ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) });
const fail = (e: unknown) => ({ isError: true, content: [text(e instanceof Error ? e.message : String(e))] });

/** Wrap a handler so thrown errors come back as tool errors the agent can read. */
function safe<A>(fn: (a: A, extra: any) => Promise<{ content: Content[] }>) {
  return async (a: A, extra: any) => {
    try { return await fn(a, extra); } catch (e) { return fail(e); }
  };
}

const TERMINAL = new Set(['done', 'failed', 'stopped']);

function summarize(t: Take) {
  const s = settingsOf(t);
  return {
    id: t.id,
    status: t.status,
    kind: t.kind,
    app: s.app ?? (t.kind === 'still' ? 'image' : t.kind === 'upres' ? 'upscale' : 'video'),
    ...(s.app === 'upscale' ? { upscale_mode: s.mode, source_size: `${s.sourceWidth}x${s.sourceHeight}` } : {}),
    model: s.videoModel ?? s.model,
    prompt: s.userPrompt ?? s.prompt,
    compiled_prompt: s.prompt,
    preset: s.preset,
    ...(s.app === 'director' ? { genre: s.picks?.genre, era: s.era ?? undefined, era_graded: s.eraGraded || undefined, ramp: s.ramp && s.ramp !== 'linear' ? s.ramp : undefined, seconds_after_ramp: s.outSeconds } : {}),
    ...(s.cut ? { scene_cut: true, shots: (s.shots ?? []).map((x: any, i: number) => ({ n: i + 1, framing: x.framing, move: x.move, action: x.action, seconds: x.seconds, cast: x.cast, hero_take: x.hero, take: x.take })) } : {}),
    ...(s.sceneOf ? { scene_cut_take: s.sceneOf, scene_shot: s.sceneIndex + 1 } : {}),
    ...(s.app === 'stage' ? { stage: t.kind === 'still' ? { look_frame: true, engine: s.engine } : { resolution: s.resolution ?? stageTier(s.quality), look_take: s.lookTake, frames: s.frames, props: s.scene?.props?.length, lens: s.scene?.lens, blocked_on: s.blockedOn ?? 'browser' } } : {}),
    width: s.width,
    height: s.height,
    seconds: s.seconds,
    seed: s.seed,
    output_path: t.output_path,
    ...(s.alphaPath ? { alpha_path: s.alphaPath } : {}),
    media_url: t.output_path ? mediaUrl(t.id) : null,
    render_seconds: t.render_seconds,
    error: t.error,
    transcript: t.transcript,
    parent_take_id: t.parent_take_id ?? s.upresOf ?? s.sourceTake ?? null,
    ...(s.seam ? { seam: { verdict: s.seam.verdict, ratio: s.seam.ratio, texture_ratio: s.seam.texture?.ratio, composition_ratio: s.seam.composition?.ratio, ...(s.seam.splices ? { splices: s.seam.splices } : {}) } } : {}),
    ...(s.app === 'seam' ? { seam_fix: s.mode, seam_before: s.before } : {}),
    ...(s.app === 'object' ? {
      object: {
        format: 'glb', quality: s.quality === 'quality' ? 'high' : 'draft', max_faces: s.faces, texture_px: s.texture, background_removed: s.removeBackground !== false,
        glb_url: t.output_path ? mediaUrl(t.id) : null,
        turntable_url: t.output_path ? `${BASE}/api/takes/${t.id}/turntable` : null,
        subject_url: t.output_path ? `${BASE}/api/takes/${t.id}/subject` : null,
      },
    } : {}),
    ...(s.hdr ? {
      hdr: s.hdr.error ? { error: s.hdr.error } : {
        exr_zip: s.hdr.exrZip, hlg_mov: s.hdr.hlgMov, prores_mov: s.hdr.proresMov,
        exr_zip_url: finishFileUrl(t.id, 'exr'), hlg_mov_url: finishFileUrl(t.id, 'hlg'), ...(s.hdr.proresMov ? { prores_mov_url: finishFileUrl(t.id, 'prores') } : {}),
        check: s.hdr.check,
      },
    } : {}),
    created_at: t.created_at,
  };
}

async function withPreview(t: Take, preview: boolean): Promise<Content[]> {
  const out: Content[] = [text(summarize(t))];
  if (preview && t.status === 'done') {
    const img = await posterImage(t.id);
    if (img) out.push({ type: 'image', ...img });
  }
  return out;
}

async function queue(body: Body, extra: Record<string, unknown> = {}) {
  const r = await api.generate(body);
  return {
    content: [text({
      queued: true,
      take_ids: r.takeIds,
      width: body.width,
      height: body.height,
      seconds: body.seconds,
      prompt: body.prompt,
      ...extra,
      next: `wait_for_take with take_ids ${JSON.stringify(r.takeIds)}`,
    })],
  };
}

// ---------- shared schemas ----------

const inputRef = (what: string) =>
  z.string().min(1).describe(`${what}: a local file path (absolute, ~/..., or C:\\... under WSL) or take:<id> to reuse a finished take`);
const count = z.number().int().min(1).max(4).default(1).describe('How many takes to queue, each with the next seed (1-4)');
const loras = z.array(z.object({
  name: z.string().min(1).describe('LoRA filename exactly as list_loras shows it'),
  strength: z.number().min(-2).max(2).default(1),
})).max(4).optional().describe('Your own LoRAs (list_loras), up to 4. Each must be made for the model this app runs; the server refuses a mismatch.');
const aspect = z.enum(ASPECT_IDS);
const presetIds = PRESETS.map((p) => p.id) as [string, ...string[]];
const videoModel = z.enum(VIDEO_MODELS.map((m) => m.id) as ['ltx25', 'h3']).default('ltx25')
  .describe('ltx25 (default, commercial-friendly). h3 = MiniMax H3; its license excludes the US, EU, UK and South Korea, and it needs a start image.');
/**
 * A tool's `resolution`: the tiers the app runs at. Left out, the tool renders at
 * the machine-wide size from Setup (GET /api/settings), the same default the pages use.
 */
const tierArg = (app: TierApp) => z.enum(tiersUpTo(APP_MAX_TIER[app]).map((t) => t.id) as [RenderTier, ...RenderTier[]]).optional()
  .describe(`Render size. Default: the machine-wide size from Setup. ${tiersUpTo(APP_MAX_TIER[app]).map((t) => `${t.id}: ${t.note}`).join(' ')}${tierCapNote(app) ? ` ${tierCapNote(app)}` : ''}`);
const videoRes = tierArg('video');

/** The size a tool renders at: the one asked for, else the machine-wide size, capped for the app. */
async function tierFor(app: TierApp, asked: RenderTier | undefined): Promise<RenderTier> {
  return appTier(app, asked ?? (await api.settings()).renderTier.tier);
}
const imageModel = z.enum(IMAGE_MODELS.map((m) => m.id) as ['qwen', 'flux2']).default('qwen')
  .describe('qwen = Qwen-Image (Apache 2.0, text/layout). flux2 = FLUX.2 dev (non-commercial license, photoreal).');

// ---------- read-only tools ----------

const RO = { readOnlyHint: true, openWorldHint: false } as const;
const GPU = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

server.registerTool('status', {
  title: 'Engine status',
  description: 'Is the OpenField engine up: ComfyUI version, GPU, free VRAM, local or cloud target, the active queue, and which model bundles are installed.',
  inputSchema: {},
  annotations: RO,
}, safe(async () => {
  const [st, pf] = await Promise.all([api.status(), api.preflight().catch(() => null)]);
  return {
    content: [text({
      openfield: BASE,
      engine_up: st.up,
      comfy_api_v2: st.api,
      target: st.target,
      comfyui_version: st.version,
      gpu: st.gpu,
      vram_free_gb: st.vramFreeGb != null ? Number(st.vramFreeGb.toFixed(1)) : undefined,
      vram_total_gb: st.vramTotalGb != null ? Number(st.vramTotalGb.toFixed(1)) : undefined,
      other_gpu_process: st.otherGpuProcess,
      queue: (st.active as Take[] | undefined ?? []).map((t) => ({ id: t.id, status: t.status, kind: t.kind, shot: t.shot_name })),
      bundles: pf?.bundles.map((b) => ({ id: b.id, label: b.label, ready: b.ready, optional: b.optional, license_warning: b.licenseWarning })),
    })],
  };
}));

server.registerTool('list_presets', {
  title: 'List presets and options',
  description: 'Motion presets for generate_video / make_loop (camera moves, epic moves, effects, moods, each a prompt fragment), the LoRA effects for apply_effect, plus the Director axes, Mirror modes, Reshoot angles, Transition styles, edit_image modes and their options, and model menus.',
  inputSchema: {
    section: z.enum(['motion', 'effects', 'director', 'mirror', 'restyle', 'cutout', 'reshoot', 'transition', 'edit', 'models', 'all']).default('all'),
    category: z.enum(PRESET_CATS.map((c) => c.id) as [string, ...string[]]).default('all').describe('Filter motion presets by category'),
  },
  annotations: RO,
}, safe(async ({ section, category }) => {
  const out: Record<string, unknown> = {};
  const want = (s: string) => section === 'all' || section === s;
  if (want('motion')) out.motion_presets = PRESETS.filter((p) => category === 'all' || p.cat === category).map((p) => ({ id: p.id, name: p.name, category: p.cat, text: p.text }));
  if (want('effects')) {
    out.effects = EFFECTS.map((e) => ({
      id: e.id, name: e.name, input: e.input, what: e.blurb, text: e.field ? { asks_for: e.field.label, default: e.field.default, example: e.field.placeholder } : null,
      max_seconds: e.input === 'clip' ? e.maxSeconds : undefined, loopable: !!e.loopable, lora: e.lora, credit: e.credit,
    }));
  }
  if (want('director')) {
    out.director_axes = Object.fromEntries(DIRECTOR_AXES.map((a) => [a.id, a.options.map((o) => ({ id: o.id, label: o.label, text: o.text, ...(o.sets ? { sets: o.sets } : {}) }))]));
    out.director_moves = DIRECTOR_MOVES.map((p) => p.id);
    out.director_eras = { min: ERA_MIN, max: ERA_MAX, decades: ERA_DECADES.map((d) => ({ year: d.year, label: d.label, text: d.text })) };
    out.speed_ramps = SPEED_RAMPS;
  }
  if (want('mirror')) out.mirror_modes = Object.entries(MIRROR_MODES).map(([mode, control]) => ({ mode, ...MIRROR_CONTROLS.find((c) => c.id === control) }));
  if (want('restyle')) out.restyle_styles = RESTYLE_STYLES.map((r) => ({ id: r.id, label: r.label, look: r.text }));
  if (want('cutout')) { out.cutout_modes = CUTOUT_MODES; out.cutout_backgrounds = CUTOUT_BACKGROUNDS; }
  if (want('reshoot')) out.reshoot_angles = RESHOOT_ANGLES;
  if (want('transition')) out.transition_styles = TRANSITION_STYLES.map((t) => ({ id: t.id, label: t.label, text: t.text }));
  if (want('edit')) {
    out.edit_modes = EDIT_APPS.map((a) => ({ mode: a.id, name: a.name, blurb: a.blurb, options: a.chips.map((c) => ({ id: c.id, label: c.label })), default_options: a.defaults }));
    out.relight_directions = RELIGHT_DIRECTIONS.map((d) => ({ id: d.id, label: d.label }));
    out.expand_aspects = EXPAND_ASPECTS.map((a) => a.id);
  }
  if (want('models')) {
    out.video_models = VIDEO_MODELS.map((m) => ({ id: m.id, label: m.label, note: m.note, start: m.start, end: m.end, audio: m.audio, durations: m.durations, license: m.license, warn: m.warn }));
    out.image_models = IMAGE_MODELS.map((m) => ({ id: m.id, label: m.label, note: m.note, license: m.license, warn: m.warn }));
    out.video_resolutions = RENDER_TIERS;
    out.render_size = (await api.settings().catch(() => null))?.renderTier ?? null;
    out.image_resolutions = IMAGE_RES;
    out.image_quality = IMAGE_QUALITY;
    out.aspects = ASPECT_IDS;
  }
  return { content: [text(out)] };
}));

server.registerTool('list_recipes', {
  title: 'List recipes',
  description: 'Ready-made shots (prompt + motion preset). Pass a recipe\'s prompt and preset to generate_video to recreate it.',
  inputSchema: {},
  annotations: RO,
}, safe(async () => ({
  content: [text(RECIPES.map((r) => ({ id: r.id, name: r.name, preset: r.preset, prompt: r.prompt, compiled_prompt: compilePrompt([r.prompt, presetById(r.preset).text]) })))],
})));

server.registerTool('list_takes', {
  title: 'List takes',
  description: 'Recent takes (renders), newest first, with status, prompt and output path.',
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(20),
    status: z.enum(['queued', 'rendering', 'done', 'failed', 'stopped', 'active']).optional().describe('active = queued or rendering'),
    kind: z.enum(['still', 'video', 'upres']).optional(),
    app: z.string().optional().describe('director, edit, mirror, reshoot, upscale, reshoot-warp (angle previews), preset-thumb, ...'),
    project: z.number().int().optional().describe('Project id'),
  },
  annotations: RO,
}, safe(async ({ limit, status, kind, app, project }) => {
  const all = await api.takes(project);
  const rows = all.filter((t) => {
    if (status === 'active' ? !(t.status === 'queued' || t.status === 'rendering') : status && t.status !== status) return false;
    if (kind && t.kind !== kind) return false;
    if (app && settingsOf(t).app !== app) return false;
    return true;
  }).slice(0, limit);
  return { content: [text({ count: rows.length, takes: rows.map(summarize) })] };
}));

server.registerTool('get_take', {
  title: 'Get take',
  description: 'One take: status, output path, settings, error. For finished takes also returns a preview image (the still itself, or a poster frame for videos).',
  inputSchema: {
    take_id: z.number().int(),
    preview: z.boolean().default(true),
  },
  annotations: RO,
}, safe(async ({ take_id, preview }) => ({ content: await withPreview(await getTake(take_id), preview) })));

server.registerTool('wait_for_take', {
  title: 'Wait for takes',
  description: 'Poll until every given take is done, failed or stopped, or the timeout passes. Returns each take\'s final state, with a preview image for finished ones.',
  inputSchema: {
    take_ids: z.array(z.number().int()).min(1).max(16),
    timeout_seconds: z.number().int().min(5).max(3600).default(900),
    preview: z.boolean().default(true),
  },
  annotations: RO,
}, safe(async ({ take_ids, timeout_seconds, preview }, extra) => {
  const started = Date.now();
  const deadline = started + timeout_seconds * 1000;
  const token = extra?._meta?.progressToken;
  let latest: Take[] = [];
  for (;;) {
    const all = await api.takes();
    latest = take_ids.map((id) => all.find((t) => t.id === id)).filter(Boolean) as Take[];
    const missing = take_ids.filter((id) => !latest.some((t) => t.id === id));
    if (missing.length) throw new Error(`Unknown take id(s): ${missing.join(', ')}`);
    const finished = latest.filter((t) => TERMINAL.has(t.status)).length;
    if (finished === latest.length || Date.now() >= deadline) break;
    if (token !== undefined) {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: finished, total: latest.length, message: `${finished}/${latest.length} finished, ${Math.round((Date.now() - started) / 1000)}s` },
      }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const timedOut = latest.some((t) => !TERMINAL.has(t.status));
  const content: Content[] = [text({ timed_out: timedOut, waited_seconds: Math.round((Date.now() - started) / 1000) })];
  for (const t of latest) content.push(...(await withPreview(t, preview && latest.length <= 4)));
  return { content };
}));

// ---------- generate tools ----------

server.registerTool('generate_video', {
  title: 'Generate video',
  description: 'Video app: text to video, or image to video with a start frame and optional end frame (first + last). A motion preset appends camera/effect direction to the prompt (see list_presets). Queues the render and returns take ids.',
  inputSchema: {
    prompt: z.string().default('').describe('The shot: who, where, what happens. The preset adds the camera. Prompts may @mention cast members (list_cast): @Mara puts her description in the prompt and her pictures into the engine.'),
    preset: z.enum(presetIds).default('free').describe('Motion preset id (list_presets). free = no added direction.'),
    seconds: z.number().int().min(1).max(10).default(5).describe('Duration. The UI offers 3/5/8/10 for LTX-2.5, 5/8/10 for H3.'),
    aspect: z.union([z.literal('auto'), aspect]).default('auto').describe('auto = follow the start image, else 16:9'),
    resolution: videoRes,
    start_image: inputRef('Start frame').optional(),
    end_image: inputRef('End frame').optional(),
    audio: z.boolean().default(false).describe('Generate sound with the video'),
    count,
    model: videoModel,
    cast_mode: z.enum(['sheet', 'frame']).default('sheet')
      .describe('Only when the prompt @mentions cast and there is no start/end image. sheet: their pictures on a reference sheet steer every frame (LTX-2.5 Ingredients, 768x448-class, 5 s minimum). frame: a hero frame of them is composed first, then animated.'),
    loras,
  },
  annotations: GPU,
}, safe(async (a) => {
  const start = a.start_image ? await resolveInput(a.start_image, 'image') : undefined;
  const end = a.end_image ? await resolveInput(a.end_image, 'image') : undefined;
  const size = videoSize(a.aspect, await tierFor('video', a.resolution), start?.dims);
  const body = videoBody({ model: a.model, prompt: a.prompt, preset: a.preset, size, seconds: a.seconds, count: a.count, audio: a.audio, startImage: start?.token, endImage: end?.token, castMode: a.cast_mode, loras: a.loras as LoraPick[] | undefined });
  return queue(wire(body));
}));

server.registerTool('make_loop', {
  title: 'Make seamless loop',
  description: 'Seamless Loop app: one image becomes both the first and last frame, so the clip loops with no seam. Describe what moves inside the loop.',
  inputSchema: {
    image: inputRef('The image to loop'),
    prompt: z.string().default('').describe('What moves inside the loop'),
    preset: z.enum(presetIds).default('free').describe('Motion preset id. static (Locked Off) suits most loops.'),
    seconds: z.number().int().min(1).max(10).default(5),
    aspect: z.union([z.literal('auto'), aspect]).default('auto'),
    resolution: videoRes,
    audio: z.boolean().default(false).describe('House rule: loops are silent. Leave off unless asked.'),
    auto_fix: z.boolean().default(false).describe('Seam Doctor: if the finished loop measures a visible seam, try to improve it (trim, regenerate the wrap, then a new seed). Off by default: measured, it lowers the wrap on most loops but fully closes few. Tries arrive as new takes; the original is kept. Every loop is measured either way; get_take shows seam.'),
    count,
    model: videoModel,
  },
  annotations: GPU,
}, safe(async (a) => {
  const img = await resolveInput(a.image, 'image');
  const size = videoSize(a.aspect, await tierFor('video', a.resolution), img.dims);
  return queue(wire(videoBody({ model: a.model, prompt: a.prompt, preset: a.preset, size, seconds: a.seconds, count: a.count, audio: a.audio, startImage: img.token, loop: true, autoFix: a.auto_fix })));
}));

server.registerTool('generate_image', {
  title: 'Generate image',
  description: 'Image app: stills from Qwen-Image or FLUX.2. Finished stills can feed generate_video / make_loop / direct_shot as take:<id>. A prompt that @mentions cast is composed from their pictures: by Qwen-Image-Edit 2509 on qwen, or as FLUX.2 reference latents on flux2 (photographic skin, identity held).',
  inputSchema: {
    prompt: z.string().min(1).describe('The image. @Name brings in a cast member (list_cast). With references, point at them as "the person in image 1".'),
    model: imageModel,
    aspect: aspect.default('16:9'),
    quality: z.enum(['draft', 'quality']).default('quality').describe('draft = 8 steps, quality = full sampling'),
    resolution: z.enum(IMAGE_RES.map((r) => r.id) as ['1K', '2K']).default('1K'),
    count,
    references: z.array(inputRef('Reference picture')).max(6).optional()
      .describe('flux2 only: up to 6 pictures whose people, clothes and objects carry into a new photograph. Numbered in order, before any @cast pictures.'),
    loras,
  },
  annotations: GPU,
}, safe(async (a) => {
  const refs = a.references?.length ? await Promise.all(a.references.map((r) => resolveInput(r, 'image'))) : [];
  return queue(wire(imageBody({
    model: a.model, prompt: a.prompt, aspect: a.aspect, quality: a.quality, res: a.resolution, count: a.count,
    loras: a.loras as LoraPick[] | undefined, refImages: refs.map((r) => r.token),
  })));
}));

server.registerTool('list_loras', {
  title: 'List your LoRAs',
  description: 'Every LoRA file the engine can see that OpenField does not load by itself, with the model family read from its tensor keys (ltx = Video / LTX-2.5, qwen = Image on Qwen-Image, flux2 = Image on FLUX.2; null = could not read it, allowed anywhere). Pass names to generate_video / generate_image as loras. New files in ComfyUI models/loras show up without a restart.',
  inputSchema: {},
  annotations: RO,
}, safe(async () => {
  const list = await api.loras();
  return { content: [text(list.length ? list : 'No LoRAs of your own yet. Put .safetensors files in ComfyUI models/loras.')] };
}));

const axisSchema = (id: string) => {
  const ax = DIRECTOR_AXES.find((x) => x.id === id)!;
  return z.enum(ax.options.map((o) => o.id) as [string, ...string[]]).default('auto')
    .describe(ax.options.filter((o) => o.id !== 'auto').map((o) => `${o.id}: ${o.label}`).join('; '));
};

const eraSchema = z.number().int().min(ERA_MIN).max(ERA_MAX).optional()
  .describe(`Era year ${ERA_MIN}-${ERA_MAX}. Names the nearest decade in the prompt (${ERA_DECADES.map((d) => d.label).join(', ')}) and, with era_grade, grades the output (a GLSL pass blended between decades). Omit for none.`);
const rampSchema = z.enum(SPEED_RAMPS.map((r) => r.id) as [RampId, ...RampId[]]).default('linear')
  .describe(`Speed ramp, a retime after the render (RIFE in-between frames, frames picked along a curve). ${SPEED_RAMPS.map((r) => `${r.id}: ${r.note}`).join('; ')}. Ramped shots run longer and have no sound.`);

/** Axis args the director tools share, minus any the tool sets elsewhere. */
function picksFrom(a: Record<string, unknown>, skip: string[] = []): DirectorPicks {
  const picks: DirectorPicks = {};
  for (const ax of DIRECTOR_AXES) {
    if (skip.includes(ax.id)) continue;
    const v = a[ax.id];
    if (typeof v === 'string' && v !== 'auto') picks[ax.id] = v;
  }
  return withGenre(picks);
}

server.registerTool('direct_shot', {
  title: 'Director',
  description: 'Director app: write the scene, pick genre, camera, framing, light, film stock, look and grade, an era year and a speed ramp; they compile into the prompt and the era also grades the output. A genre fills light, grade, look and camera unless you set them. mode=frame makes hero stills; mode=shot renders the video (optionally from a hero frame, with a camera move). Typical flow: frame (count 2-4) -> pick one -> shot with hero_image take:<id>. For several shots of one scene cut together, use direct_scene.',
  inputSchema: {
    scene: z.string().default('').describe('Who, where, what is happening. @Name brings in a cast member: frames are composed from their pictures, shots without a hero image hold them on a reference sheet.'),
    mode: z.enum(['frame', 'shot']).default('frame'),
    genre: axisSchema('genre'),
    camera: axisSchema('camera'),
    framing: axisSchema('framing'),
    light: axisSchema('light'),
    film: axisSchema('film'),
    look: axisSchema('look'),
    grade: axisSchema('grade'),
    era: eraSchema,
    era_grade: z.boolean().default(true).describe('Grade the output for the era (only when era is set). Turn off when the hero frame was already graded.'),
    ramp: rampSchema.describe('Shot mode only. ' + SPEED_RAMPS.map((r) => `${r.id}: ${r.note}`).join('; ')),
    move: z.enum(DIRECTOR_MOVES.map((p) => p.id) as [string, ...string[]]).default('push-in').describe('Camera move, shot mode only'),
    hero_image: inputRef('Hero frame to shoot from (shot mode)').optional(),
    aspect: aspect.default('16:9'),
    image_model: imageModel,
    seconds: z.union([z.literal(3), z.literal(5), z.literal(8), z.literal(10)]).default(5).describe('Shot mode duration, before any ramp'),
    audio: z.boolean().default(false).describe('Shot mode sound (dropped on ramped shots)'),
    resolution: tierArg('director').describe('Shot mode render size. Default: the machine-wide size from Setup.'),
    count: z.number().int().min(1).max(4).optional().describe('Default 2 frames in frame mode, 1 in shot mode'),
  },
  annotations: GPU,
}, safe(async (a) => {
  const picks = picksFrom(a as Record<string, unknown>);
  if (a.mode === 'frame' && a.hero_image) throw new Error('hero_image is for mode=shot');
  if (a.mode === 'frame' && a.ramp !== 'linear') throw new Error('ramp is for mode=shot');
  const hero = a.hero_image ? await resolveInput(a.hero_image, 'image') : undefined;
  const body = directorBody({
    mode: a.mode, scene: a.scene, picks, era: a.era ?? null, grade: a.era_grade, ramp: a.ramp, aspect: a.aspect, count: a.count ?? (a.mode === 'frame' ? 2 : 1),
    imageModel: a.image_model, move: a.move, seconds: a.seconds, audio: a.audio, heroImage: hero?.token, res: await tierFor('director', a.resolution),
  });
  return queue(wire(body), { picks, era: a.era ?? null, ramp: a.mode === 'shot' ? a.ramp : undefined });
}));

server.registerTool('direct_scene', {
  title: 'Director scene',
  description: [
    'Director Scene mode: one scene becomes 2-6 shots, each rendered on LTX-2.5, then cut together into one video take.',
    'Without `shots`, a local LLM plans the shot list first (Gemma 3 12B inside the engine, then the OpenAI-compatible server in OPENFIELD_LLM_URL if set, then Ollama if it answers, else one shot per sentence); the plan comes back in the result.',
    'Pass `shots` to use your own list (framing, move, action, seconds, optional per-shot ramp). plan_only returns the plan without rendering, so you can edit it and call again with shots.',
    'Genre, the other axes, era and ramp apply to every shot. hero_frames makes a Qwen-Image still per shot first and shoots from it (slower, steadier look).',
    'Returns the cut take id: wait_for_take on it (a 3-shot scene is several minutes on a busy GPU, longer at 720p). The shots are takes too (shot_takes once known, via get_take on the cut).',
    'Re-roll one shot: call again with the same shots, each kept shot carrying `take` (its finished take id); only shots without one render.',
    '@Name in the scene brings in a cast member: the planner copies its id onto every shot that names it, and a shot with `cast` starts from a Cast hero frame.',
  ].join(' '),
  inputSchema: {
    scene: z.string().min(1).describe('The whole scene, beat by beat'),
    shots: z.array(z.object({
      framing: z.enum(SCENE_FRAMINGS.map((f) => f.id) as [string, ...string[]]),
      move: z.enum(DIRECTOR_MOVES.map((p) => p.id) as [string, ...string[]]),
      action: z.string().min(1).describe('What happens in this shot, one sentence'),
      seconds: z.number().int().min(SHOT_SECONDS.min).max(SHOT_SECONDS.max).default(3),
      ramp: z.enum(SPEED_RAMPS.map((r) => r.id) as [RampId, ...RampId[]]).optional().describe('Overrides the scene ramp for this shot'),
      take: z.number().int().optional().describe('A finished video take to reuse for this shot instead of rendering it'),
      cast: z.array(z.number().int()).optional().describe('Cast member ids for this shot (list_cast). The shot starts from a Qwen-Image-Edit hero frame composed from their pictures, then LTX shoots it. Planned shots get these from @Name mentions in the scene'),
    })).min(1).max(SCENE_MAX_SHOTS).optional().describe('Your own shot list. Omit to have the local LLM plan one.'),
    shot_count: z.number().int().min(SCENE_MIN_SHOTS).max(SCENE_MAX_SHOTS).optional().describe('How many shots the planner should write (default: it decides, 2-4)'),
    planner: z.enum(['auto', 'engine', 'llm', 'ollama', 'split']).default('auto').describe('auto = engine, then the OPENFIELD_LLM_URL server if set, then Ollama, then a sentence split'),
    plan_only: z.boolean().default(false),
    genre: axisSchema('genre'),
    camera: axisSchema('camera'),
    light: axisSchema('light'),
    film: axisSchema('film'),
    look: axisSchema('look'),
    grade: axisSchema('grade'),
    era: eraSchema,
    era_grade: z.boolean().default(true),
    ramp: rampSchema,
    aspect: aspect.default('16:9'),
    resolution: tierArg('scene'),
    hero_frames: z.boolean().default(false),
    image_model: imageModel,
    audio: z.boolean().default(false).describe('Keep each shot\'s generated sound in the cut (ramped shots stay silent)'),
  },
  annotations: GPU,
}, safe(async (a, extra) => {
  const picks = picksFrom(a as Record<string, unknown>, ['framing']);
  const token = extra?._meta?.progressToken;
  let shots = a.shots;
  let planned: Record<string, unknown> | undefined;
  if (!shots) {
    let p = await api.directorPlan({ scene: a.scene, shots: a.shot_count, planner: a.planner === 'auto' ? undefined : a.planner });
    const deadline = Date.now() + 25 * 60_000;
    const started = Date.now();
    let tick = 0;
    while (p.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      p = await api.directorPlanStatus(p.id);
      // Progress keeps the client's request timer alive while a busy GPU queue holds the planner.
      if (token !== undefined) {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: ++tick, message: `planning the shots, ${Math.round((Date.now() - started) / 1000)}s` },
        }).catch(() => {});
      }
    }
    if (p.status !== 'done' || !p.shots) throw new Error(p.error ?? 'Planning did not finish (is the GPU queue busy?)');
    shots = p.shots.map((s) => ({ ...s, seconds: s.seconds }));
    planned = { planner: p.planner, plan_seconds: p.seconds, notes: p.notes.length ? p.notes : undefined };
  }
  if (a.plan_only) return { content: [text({ scene: a.scene, shots, ...planned, next: 'call direct_scene again with these shots (edited as you like) to render' })] };
  const body = sceneBody({
    scene: a.scene, picks, era: a.era ?? null, grade: a.era_grade, ramp: a.ramp, audio: a.audio, heroFrames: a.hero_frames, imageModel: a.image_model,
    aspect: a.aspect, res: await tierFor('scene', a.resolution), shots: shots.map((s) => ({ framing: s.framing, move: s.move, action: s.action, seconds: s.seconds, ramp: (s as { ramp?: RampId }).ramp, cast: (s as { cast?: number[] }).cast })),
  });
  // Shots the caller marked as already shot keep their takes.
  (body.shots as Record<string, unknown>[]).forEach((s, i) => { const t = (shots![i] as { take?: number }).take; if (t) s.take = t; });
  const r = await api.directorScene(wire(body));
  return {
    content: [text({
      queued: true, cut_take_id: r.cutId, width: body.width, height: body.height, shots, ...planned,
      next: `wait_for_take with take_ids [${r.cutId}] (the cut lands when every shot is done)`,
    })],
  };
}));

server.registerTool('mirror_motion', {
  title: 'Mirror',
  description: 'Mirror app: keep the motion of a source clip (e.g. filmed on a phone) and change everything else. mode body tracks the skeleton, scene keeps depth and the camera move, outlines keeps contours. Uses the first 12 s of the clip.',
  inputSchema: {
    source: inputRef('Source clip (2-12 s video)'),
    prompt: z.string().min(1).describe('Who and where, e.g. "A knight in battered silver armor in a torchlit stone hall, same moves as the clip." @Name brings in a cast member; with no first_frame, a frame of them in the clip\'s opening pose is composed first.'),
    mode: z.enum(['body', 'scene', 'outlines']).default('body'),
    first_frame: inputRef('Optional character/world frame matching the clip framing').optional(),
    strength: z.number().min(0.4).max(1).default(1).describe('Hold to the clip, 0.4-1'),
    audio: z.boolean().default(false),
    resolution: tierArg('mirror'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const src = await resolveInput(a.source, 'video');
  const frame = a.first_frame ? await resolveInput(a.first_frame, 'image') : undefined;
  return queue(wire(mirrorBody({
    control: MIRROR_MODES[a.mode], sourceVideo: src.token, clip: src.clip!, firstFrame: frame?.token,
    prompt: a.prompt, strength: a.strength, audio: a.audio, count: a.count, res: await tierFor('mirror', a.resolution),
  })), { clip: src.clip });
}));

server.registerTool('remove_background', {
  title: 'Remove background',
  description: [
    'Remove background app: cut the subject out of a still or a clip. No video model; BiRefNet matte, plus SAM 3.1 tracking for clips.',
    'Stills: a transparent PNG (~2 s on a 5090), or over a color, a blur or a new picture.',
    'Clips (up to 20 s, source size capped at 1920): background transparent gives ProRes 4444 with alpha; get_take returns the alpha file as alpha_path and the take itself is an MP4 preview over a checkerboard.',
    CUTOUT_MODES.map((m) => `mode ${m.id}: ${m.note}`).join(' '),
  ].join(' '),
  inputSchema: {
    source: inputRef('The still or clip to cut out'),
    mode: z.enum(CUTOUT_MODES.map((m) => m.id) as ['matte', 'hybrid', 'track']).default('matte').describe('Clips only'),
    subject: z.string().default('').describe('Clips, hybrid/track: what to keep, e.g. "person", "the dog". Default person'),
    background: z.enum(CUTOUT_BACKGROUNDS.map((b) => b.id) as ['transparent', 'color', 'blur', 'image']).default('transparent'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff').describe('background=color'),
    background_image: inputRef('background=image: the picture to put behind').optional(),
    audio: z.boolean().default(false).describe('Clips: keep the sound'),
  },
  annotations: GPU,
}, safe(async (a) => {
  const ref = a.source.trim();
  const m = /^take:(\d+)$/i.exec(ref);
  let source: { kind: 'image' | 'video'; take?: number; token?: string; name: string };
  if (m) {
    const t = await getTake(Number(m[1]));
    if (t.status !== 'done') throw new Error(`take ${t.id} is ${t.status}, not done`);
    source = { kind: t.kind === 'still' ? 'image' : 'video', take: t.id, name: `take ${t.id}` };
  } else {
    const image = /\.(png|jpe?g|webp)$/i.test(ref);
    const up = await resolveInput(ref, image ? 'image' : 'video');
    source = { kind: image ? 'image' : 'video', token: up.token, name: up.name };
  }
  const bg = a.background_image ? await resolveInput(a.background_image, 'image') : undefined;
  return queue(wire(cutoutBody({
    source, mode: a.mode, subject: a.subject, background: a.background, color: a.color, backgroundImage: bg?.token, audio: a.audio,
  })), { kind: source.kind });
}));

server.registerTool('restyle_video', {
  title: 'Restyle',
  description: 'Mirror > Restyle: keep a clip\'s motion and camera, change its whole look. Frame 0 is redrawn in the style with Qwen-Image-Edit, then LTX-2.5 + IC-LoRA (depth or edges of the source) carries the motion through it. Give a style id (list_presets section=restyle) and/or your own words for the look. Uses the first 12 s.',
  inputSchema: {
    source: inputRef('Source clip (2-12 s video)'),
    style: z.enum(RESTYLE_STYLES.map((r) => r.id) as [string, ...string[]]).optional().describe(RESTYLE_STYLES.map((r) => r.id).join(', ')),
    look: z.string().default('').describe('Your own words for the look, alone or added to the style'),
    keep: z.enum(['scene', 'outlines']).default('scene').describe('scene = depth (shape of the space and the camera move), outlines = edges'),
    strength: z.number().min(0.4).max(1).default(0.9).describe('Hold to the clip'),
    audio: z.boolean().default(false),
    resolution: tierArg('restyle'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  if (!a.style && !a.look.trim()) throw new Error('Pass a style, a look, or both');
  const src = await resolveInput(a.source, 'video');
  return queue(wire(restyleBody({
    sourceVideo: src.token, clip: src.clip!, style: a.style ?? null, text: a.look, control: a.keep === 'outlines' ? 'edges' : 'depth',
    strength: a.strength, audio: a.audio, count: a.count, res: await tierFor('restyle', a.resolution),
  })), { clip: src.clip });
}));

server.registerTool('swap_object', {
  title: 'Object swap (experimental)',
  description: `Mirror > Object swap, EXPERIMENTAL: replace one object in a clip. SAM 3.1 tracks it (from words, or a click point on frame 0), Qwen-Image-Edit replaces it in frame 0, and the LTX in/outpainting IC-LoRA redraws only the masked region through the clip; outside the mask the source is kept as filmed. Uses the first ${SWAP_MAX_SECONDS} s. Results vary: check the take before using it.`,
  inputSchema: {
    source: inputRef('Source clip'),
    target: z.string().min(1).describe('What to replace, as you would point at it: "the red car"'),
    replacement: z.string().default('').describe('What it becomes: "a white horse at full gallop"'),
    reference: inputRef('Optional picture of what it becomes').optional(),
    point: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional().describe('Optional click on frame 0, 0-1 of width and height'),
    resolution: tierArg('swap'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const src = await resolveInput(a.source, 'video');
  const ref = a.reference ? await resolveInput(a.reference, 'image') : undefined;
  return queue(wire(swapBody({
    sourceVideo: src.token, clip: src.clip!, target: a.target, point: a.point, replacement: a.replacement, reference: ref?.token, count: a.count, res: await tierFor('swap', a.resolution),
  })), { clip: src.clip });
}));

server.registerTool('reshoot', {
  title: 'Reshoot',
  description: 'Reshoot app: re-aim the camera on an existing clip (orbit, rise, push) after the fact. preview=true renders the quick depth-warp angle preview instead (magenta = what the original camera never saw). Uses the first 8 s of the clip.',
  inputSchema: {
    clip: inputRef('Clip to reshoot (2-8 s, clear subject, no black bars)'),
    azimuth: z.number().int().min(-45).max(45).default(30).describe('Orbit in degrees, + = right'),
    elevation: z.number().int().min(-20).max(30).default(10).describe('Height in degrees, + = from above'),
    pivot_depth: z.number().min(0.3).max(4).default(1.05).describe('Metres from camera to subject; the orbit pivots there. Selfie 0.5, mid shot 1, wide room 3'),
    move: z.boolean().default(false).describe('Move from the original angle to the new one during the shot'),
    prompt: z.string().default('').describe('Optional: what is beyond the frame'),
    audio: z.boolean().default(true).describe('Keep sound'),
    preview: z.boolean().default(false),
    resolution: tierArg('reshoot'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const src = await resolveInput(a.clip, 'video');
  return queue(wire(reshootBody({
    sourceVideo: src.token, clip: src.clip!, azimuth: a.azimuth, elevation: a.elevation, pivotDepth: a.pivot_depth,
    move: a.move, prompt: a.prompt, audio: a.audio, count: a.count, preview: a.preview, res: await tierFor('reshoot', a.resolution),
  })), { clip: src.clip });
}));

const editModeIds = EDIT_APPS.map((a) => a.id) as [EditMode, ...EditMode[]];

server.registerTool('edit_image', {
  title: 'Edit image',
  description: [
    'Edit app on Qwen-Image-Edit 2509: change a still with an instruction, or run one of the image apps that turn one still into a set.',
    'free: instruction edit (count 1-4 takes), up to 2 extra images (refer to them as image 2 / image 3), optional mask (white = may change, black = kept exactly).',
    'angle: new camera angles, one take per option (orbit, side on, behind, high, low, overhead, step back).',
    'coverage: up to 9 shots of the moment (establishing to extreme close, over the shoulder, low, high).',
    'pushin: a series of tighter framings toward the subject. next: 4 story continuations.',
    'relight: one take per light mood, with an optional direction. expand: outpaint to a new aspect and/or pull back.',
    'Options per mode: list_presets section=edit. Results are ordinary still takes (usable as take:<id> anywhere).',
  ].join(' '),
  inputSchema: {
    image: inputRef('The image to edit'),
    mode: z.enum(editModeIds).default('free'),
    instruction: z.string().default('').describe('free: what to change (required). Other modes: optional steer added to every result. @Name adds a cast member\'s pictures as the extra images (free slots only).'),
    options: z.array(z.string()).optional().describe('Option ids for angle / coverage / pushin / next / relight (default: the app defaults). See list_presets section=edit'),
    direction: z.enum(RELIGHT_DIRECTIONS.map((d) => d.id) as [string, ...string[]]).default('auto').describe('relight: where the key light comes from'),
    aspect: z.enum(EXPAND_ASPECTS.map((a) => a.id) as [string, ...string[]]).default('16:9').describe('expand: the new shape; same = keep the shape and only pull back'),
    pull_back: z.number().min(0).max(0.5).default(0.2).describe('expand: extra room on every side, 0 = fill the new shape edge to edge'),
    extra_images: z.array(inputRef('Extra image')).max(2).optional().describe('free only: images 2 and 3'),
    mask: inputRef('Mask image, white = may change').optional().describe('free only'),
    quality: z.enum(['draft', 'quality']).default('draft').describe('draft = Lightning 8 steps (~9 s each on a 5090), quality = 20 steps (~40 s)'),
    count: z.number().int().min(1).max(4).default(1).describe('free and expand: takes, each the next seed'),
  },
  annotations: GPU,
}, safe(async (a) => {
  if (a.mode !== 'free' && (a.extra_images?.length || a.mask)) throw new Error('extra_images and mask are for mode=free');
  const app = EDIT_APPS.find((x) => x.id === a.mode)!;
  const options = a.options ?? app.defaults;
  const bad = options.filter((id) => !app.chips.some((c) => c.id === id));
  if (bad.length && app.chips.length) throw new Error(`Unknown ${a.mode} option(s) ${bad.join(', ')}. Options: ${app.chips.map((c) => c.id).join(', ')}`);
  if (a.mode === 'free' && !a.instruction.trim()) throw new Error('mode=free needs an instruction');
  const img = await resolveInput(a.image, 'image');
  const refs = await Promise.all((a.extra_images ?? []).map((r) => resolveInput(r, 'image')));
  const mask = a.mask ? await resolveInput(a.mask, 'image') : undefined;
  const take = /^take:(\d+)$/i.exec(a.image.trim());
  const body = editBody({
    mode: a.mode, source: { token: img.token, take: take ? Number(take[1]) : undefined }, refs: refs.map((r) => r.token), mask: mask?.token,
    text: a.instruction, chips: options, direction: a.direction, expandTo: a.aspect, zoom: 1 - a.pull_back, quality: a.quality, count: a.count,
  });
  return queue(wire(body), { mode: a.mode, results: (body.variants as unknown[]).length });
}));

/** An uploaded input as the continue pages hold it. */
function sourceRef(a: Asset, kind: SourceRef['kind']): SourceRef {
  const dims = a.dims ?? (a.clip ? { w: a.clip.w, h: a.clip.h } : { w: 0, h: 0 });
  return { token: a.token, kind, name: a.name, w: dims.w, h: dims.h, seconds: a.clip?.seconds ?? 0, takeId: a.takeId, prompt: a.prompt };
}
/** A take or file that may be a still or a clip (Transition ends). */
async function stillOrClip(ref: string): Promise<SourceRef> {
  const m = /^take:(\d+)$/i.exec(ref.trim());
  const still = m ? (await getTake(Number(m[1]))).kind === 'still' : /\.(png|jpe?g|webp)$/i.test(ref.trim());
  return still ? sourceRef(await resolveInput(ref, 'image'), 'image') : sourceRef(await resolveInput(ref, 'video'), 'video');
}

server.registerTool('extend_video', {
  title: 'Extend',
  description: 'Extend app (LTX-2.5): continue a clip forward by N seconds, or add a lead-in before its first frame (direction=backward). The last second of the clip stays frozen in context so motion, look and sound carry on; the result is ONE joined clip (original + new). Backward is written in reverse time: good for camera moves, weather and drift, wrong for a person walking. Uses the first 20 s of the clip, at the render size in the clip\'s shape.',
  inputSchema: {
    clip: inputRef('Clip to extend'),
    direction: z.enum(['forward', 'backward']).default('forward'),
    seconds: z.union([z.literal(2), z.literal(3), z.literal(5), z.literal(8)]).default(3).describe('New footage to add'),
    prompt: z.string().default('').describe('What happens next. Empty = the take\'s own prompt, or "the shot continues".'),
    audio: z.boolean().default(true).describe('Keep the clip\'s sound and continue it (forward). Ignored when the clip is silent.'),
    resolution: tierArg('extend'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const src = sourceRef(await resolveInput(a.clip, 'video'), 'video');
  return queue(wire(extendBody({ source: src, direction: a.direction, prompt: a.prompt, seconds: a.seconds, audio: a.audio, count: a.count, res: await tierFor('extend', a.resolution) })), { clip: { seconds: src.seconds, w: src.w, h: src.h } });
}));

server.registerTool('make_transition', {
  title: 'Transition',
  description: 'Transitions app (LTX-2.5): bridge two takes or two stills with a generated move from the last frame of `from` to the first frame of `to` (first + last frame), then join from + bridge + to into one clip. Styles: ' + TRANSITION_STYLES.map((t) => t.id).join(', ') + ' (list_presets section=transition for the prompts).',
  inputSchema: {
    from: inputRef('First take: a clip or a still'),
    to: inputRef('Second take: a clip or a still'),
    style: z.enum(TRANSITION_STYLES.map((t) => t.id) as [string, ...string[]]).default('morph'),
    prompt: z.string().default('').describe('Optional extra direction appended to the style'),
    seconds: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2).describe('Bridge length'),
    audio: z.boolean().default(true).describe('Keep each side\'s sound, generated sound under the bridge'),
    resolution: tierArg('transition'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const from = await stillOrClip(a.from);
  const to = await stillOrClip(a.to);
  return queue(wire(transitionBody({ from, to, style: a.style, prompt: a.prompt, seconds: a.seconds, audio: a.audio, count: a.count, res: await tierFor('transition', a.resolution) })));
}));

server.registerTool('speak', {
  title: 'Speak (audio to video)',
  description: 'Speak app (LTX-2.5 audio to video): a face still plus a sound file (speech, singing, music) becomes a talking shot. The audio is encoded and frozen, only the picture is generated, so lips and motion follow it, and the original waveform is muxed in. Up to 10 s of the sound is used. Best with a head-and-shoulders still facing the camera; pass the spoken words for better mouth shapes.',
  inputSchema: {
    face: inputRef('Face still (head and shoulders, facing the camera)').optional().describe('Face still. Optional when prompt @mentions a cast member: a portrait of them is composed first.'),
    audio: inputRef('Sound file (.wav/.mp3/.m4a/.flac) or a clip with a sound track'),
    words: z.string().default('').describe('What is said in the recording (optional, helps the mouth shapes)'),
    prompt: z.string().default('').describe('Optional direction: who, where, mood. @Name brings in a cast member.'),
    resolution: tierArg('speak'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const face = a.face ? sourceRef(await resolveInput(a.face, 'image'), 'image') : undefined;
  const voice = sourceRef(await resolveInput(a.audio, 'audio'), 'audio');
  return queue(wire(speakBody({ face, voice, words: a.words, prompt: a.prompt, res: await tierFor('speak', a.resolution), count: a.count })));
}));

server.registerTool('add_sound', {
  title: 'Add sound (video to audio)',
  description: 'Add sound app (LTX-2.5 video to audio): generate a soundtrack for a clip. The frames are encoded and frozen, only audio is generated, and the output keeps the clip\'s own frames. Any existing sound is replaced. Uses the first 20 s.',
  inputSchema: {
    clip: inputRef('Clip to sound'),
    prompt: z.string().default('').describe('What it should sound like. Empty = natural sound matching the scene, no music.'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const clip = sourceRef(await resolveInput(a.clip, 'video'), 'video');
  return queue(wire(soundBody({ clip, prompt: a.prompt, count: a.count })), { clip: { seconds: clip.seconds, w: clip.w, h: clip.h } });
}));

const effectIds = EFFECTS.map((e) => e.id) as [string, ...string[]];

server.registerTool('apply_effect', {
  title: 'Effects',
  description: 'Effects app: a one-click LTX-2.5 LoRA effect. Clip effects (cutout = alpha matte, flood = add water, nightfall = day to night, empty = remove people and cars) re-render a source clip frame-locked; still effects (living-photo cinemagraph, pop, inflate, cake, squish, unzip, gulp) animate one image. See list_presets section=effects for what each one asks for in `text`.',
  inputSchema: {
    effect: z.enum(effectIds).describe(EFFECTS.map((e) => `${e.id} (${e.input}): ${e.name}`).join('; ')),
    input: inputRef('The clip (clip effects) or still (still effects)'),
    text: z.string().default('').describe('What the effect asks for (e.g. flood: the water; pop: who pops). Empty = the effect default. cutout takes no text.'),
    resolution: tierArg('effects'),
    quality: z.enum(EFFECT_QUALITY.map((q) => q.id) as ['draft', 'high']).optional().describe(`Older name for resolution: ${EFFECT_QUALITY.map((q) => `${q.id} = ${q.tier}`).join(', ')}. resolution wins when both are set.`),
    seconds: z.union([z.literal(3), z.literal(5), z.literal(8)]).default(5).describe('Still effects only (capped per effect); clip effects use the clip length up to the effect maximum'),
    loop: z.boolean().default(true).describe('living-photo only: first frame = last frame'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const fx = EFFECTS.find((e) => e.id === a.effect)!;
  const src = await resolveInput(a.input, fx.input === 'clip' ? 'video' : 'image');
  const input = fx.input === 'clip'
    ? { token: src.token, w: src.clip!.w, h: src.clip!.h, seconds: src.clip!.seconds }
    : { token: src.token, w: src.dims?.w ?? 0, h: src.dims?.h ?? 0, seconds: 0 };
  const asked = a.resolution ?? EFFECT_QUALITY.find((q) => q.id === a.quality)?.tier;
  return queue(wire(effectBody({ effect: a.effect, input, text: a.text, res: await tierFor('effects', asked), seconds: a.seconds, loop: a.loop, count: a.count })),
    { effect: fx.id, prompt_used: effectPrompt(fx, a.text) });
}));

server.registerTool('upscale', {
  title: 'Upscale',
  description: [
    'Upscale app: more resolution for a finished take or a local file (video or still). Returns the new take id.',
    UPSCALE_MODES.map((m) => `mode ${m.id}: ${m.note}${m.image ? '' : ' Video only.'}`).join(' '),
    `Redraw and Dream use at most the first ${DREAM_MAX_SECONDS} s of a clip. Measured on a 5090 (warm): sharpen ~45 s for a 3 s 832x448 clip and ~2.5 min for 5 s of 1280x704; redraw 3B ~100 s and 7B ~130 s for 3 s at 1080p, ~2 min for 5 s; dream ~30 s for 3 s and ~70 s for 5 s. Sharpen holds the clip at 4x in RAM, so long or large clips are trimmed (about 5.7 s of 1280x704). Dream re-imagines the clip; redraw gives the most real detail.`,
  ].join(' '),
  inputSchema: {
    source: inputRef('What to upscale (video or still)').optional(),
    take_id: z.number().int().optional().describe('Same as source take:<id>; kept for older callers'),
    mode: z.enum(['sharpen', 'redraw', 'dream']).default('sharpen'),
    model: z.enum(['esrgan', 'ultrasharp', '3b', '7b']).optional()
      .describe('sharpen: esrgan (default, BSD-3, fine for paid work) or ultrasharp (4x-UltraSharp, NON-COMMERCIAL license). redraw: 3b (default, fast) or 7b (more detail, slower).'),
    rife: z.boolean().default(false).describe('sharpen, video only: double the frame rate with RIFE'),
    height: z.union([z.literal(1080), z.literal(1440)]).default(1080).describe('redraw: target short edge'),
    color: z.enum(['lab', 'wavelet', 'none']).default('lab').describe('redraw: color match to the source (lab = most faithful)'),
    creativity: z.number().min(DREAM_CREATIVITY.min).max(DREAM_CREATIVITY.max).default(DREAM_CREATIVITY.default)
      .describe(`dream: how far the refine may drift from the source, ${DREAM_CREATIVITY.min} faithful to ${DREAM_CREATIVITY.max} reimagined`),
    prompt: z.string().default('').describe('dream: what to add or reimagine, e.g. "frost on the glass, embroidered fabric"'),
  },
  annotations: GPU,
}, safe(async (a) => {
  const ref = a.source ?? (a.take_id !== undefined ? `take:${a.take_id}` : undefined);
  if (!ref) throw new Error('Pass source (a file path or take:<id>) or take_id');
  if (a.model && (a.mode === 'dream' || (a.mode === 'sharpen') !== ['esrgan', 'ultrasharp'].includes(a.model))) {
    throw new Error(`model ${a.model} does not apply to mode ${a.mode}`);
  }
  // A take goes by id, like the page's library pick; a file is uploaded first.
  const m = /^take:(\d+)$/i.exec(ref.trim());
  let source: { kind: 'video' | 'image'; take?: number; token?: string; name: string };
  let dims: { w: number; h: number } | undefined;
  if (m) {
    const t = await getTake(Number(m[1]));
    if (t.status !== 'done') throw new Error(`take ${t.id} is ${t.status}, not done`);
    const s = settingsOf(t);
    source = { kind: t.kind === 'still' ? 'image' : 'video', take: t.id, name: s.shotName || t.shot_name };
    if (s.width && s.height) dims = { w: s.width, h: s.height };
  } else {
    const image = /\.(png|jpe?g|webp)$/i.test(ref.trim());
    const up = await resolveInput(ref, image ? 'image' : 'video');
    source = { kind: image ? 'image' : 'video', token: up.token, name: localPath(ref).split('/').pop()!.replace(/\.[^.]+$/, '') };
    dims = up.dims ?? (up.clip?.w ? { w: up.clip.w, h: up.clip.h } : undefined);
  }
  const body = upscaleBody({
    mode: a.mode, source,
    sharpModel: a.model === 'ultrasharp' ? 'ultrasharp' : 'esrgan',
    rife: a.rife, redrawModel: a.model === '7b' ? '7b' : '3b',
    upHeight: REDRAW_HEIGHTS.includes(a.height) ? a.height : 1080, color: a.color, creativity: a.creativity, prompt: a.prompt,
  });
  const r = await api.generate(wire(body));
  const out = dims ? upscaleSize(a.mode, dims.w, dims.h, a.height) : undefined;
  return { content: [text({
    queued: true, take_ids: r.takeIds, mode: a.mode, upscale_of: source.take ?? source.name,
    ...(out ? { from: `${dims!.w}x${dims!.h}`, to: `${out.w}x${out.h}` } : {}),
    next: `wait_for_take with take_ids ${JSON.stringify(r.takeIds)}`,
  })] };
}));

// ---------- image to 3D ----------

server.registerTool('make_3d', {
  title: 'Make 3D',
  description: [
    'Object app (TRELLIS.2, local): one still becomes a textured 3D model, saved as a GLB take (PBR base color, metallic, roughness; high also bakes a normal map and AO).',
    'BiRefNet cuts the subject out first unless remove_background is false (then the PNG\'s own transparency is used). Works best on one subject, whole in frame, on a plain background.',
    OBJECT_DETAIL.map((d) => `quality ${d.id === 'quality' ? 'high' : d.id}: ${d.note}`).join(' '),
    'The take\'s output_path is the .glb; get_take also returns glb_url (served as model/gltf-binary), a turntable mp4 and the isolated subject. The preview image is the first turntable frame.',
  ].join(' '),
  inputSchema: {
    image: inputRef('The still to turn into a model (png, jpg or webp)'),
    quality: z.enum(['draft', 'high']).default('draft').describe('draft to check the shape, high for the keeper'),
    remove_background: z.boolean().default(true).describe('Cut the subject out with BiRefNet first'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const src = sourceRef(await resolveInput(a.image, 'image'), 'image');
  return queue(wire(objectBody({ source: src, quality: a.quality === 'high' ? 'quality' : 'draft', cutout: a.remove_background, count: a.count })), { quality: a.quality });
}));

// ---------- cast ----------

server.registerTool('list_cast', {
  title: 'List cast',
  description: 'The cast: characters, props and places saved once and @mentioned by name in any prompt. Returns each member with its kind, description and reference pictures (local file paths).',
  inputSchema: {},
  annotations: RO,
}, safe(async () => {
  const cast = await api.cast();
  return {
    content: [text(cast.length ? cast.map((m) => ({
      id: m.id, mention: `@${m.name}`, kind: m.kind, description: m.notes, pictures: m.refs.map((r) => ({ path: r.file, width: r.w, height: r.h })),
    })) : 'The cast is empty. create_cast adds a member from 1 to 6 pictures.')],
  };
}));

server.registerTool('create_cast', {
  title: 'Create cast member',
  description: 'Save a character, prop or place from 1 to 6 pictures so any prompt can @mention it. For a character, the best set is a face close-up, a three-quarter view and a full-body shot of the same person (make them with generate_image + edit_image, then pass take:<id>). The description goes into every prompt that mentions it. If the name exists, the pictures are added to that member instead.',
  inputSchema: {
    name: z.string().min(1).max(40).describe('How prompts mention it, e.g. "Mara" -> @Mara. Letters, numbers and spaces.'),
    kind: z.enum(['character', 'prop', 'place']).default('character'),
    description: z.string().default('').describe('What it looks like, in words: face, hair, clothes; or shape and color; or the place.'),
    images: z.array(inputRef('Picture')).min(1).max(6),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, safe(async (a) => {
  const refs = [];
  for (const img of a.images) refs.push({ token: (await resolveInput(img, 'image')).token });
  const existing = (await api.cast()).find((m) => m.name.toLowerCase() === a.name.trim().replace(/^@+/, '').toLowerCase());
  const m = existing
    ? await api.updateCast(existing.id, { addRefs: refs, ...(a.description ? { notes: a.description } : {}) })
    : await api.createCast({ name: a.name, kind: a.kind, notes: a.description, refs });
  return { content: [text({ id: m.id, mention: `@${m.name}`, kind: m.kind, pictures: m.refs.length, added_to_existing: !!existing })] };
}));

server.registerTool('fix_seam', {
  title: 'Improve the seam',
  description: [
    'Seam Doctor for a finished video take, usually a loop. Measures the loop point: the wrap (last frame to first) against an ordinary frame step,',
    'on fine texture and on composition; seamless means both are within the clip\'s own frame-to-frame motion (texture ratio 2.0 or less, composition 1.5 or less).',
    'strategy auto tries, in order: trim (keep the longest run of frames that closes; no GPU; only offered when one is predicted seamless),',
    'regen (rotate the loop so the wrap sits mid-clip, re-render it with LTX-2.5 at sigma 0.65 with the ends frozen, rotate back; same length, one decode),',
    'reseed (render the loop again with a new seed). Each later step runs only if the one before still measures as a visible seam.',
    'bridge (an LTX-2.5 first/last bridge between frames about 1 s either side of the wrap) is manual only: measured worse on average.',
    'No crossfades, ever. measure_only returns the measurement without queuing anything. Fixes arrive as new takes (wait_for_take); each carries its own seam measurement.',
    'Set expectations: measured on five loops, regen lowered the wrap ratio from 4.36 to 3.35 on average and fully closed one; report the before and after ratios plainly.',
    'Measured on a 5090: trim under 1 s, regen about 10 to 15 s, bridge about 20 to 25 s, reseed the loop\'s own render time.',
  ].join(' '),
  inputSchema: {
    take_id: z.number().int(),
    strategy: z.enum(['auto', 'trim', 'regen', 'bridge', 'reseed']).default('auto'),
    measure_only: z.boolean().default(false),
  },
  annotations: GPU,
}, safe(async (a) => {
  if (a.measure_only) return { content: [text({ take_id: a.take_id, seam: await api.seam(a.take_id) })] };
  const r = await api.fixSeam(a.take_id, fixSeamBody(a.strategy));
  return { content: [text({
    take_id: a.take_id, before: r.before, fix: r.fix,
    ...(r.fix ? { queued: true, take_ids: r.takeIds, next: `wait_for_take with take_ids ${JSON.stringify(r.takeIds)}; with strategy auto, a fix that still shows a seam queues the next one by itself` } : { queued: false, note: 'Already seamless.' }),
  })] };
}));

server.registerTool('finish_hdr', {
  title: 'Finish in HDR',
  description: 'Re-render a finished video take as HDR with the LTX-2.5 SDR-to-HDR IC-LoRA. Delivers a 16-bit half-float ACEScg EXR sequence (zipped), an HLG BT.2020 10-bit HEVC .mov and a ProRes 422 HQ HLG .mov, frame-locked to the source; the new take itself is a tonemapped SDR preview. Up to about 1280x720 and 10 s; finish before upscaling. Needs the hdr bundle and a local engine. get_take shows the file paths, download URLs and the format check once the files are collected (a few seconds after the take finishes). Measured on a 5090: about 2 to 4 min for 3 to 5 s at 832x448, warm.',
  inputSchema: { take_id: z.number().int() },
  annotations: GPU,
}, safe(async (a) => {
  const t = await getTake(a.take_id);
  if (t.status !== 'done') throw new Error(`take ${t.id} is ${t.status}, not done`);
  const r = await api.generate(hdrBody(a.take_id));
  return { content: [text({ queued: true, take_ids: r.takeIds, hdr_of: a.take_id, next: `wait_for_take with take_ids ${JSON.stringify(r.takeIds)}, then get_take for the EXR and HLG paths` })] };
}));

// ---------- Stage ----------

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const stageMoveIds = CAMERA_MOVES.map((m) => m.id) as [string, ...string[]];

server.registerTool('stage_render', {
  title: 'Stage',
  description: [
    'Stage app: block a shot in 3D and render it as a finished shot with LTX-2.5 Layout to Render (IC-LoRA).',
    'The server draws the blocking (grey clay plus an exact depth pass) from the scene JSON; the shot then follows that camera move and where every prop stands,',
    'and takes its palette, light and materials from a look frame. Without look_frame, a look frame is made first from the depth pass (Z-Image Turbo, or Qwen-Image-Edit on the clay with look_engine clay_edit) and shows up as its own still take.',
    'Figures hold their marks for the whole shot: describe people standing, turning or gesturing there; a prompt that walks them away leaves a figure-shaped mass on the mark.',
    'Units are metres, Y is up, the ground is y = 0, a prop stands on its footprint centre pos. The camera looks from keys[i].pos at keys[i].target; keys are spread evenly over the shot (2 = start and end), or give every key `at` (seconds: 0 for the first, the shot length for the last, rising) to time them.',
    'Or give keys[0] only plus move (push-in, pull-back, orbit-left, orbit-right, crane-up, dolly-left, dolly-right, static) to build the path from it.',
    'A figure is a 1.8 m mannequin by default; a prop with `to` walks or slides there during the shot (or between the seconds in `moves_between`).',
    'type model places a 3D take (from make_3d) by model_take_id, fitted inside its size (default 1.2 m cube); the blocking draws it as that box.',
    `Size follows the render tier (resolution; default the machine-wide size from Setup, capped at 720p): 480p is ${stageSize('16:9', '480p').w}x${stageSize('16:9', '480p').h} (16:9), 720p ${stageSize('16:9', '720p').w}x${stageSize('16:9', '720p').h}. Measured on a 5090: 480p 2 s (49 frames) about 2 to 4 min; 720p has 2.6x the pixels and runs about three to four times as long. Use 480p while iterating.`,
    'Prompt: describe the finished first frame (who, where, light, materials). @Name brings in a cast member by words; with clay_edit their pictures go into the look frame too.',
  ].join(' '),
  inputSchema: {
    prompt: z.string().min(1).describe('What the finished shot looks like, e.g. "A woman in a long coat in a rain-soaked night alley between a wooden crate and a concrete pillar, neon on wet stone."'),
    props: z.array(z.object({
      type: z.enum(['box', 'cylinder', 'figure', 'wall', 'sphere', 'model']),
      model_take_id: z.number().int().positive().optional().describe('For type model: the take id of a finished make_3d (Object) take'),
      pos: vec3.describe('[x, base height, z] in metres; footprint centre'),
      size: vec3.optional().describe('[width, height, depth] in metres. Defaults: box 1.2x1x1.2, cylinder 0.8x2.4x0.8, figure 0.5x1.8x0.3, wall 8x3x0.25, sphere 1x1x1'),
      rot: z.number().min(-360).max(360).default(0).describe('Turn around the vertical axis, degrees'),
      to: vec3.optional().describe('Where the footprint centre ends up at the end of the shot (the prop moves there evenly)'),
      moves_between: z.tuple([z.number().min(0), z.number().min(0)]).optional().describe('With `to`: when the move runs, [start, end] in seconds. Default: the whole shot'),
      label: z.string().max(40).optional(),
    })).min(1).max(MAX_PROPS),
    keys: z.array(z.object({ pos: vec3, target: vec3, at: z.number().min(0).optional().describe('When the camera passes this key, seconds into the shot') })).min(1).max(MAX_KEYS).describe('Camera keys: position and aim point, optionally timed. One key needs a move.'),
    move: z.enum(stageMoveIds).optional().describe('Build the camera path from keys[0]'),
    lens: z.number().min(LENS_MIN).max(LENS_MAX).default(35).describe('Focal length in mm, full frame'),
    seconds: z.union(STAGE_SECONDS.map((v) => z.literal(v)) as any).default(2).describe(`Length: ${STAGE_SECONDS.map((v) => `${v}s = ${stageFrames(v)} frames`).join(', ')}`),
    aspect: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
    ease: z.boolean().default(true).describe('Ease the move in and out'),
    resolution: tierArg('stage'),
    quality: z.enum(['draft', 'final']).optional().describe('Older name for resolution: draft = 480p, final = 720p. resolution wins when both are set.'),
    look_frame: inputRef('Optional look frame: the first frame as it should look, matching the blocking').optional(),
    look_engine: z.enum(['depth_lock', 'clay_edit']).default('depth_lock'),
    count,
  },
  annotations: GPU,
}, safe(async (a) => {
  const seconds = Number(a.seconds);
  const props: StageProp[] = a.props.map((p, i) => {
    if (p.moves_between && !p.to) throw new Error(`props[${i}]: moves_between needs to (where the prop ends up)`);
    if (p.moves_between && !(p.moves_between[1] > p.moves_between[0] && p.moves_between[1] <= seconds)) throw new Error(`props[${i}]: moves_between is [start, end] seconds, rising, within the ${seconds}s shot`);
    const to = p.to ? { to: p.to as [number, number, number], ...(p.moves_between ? { span: [p.moves_between[0] / seconds, p.moves_between[1] / seconds] as [number, number] } : {}) } : {};
    if (p.type === 'model') {
      if (!p.model_take_id) throw new Error(`props[${i}]: type model needs model_take_id (a make_3d take)`);
      return { id: `p${i}`, type: 'glb', pos: p.pos as [number, number, number], size: (p.size ?? MODEL_PROP_SIZE) as [number, number, number], rot: p.rot, take: p.model_take_id, ...to, label: p.label ?? `model ${p.model_take_id}` };
    }
    return {
      id: `p${i}`, type: p.type, pos: p.pos as [number, number, number], size: (p.size ?? PROP_DEFAULTS[p.type].size) as [number, number, number],
      rot: p.rot, ...to, label: p.label ?? PROP_DEFAULTS[p.type].label,
    };
  });
  const timed = a.keys.some((k) => k.at !== undefined);
  if (a.move && timed) throw new Error('Give key times (at) or a move. A move spreads its own keys evenly.');
  let keys: CameraKey[] = a.keys.map((k) => ({ pos: k.pos as Vec3, target: k.target as Vec3, ...(timed ? { t: Number(k.at) / seconds } : {}) }));
  if (timed) {
    if (a.keys.some((k) => k.at === undefined)) throw new Error('Give every camera key an at time, or none.');
    if (a.keys[0].at !== 0 || Math.abs(Number(a.keys[a.keys.length - 1].at) - seconds) > 1e-6) throw new Error(`Key times run from 0 (the first key) to ${seconds} (the last key, the shot length).`);
  }
  if (a.move) keys = CAMERA_MOVES.find((m) => m.id === a.move)!.make(keys[0]).map((k) => ({ pos: k.pos, target: k.target }));
  if (keys.length < 2) throw new Error('Give a start and an end key, or one key and a move.');
  const scene = cleanStageScene({ v: 1, props, keys, lens: a.lens, seconds, aspect: a.aspect, ease: a.ease ? 'smooth' : 'linear', move: a.move ?? 'custom' });
  const look = a.look_frame ? await resolveInput(a.look_frame, 'image') : undefined;
  const body = wire(stageBody({
    scene, prompt: a.prompt, res: await tierFor('stage', a.resolution ?? stageTier(a.quality)), lookEngine: a.look_engine === 'clay_edit' ? 'edit' : 'depth',
    look: look ? { token: look.token, take: look.takeId } : undefined, count: a.count,
  }));
  return queue(body, {
    frames: body.frames, camera_keys: scene.keys.length,
    note: look ? 'Rendering with your look frame.' : 'A look frame is made first from the depth pass; it appears as its own still take, and the shot waits for it.',
  });
}));

server.registerTool('cancel', {
  title: 'Cancel',
  description: 'Cancel one queued or rendering take, or with all=true clear the whole queue including the live render.',
  inputSchema: {
    take_id: z.number().int().optional(),
    all: z.boolean().default(false),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, safe(async ({ take_id, all }) => {
  if (all) { await api.clearQueue(); return { content: [text({ ok: true, cleared: 'queue' })] }; }
  if (take_id === undefined) throw new Error('Pass take_id, or all=true');
  await api.cancelTake(take_id);
  return { content: [text({ ok: true, cancelled: take_id })] };
}));

await server.connect(new StdioServerTransport());
console.error(`openfield-mcp: stdio ready, API ${BASE}`);
