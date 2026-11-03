/**
 * /api/generate request bodies, built exactly the way each page builds them.
 * Pure functions: no I/O, so bodies.check.ts can pin them against the page
 * code. If a page's go() changes, change the matching builder here.
 *
 *   Video / Seamless loop  src/pages/Video.tsx     go()
 *   Image                  src/pages/Image.tsx     go()
 *   Director (+ scene)     src/pages/Director.tsx  go() / shootAll()
 *   Mirror                 src/pages/Mirror.tsx    go()
 *   Reshoot (+ preview)    src/pages/Reshoot.tsx   body() / go() / runPreview()
 *   Effects                src/pages/Effects.tsx   go()
 *   Upscale                src/pages/Upscale.tsx   go()
 *   Extend / Transition    src/pages/Extend.tsx    extendBody() / transitionBody()
 *   Speak / Add sound      src/pages/Speak.tsx     speakBody() / soundBody()
 *   Edit + image apps      src/pages/Edit.tsx      go()
 *   Stage                  src/pages/Stage.tsx     go()
 *   Finish in HDR          src/Viewer.tsx          finishHdr()
 *   Improve the seam       src/Viewer.tsx          fixSeam() (POST /api/takes/:id/fix-seam)
 *   Remove background      src/pages/Cutout.tsx    cutoutBody()
 *   Restyle / Object swap  src/pages/MirrorEdit.tsx restyleBody() / swapBody()
 */
import {
  ASPECTS, CONTINUE_PROMPT, DIRECTOR_AXES, DIRECTOR_MOVES, ERA_MAX, ERA_MIN, EXPAND_ASPECTS, IMAGE_RES, MIRROR_CONTROLS, SCENE_FRAMINGS, SCENE_MAX_SHOTS,
  SHARPEN_MODELS, SOUND_PROMPT, SPEAK_PROMPT, SPEED_RAMPS, TRANSITION_STYLES, UPSCALE_MODES, VIDEO_MODELS, clampEra, directorDirection, isRamp, pickGenre,
  type RampId,
  SWAP_MAX_SECONDS, mirrorSize, restyleById, restyleInstruction, restyleLook, restylePrompt, swapPrompt, type CutoutBackground, type CutoutMode,
  compilePrompt, editAppById, editVariants, presetById, sizeFor, videoFrame, type AspectId, type EditMode, type RedrawColor, type RedrawModel, type SharpenModel, type UpscaleMode,
} from '../src/catalog.ts';
import { secondsToFrames } from '../src/presets.ts';
import { EFFECTS, effectById, effectPrompt, effectSize } from '../src/effects.ts';
import { appTier, tierSizeOf, type RenderTier } from '../src/renderTier.ts';
import { describeScene, lookSize, stageFrames, stageSize, type StageScene } from '../src/stage.ts';

export type Body = Record<string, unknown>;
export interface Dims { w: number; h: number }

export const ASPECT_IDS = ASPECTS.map((a) => a.id) as [AspectId, ...AspectId[]];
export type VideoRes = RenderTier;
export type ImageRes = (typeof IMAGE_RES)[number]['id'];

/** Video.tsx `size` memo: aspect 'auto' follows the start frame, else 16:9. */
export function videoSize(aspect: 'auto' | AspectId, res: VideoRes, start?: Dims): Dims {
  return videoFrame(aspect, res, start);
}

export interface VideoOpts {
  model: 'ltx25' | 'h3';
  prompt: string;
  preset: string;
  size: Dims;
  seconds: number;
  count: number;
  audio: boolean;
  startImage?: string;
  endImage?: string;
  loop?: boolean;
  /** Cast in the shot (an @mention, no frames): 'sheet' (default) or a composed hero 'frame'. */
  castMode?: 'sheet' | 'frame';
  /** Loop tab "Auto-fix the seam" (off by default): try to improve a visible seam on each loop. */
  autoFix?: boolean;
  /** Your own LTX LoRAs (LTX-2.5 only), as the LoRA chip sends them. */
  loras?: LoraPick[];
  /** H3 turbo preset id (src/presets.ts H3_TURBO), as the Turbo chip sends it. */
  turbo?: string;
}

/** One of your own LoRAs on a take: an engine LoRA filename (list_loras) and its strength. */
export interface LoraPick { name: string; strength: number }

/** Video.tsx go(). In loop mode the start token is also the end token. */
export function videoBody(o: VideoOpts): Body {
  const model = VIDEO_MODELS.find((m) => m.id === o.model) ?? VIDEO_MODELS[0];
  const preset = presetById(o.preset || 'free');
  const end = o.loop ? o.startImage : o.endImage;
  const needsStart = model.id === 'h3' || !!o.loop;
  if (needsStart && !o.startImage) throw new Error(o.loop ? 'A loop needs one image.' : `${model.label} needs a start frame.`);
  if (!o.prompt.trim() && preset.id === 'free' && !o.startImage) throw new Error('Give a prompt, a non-free preset, or a start image.');
  if (end && !model.end) throw new Error(`${model.label} does not take an end frame.`);
  const compiled = compilePrompt([o.prompt, preset.text]);
  const body: Body = {
    kind: 'video', videoModel: model.id, prompt: compiled, userPrompt: o.prompt, preset: preset.id, presetName: preset.name,
    width: o.size.w, height: o.size.h, seconds: o.seconds, count: o.count, withAudio: o.audio,
    startImage: o.startImage, endImage: end, shotName: (o.prompt || preset.name).slice(0, 40),
  };
  if (model.id === 'h3') body.lengthFrames = secondsToFrames(o.seconds);
  if (o.turbo) {
    if (model.id !== 'h3') throw new Error('Turbo presets are for MiniMax H3.');
    body.h3Turbo = o.turbo;
  }
  // The page only sends it while @mentions with pictures are in play; the server ignores it otherwise.
  if (o.castMode === 'frame') body.castMode = 'frame';
  if (o.loop && o.autoFix) body.seamFix = 'auto';
  if (o.loras?.length) {
    if (model.id !== 'ltx25') throw new Error('Your own LoRAs run on LTX-2.5.');
    body.loras = o.loras;
  }
  return body;
}

export interface ImageOpts {
  model: 'qwen' | 'flux2';
  prompt: string;
  aspect: AspectId;
  quality: 'draft' | 'quality';
  res: ImageRes;
  count: number;
  loras?: LoraPick[];
  /** FLUX.2 only: reference picture tokens (the Refs chip). */
  refImages?: string[];
}

/** Image.tsx go(). */
export function imageBody(o: ImageOpts): Body {
  if (!o.prompt.trim()) throw new Error('Image needs a prompt.');
  if (o.refImages?.length && o.model !== 'flux2') throw new Error('Reference pictures need model flux2.');
  if ((o.refImages?.length ?? 0) > 6) throw new Error('Up to 6 reference pictures.');
  const size = sizeFor(o.aspect, IMAGE_RES.find((r) => r.id === o.res)!.mp);
  return {
    kind: 'still', model: o.model, quality: o.quality, prompt: o.prompt, userPrompt: o.prompt, width: size.w, height: size.h, count: o.count,
    shotName: o.prompt.slice(0, 40),
    ...(o.loras?.length ? { loras: o.loras } : {}),
    ...(o.refImages?.length ? { refImages: o.refImages } : {}),
  };
}

export type DirectorPicks = Record<string, string>;

export interface DirectorOpts {
  mode: 'frame' | 'shot';
  scene: string;
  picks: DirectorPicks;
  /** Era year 1960 to 2020, or null for none. */
  era?: number | null;
  /** Grade the output for the era (default on when an era is set). */
  grade?: boolean;
  /** Shot mode speed ramp. */
  ramp?: RampId;
  aspect: AspectId;
  count: number;
  imageModel: 'qwen' | 'flux2';
  move: string;
  seconds: number;
  audio: boolean;
  heroImage?: string;
  /** Shot mode render size (the page's size chip). */
  res: RenderTier;
}

function checkPicks(picks: DirectorPicks, skip: string[] = []) {
  for (const [axis, id] of Object.entries(picks)) {
    const a = DIRECTOR_AXES.find((x) => x.id === axis);
    if (!a || skip.includes(axis)) throw new Error(`Unknown director axis "${axis}". Axes: ${DIRECTOR_AXES.map((x) => x.id).filter((x) => !skip.includes(x)).join(', ')}`);
    if (!a.options.some((opt) => opt.id === id)) throw new Error(`Unknown ${axis} "${id}". Options: ${a.options.map((x) => x.id).join(', ')}`);
  }
}

/** A genre pick fills the axes it sets, unless the caller named them too (same as clicking it first in the page). */
export function withGenre(picks: DirectorPicks): DirectorPicks {
  return picks.genre ? { ...pickGenre({}, picks.genre), ...picks } : picks;
}

function checkEra(era: number | null | undefined): number | null {
  if (era == null) return null;
  if (!Number.isFinite(era) || era < ERA_MIN || era > ERA_MAX) throw new Error(`era is a year from ${ERA_MIN} to ${ERA_MAX}`);
  return clampEra(era);
}

/** Director.tsx: the compiled shot text, visible in the page as "Compiled shot". */
export function directorPrompt(mode: 'frame' | 'shot', scene: string, picks: DirectorPicks, move: string, era: number | null = null): string {
  const direction = directorDirection(picks, era);
  const moveText = mode === 'shot' ? presetById(move).text : '';
  return compilePrompt([moveText, scene, direction.join(', ')]);
}

/** Director.tsx go(). Frame mode = 'image' in the page, Shot mode = 'video'. */
export function directorBody(o: DirectorOpts): Body {
  checkPicks(o.picks);
  const era = checkEra(o.era);
  if (o.mode === 'shot' && !DIRECTOR_MOVES.some((p) => p.id === o.move)) {
    throw new Error(`Unknown camera move "${o.move}". Options: ${DIRECTOR_MOVES.map((p) => p.id).join(', ')}`);
  }
  if (o.ramp && !isRamp(o.ramp)) throw new Error(`Unknown speed ramp "${o.ramp}". Options: ${SPEED_RAMPS.map((r) => r.id).join(', ')}`);
  const compiled = directorPrompt(o.mode, o.scene, o.picks, o.move, era);
  if (!compiled) throw new Error('Write the scene or pick a direction.');
  const size = o.mode === 'frame' ? sizeFor(o.aspect, 1.0) : videoFrame(o.aspect, appTier('director', o.res));
  const { scene, picks, count } = o;
  const common = { app: 'director', scene, picks, era, eraGrade: o.grade ?? true, userPrompt: scene || compiled, prompt: compiled, width: size.w, height: size.h, count, shotName: (scene || 'director').slice(0, 40) };
  return o.mode === 'frame'
    ? { ...common, kind: 'still', model: o.imageModel, quality: 'quality' }
    : { ...common, kind: 'video', videoModel: 'ltx25', seconds: o.seconds, withAudio: o.audio, startImage: o.heroImage, preset: o.move, presetName: presetById(o.move).name, ramp: o.ramp ?? 'linear' };
}

export interface SceneShotIn { framing: string; move: string; action: string; seconds: number; ramp?: RampId; cast?: number[] }

export interface SceneOpts {
  scene: string;
  picks: DirectorPicks;
  era?: number | null;
  grade?: boolean;
  ramp?: RampId;
  audio: boolean;
  heroFrames: boolean;
  imageModel: 'qwen' | 'flux2';
  aspect: AspectId;
  /** Render size; scenes stop at 720p. */
  res: RenderTier;
  shots: SceneShotIn[];
}

/** Director.tsx shootAll(): the /api/director/scene body. Keys are left off; the page's are random. */
export function sceneBody(o: SceneOpts): Body {
  checkPicks(o.picks, ['framing']);
  const era = checkEra(o.era);
  if (o.shots.length < 1 || o.shots.length > SCENE_MAX_SHOTS) throw new Error(`A scene takes 1 to ${SCENE_MAX_SHOTS} shots`);
  o.shots.forEach((s, i) => {
    if (!SCENE_FRAMINGS.some((f) => f.id === s.framing)) throw new Error(`Shot ${i + 1}: unknown framing "${s.framing}". Options: ${SCENE_FRAMINGS.map((f) => f.id).join(', ')}`);
    if (!DIRECTOR_MOVES.some((m) => m.id === s.move)) throw new Error(`Shot ${i + 1}: unknown move "${s.move}". Options: ${DIRECTOR_MOVES.map((m) => m.id).join(', ')}`);
    if (!s.action.trim()) throw new Error(`Shot ${i + 1} needs an action`);
    if (s.ramp && !isRamp(s.ramp)) throw new Error(`Shot ${i + 1}: unknown ramp "${s.ramp}"`);
  });
  const size = videoFrame(o.aspect, appTier('scene', o.res));
  const { scene, picks, audio, heroFrames, imageModel } = o;
  const grade = o.grade ?? true;
  const ramp = o.ramp ?? 'linear';
  const list = o.shots.map((s) => ({ ...s, key: undefined as string | undefined, cut: undefined as number | undefined, take: undefined as number | undefined }));
  return {
    scene, picks, era, eraGrade: grade, ramp, withAudio: audio, heroFrames, imageModel,
    width: size.w, height: size.h,
    shots: list.map((s) => ({ key: s.key, framing: s.framing, move: s.move, action: s.action, seconds: s.seconds, ramp: s.ramp, cast: s.cast, take: s.cut != null ? s.take : undefined })),
  };
}

/** Source-clip facts the pages read from the <video> element's metadata. */
export interface ClipMeta { seconds: number; w: number; h: number }

export type MirrorControl = (typeof MIRROR_CONTROLS)[number]['id'];
export const MIRROR_MODES = { body: 'pose', scene: 'depth', outlines: 'edges' } as const satisfies Record<string, MirrorControl>;

export interface MirrorOpts {
  control: MirrorControl;
  sourceVideo: string;
  clip: ClipMeta;
  firstFrame?: string;
  prompt: string;
  strength: number;
  audio: boolean;
  count: number;
  res: RenderTier;
}

/** Mirror.tsx: seconds and size derive from the clip; go() builds the body. */
export function mirrorBody(o: MirrorOpts): Body {
  if (!o.prompt.trim()) throw new Error('Mirror needs a prompt: who and where.');
  if (o.clip.seconds && o.clip.seconds < 1.5) throw new Error('Clip is too short. Use 2 to 12 seconds.');
  const seconds = Math.max(1, Math.min(12, Math.floor(o.clip.seconds)));
  const size = mirrorSize(o.clip.w, o.clip.h, o.res);
  const { control, prompt, count } = o;
  return {
    kind: 'mirror', app: 'mirror', videoModel: 'mirror', control, sourceVideo: o.sourceVideo, startImage: o.firstFrame ?? undefined,
    prompt, userPrompt: prompt, width: size.w, height: size.h, seconds, guideStrength: o.strength, withAudio: o.audio, count,
    shotName: (prompt || 'mirror').slice(0, 40),
  };
}

export interface ReshootOpts {
  sourceVideo: string;
  clip: ClipMeta;
  azimuth: number;
  elevation: number;
  pivotDepth: number;
  move: boolean;
  prompt: string;
  audio: boolean;
  count: number;
  preview: boolean;
  res: RenderTier;
}

/** Reshoot.tsx body(kind); go() adds count, runPreview() sends it without. */
export function reshootBody(o: ReshootOpts): Body {
  const seconds = Math.max(2, Math.min(8, Math.floor(o.clip.seconds)));
  const size = tierSizeOf(appTier('reshoot', o.res), o.clip.w, o.clip.h, 32);
  const kind = o.preview ? 'reshoot-preview' : 'reshoot';
  const az = o.azimuth, el = o.elevation, prompt = o.prompt;
  const body: Body = {
    kind, app: kind === 'reshoot' ? 'reshoot' : 'reshoot-warp', videoModel: 'reshoot', sourceVideo: o.sourceVideo,
    azimuth: az, elevation: el, pivotDepth: o.pivotDepth,
    keyframes: o.move ? [{ f: 1, az: 0, el: 0 }, { f: Math.round(seconds * 24), az, el }] : undefined,
    prompt: prompt || 'The same scene, seen from a new camera angle.', userPrompt: prompt || `${az}° / ${el}°`,
    width: size.w, height: size.h, seconds, withAudio: o.audio, shotName: `reshoot_${az}_${el}`,
  };
  return o.preview ? body : { ...body, count: o.count };
}

export interface EffectOpts {
  effect: string;
  /** The uploaded clip (clip effects) or still (still effects), with its shape. */
  input: { token: string; w: number; h: number; seconds: number };
  text: string;
  /** Render size (Effects stops at 720p). */
  res: RenderTier;
  /** Still effects only; clip effects take their length from the clip. */
  seconds: number;
  loop: boolean;
  count: number;
}

/** Effects.tsx: seconds and size derive from the input; go() builds the body. */
export function effectBody(o: EffectOpts): Body {
  const fx = effectById(o.effect);
  if (!fx) throw new Error(`Unknown effect "${o.effect}". Options: ${EFFECTS.map((e) => e.id).join(', ')}`);
  const input = o.input;
  const seconds = fx.input === 'clip'
    ? Math.max(1, Math.min(fx.maxSeconds, Math.floor(input?.seconds || fx.maxSeconds)))
    : Math.min(fx.maxSeconds, o.seconds);
  const size = effectSize(fx, input, o.res);
  const { text, count } = o;
  return {
    kind: 'effect', app: 'effects', effect: fx.id, videoModel: 'ltx25', prompt: effectPrompt(fx, text), userPrompt: text || fx.name, text,
    width: size.w, height: size.h, seconds, loop: fx.loopable ? o.loop : undefined, count,
    sourceVideo: fx.input === 'clip' ? input.token : undefined, startImage: fx.input === 'still' ? input.token : undefined,
    shotName: `${fx.name} ${text}`.trim().slice(0, 40),
  };
}

export interface UpscaleOpts {
  mode: UpscaleMode;
  /** A finished take (the page's library pick) or an uploaded file's token. */
  source: { kind: 'video' | 'image'; take?: number; token?: string; name: string };
  sharpModel: SharpenModel;
  rife: boolean;
  redrawModel: RedrawModel;
  upHeight: number;
  color: RedrawColor;
  creativity: number;
  prompt: string;
}

/** Upscale.tsx go(), with its `model` and `engine` derivations and modeLabel(). */
export function upscaleBody(o: UpscaleOpts): Body {
  const { mode, source, rife, upHeight, color, creativity, prompt } = o;
  if (mode === 'dream' && source.kind === 'image') throw new Error('Dream works on video. Use Sharpen or Redraw for a still.');
  const video = source.kind === 'video';
  const model = mode === 'sharpen' ? o.sharpModel : mode === 'redraw' ? o.redrawModel : undefined;
  const engine = mode === 'sharpen' ? SHARPEN_MODELS.find((m) => m.id === o.sharpModel)!.label : mode === 'redraw' ? 'SeedVR2' : 'LTX-2.5';
  const modeLabel = (m: string | undefined) => UPSCALE_MODES.find((x) => x.id === m)?.label ?? 'Sharpen';
  return {
    kind: 'upscale', app: 'upscale', mode, sourceTake: source.take, source: source.token, sourceKind: source.kind,
    model, rife: mode === 'sharpen' && video ? rife : undefined,
    upHeight: mode === 'redraw' ? upHeight : undefined, color: mode === 'redraw' ? color : undefined,
    creativity: mode === 'dream' ? creativity : undefined, prompt: mode === 'dream' ? prompt : undefined,
    userPrompt: mode === 'dream' && prompt.trim() ? prompt : `${modeLabel(mode)} · ${engine}`,
    shotName: source.take ? undefined : source.name.slice(0, 40),
  };
}

/** A source as the continue pages hold it (src/SourcePick.tsx Source). */
export interface SourceRef { token: string; kind: 'video' | 'image' | 'audio'; name: string; w: number; h: number; seconds: number; takeId?: number; prompt?: string }

export interface ExtendOpts { source: SourceRef; direction: 'forward' | 'backward'; prompt: string; seconds: number; audio: boolean; count: number; res: RenderTier }

/** Extend.tsx extendBody(). */
export function extendBody(o: ExtendOpts): Body {
  const s = o.source, direction = o.direction, prompt = o.prompt, seconds = o.seconds;
  if (s.kind !== 'video') throw new Error('Extend needs a video clip.');
  const size = transitionSize(s, null, appTier('extend', o.res));
  return {
    kind: 'extend', app: 'extend', videoModel: 'ltx25', direction, sourceVideo: s.token, parentTake: s.takeId,
    prompt: prompt.trim() || s.prompt || CONTINUE_PROMPT, userPrompt: prompt.trim() || `${direction === 'backward' ? 'Lead-in' : 'Extend'} +${seconds}s`,
    width: size.w, height: size.h, seconds, withAudio: o.audio, count: o.count, shotName: `extend_${s.name}`.slice(0, 40),
  };
}

/** Extend.tsx `size`: the render size at the shape of the clip (or the first still), 32-aligned. */
export function transitionSize(a: SourceRef | null, b: SourceRef | null, res: RenderTier): Dims {
  const v = [a, b].find((s) => s?.kind === 'video') ?? a ?? b;
  return tierSizeOf(res, v?.w, v?.h, 32);
}

export interface TransitionOpts { from: SourceRef; to: SourceRef; style: string; prompt: string; seconds: number; audio: boolean; count: number; res: RenderTier }

/** Extend.tsx transitionBody(). */
export function transitionBody(o: TransitionOpts): Body {
  const a = o.from, b = o.to, prompt = o.prompt;
  const style = TRANSITION_STYLES.find((s) => s.id === o.style);
  if (!style) throw new Error(`Unknown transition style "${o.style}". Options: ${TRANSITION_STYLES.map((s) => s.id).join(', ')}`);
  if (a.kind === 'audio' || b.kind === 'audio') throw new Error('A transition joins video clips or stills.');
  const size = transitionSize(a, b, appTier('transition', o.res));
  return {
    kind: 'transition', app: 'transition', videoModel: 'ltx25', style: style.id,
    startVideo: a.kind === 'video' ? a.token : undefined, startImage: a.kind === 'image' ? a.token : undefined,
    endVideo: b.kind === 'video' ? b.token : undefined, endImage: b.kind === 'image' ? b.token : undefined,
    prompt: compilePrompt([style.text, prompt]), userPrompt: prompt.trim() || style.label,
    width: size.w, height: size.h, seconds: o.seconds, withAudio: o.audio, count: o.count, shotName: `transition_${style.id}`,
  };
}


/** Speak.tsx `size`: the face's aspect at the chosen resolution, 64-aligned (two-stage render). */
export function speakSize(res: RenderTier, face: Dims | null): Dims {
  return tierSizeOf(appTier('speak', res), face?.w, face?.h, 64);
}

/** Speak.tsx `seconds`: the sound file's length, 1 to 10 s, or the clip's length up to 20 s for Add sound. */
export const speakSeconds = (voice: number) => Math.max(1, Math.min(10, Math.floor(voice * 10) / 10));
export const soundSeconds = (clip: number) => Math.max(1, Math.min(20, Math.floor(clip * 10) / 10));

export interface SpeakOpts { face?: SourceRef; voice: SourceRef; words: string; prompt: string; res: RenderTier; count: number }

/** Speak.tsx speakBody(). */
export function speakBody(o: SpeakOpts): Body {
  const f = o.face, v = o.voice, words = o.words, prompt = o.prompt;
  if (f && f.kind !== 'image') throw new Error('Speak needs a still of the face.');
  if (!f && !prompt.includes('@')) throw new Error('Speak needs a face still, or an @mention of a cast member in the prompt.');
  if (v.kind !== 'audio' && v.kind !== 'video') throw new Error('Speak needs a sound file.');
  const size = speakSize(o.res, f ?? null), seconds = speakSeconds(v.seconds);
  return {
    kind: 'speak', app: 'speak', videoModel: 'ltx25', startImage: f?.token, audio: v.token, audioStart: 0, seconds,
    prompt: compilePrompt([prompt.trim() || SPEAK_PROMPT, words.trim() && `They say: ${words.trim()}`]), userPrompt: words.trim() || prompt.trim() || v.name,
    width: size.w, height: size.h, count: o.count, shotName: `speak_${v.name}`.slice(0, 40),
  };
}

export interface SoundOpts { clip: SourceRef; prompt: string; count: number }

/** Speak.tsx soundBody(). */
export function soundBody(o: SoundOpts): Body {
  const c = o.clip, prompt = o.prompt;
  if (c.kind !== 'video') throw new Error('Add sound needs a video clip.');
  return {
    kind: 'sound', app: 'sound', videoModel: 'ltx25', sourceVideo: c.token, parentTake: c.takeId, seconds: soundSeconds(c.seconds),
    prompt: prompt.trim() || SOUND_PROMPT, userPrompt: prompt.trim() || 'Add sound',
    width: c.w, height: c.h, count: o.count, shotName: `sound_${c.name}`.slice(0, 40),
  };
}

export interface EditOpts {
  mode: EditMode;
  /** Token of the image being edited, plus the take it came from, if any. */
  source: { token: string; take?: number };
  /** Free mode only: up to two more images. */
  refs: string[];
  /** Free mode only: mask token (white = change). */
  mask?: string;
  text: string;
  chips: string[];
  direction: string;
  expandTo: string;
  zoom: number;
  quality: 'draft' | 'quality';
  count: number;
}

/** Edit.tsx go(). Every mode sends `variants`, one per result. */
export function editBody(o: EditOpts): Body {
  const app = editAppById(o.mode);
  if (app.id !== o.mode) throw new Error(`Unknown edit mode "${o.mode}"`);
  const variants = editVariants(app.id, { text: o.text, chips: o.chips, direction: o.direction, count: o.count });
  const ratio = EXPAND_ASPECTS.find((a) => a.id === o.expandTo)?.ratio ?? 0;
  const { quality, refs, mask, zoom, text } = o;
  return {
    kind: 'edit', app: 'edit', mode: app.id, model: 'qwen-edit', quality,
    images: [o.source.token, ...(app.id === 'free' ? refs : [])], mask: app.id === 'free' ? mask ?? undefined : undefined,
    expand: app.id === 'expand' ? { aspect: ratio, zoom } : undefined, sourceTake: o.source.take,
    variants: variants.map((v) => ({ label: v.label, instruction: v.instruction, prompt: v.instruction, userPrompt: app.id === 'free' ? v.label : `${app.name}: ${v.label}` })),
    shotName: `${app.id === 'free' ? 'edit' : app.id}_${(text || app.name).slice(0, 30)}`,
  };
}

export interface CutoutOpts {
  /** An uploaded file (token) or a finished take (take), and whether it is a clip. */
  source: { kind: 'image' | 'video'; token?: string; take?: number; name: string };
  mode: CutoutMode;
  subject: string;
  background: CutoutBackground;
  color: string;
  backgroundImage?: string;
  audio: boolean;
}

/** Cutout.tsx cutoutBody(). Stills always use the soft matte. */
export function cutoutBody(o: CutoutOpts): Body {
  const s = o.source;
  const video = s.kind === 'video';
  const { mode, background, color, audio } = o;
  if (background === 'image' && !o.backgroundImage) throw new Error('background=image needs background_image');
  const keep = o.subject.trim() || 'person';
  return {
    kind: 'cutout', app: 'cutout', mode: video ? mode : 'matte',
    sourceTake: s.take, image: !s.take && !video ? s.token : undefined, sourceVideo: !s.take && video ? s.token : undefined,
    subject: video && mode !== 'matte' ? keep : undefined,
    background, color: background === 'color' ? color : undefined, backgroundImage: background === 'image' ? o.backgroundImage ?? undefined : undefined,
    withAudio: video ? audio : undefined,
    userPrompt: `Remove background${video && mode !== 'matte' ? `: ${keep}` : ''}`,
    shotName: s.take ? undefined : `${s.name}_cutout`.slice(0, 40),
  };
}

export interface RestyleOpts { sourceVideo: string; clip: ClipMeta; style: string | null; text: string; control: 'depth' | 'edges'; strength: number; audio: boolean; count: number; res: RenderTier }

/** MirrorEdit.tsx restyleBody(). */
export function restyleBody(o: RestyleOpts): Body {
  const look = restyleLook(o.style, o.text);
  if (!look) throw new Error('Restyle needs a style or a described look.');
  const seconds = Math.max(1, Math.min(12, Math.floor(o.clip.seconds)));
  const size = mirrorSize(o.clip.w, o.clip.h, o.res);
  const { style, text, control, count } = o;
  const name = style ? restyleById(style)?.label : undefined;
  return {
    kind: 'restyle', app: 'restyle', videoModel: 'mirror', control, sourceVideo: o.sourceVideo, style: style ?? undefined, styleName: name, text,
    instruction: restyleInstruction(look), prompt: restylePrompt(look), userPrompt: text.trim() || name || 'Restyle',
    width: size.w, height: size.h, seconds, guideStrength: o.strength, withAudio: o.audio, count,
    shotName: `restyle_${name ?? text}`.slice(0, 40),
  };
}

export interface SwapOpts { sourceVideo: string; clip: ClipMeta; target: string; point?: { x: number; y: number }; replacement: string; reference?: string; count: number; res: RenderTier }

/** MirrorEdit.tsx swapBody(). */
export function swapBody(o: SwapOpts): Body {
  if (!o.target.trim()) throw new Error('Object swap needs the object to replace.');
  if (!o.replacement.trim() && !o.reference) throw new Error('Object swap needs what it becomes, in words or as a picture.');
  const seconds = Math.max(1, Math.min(SWAP_MAX_SECONDS, Math.floor(o.clip.seconds)));
  const size = mirrorSize(o.clip.w, o.clip.h, o.res);
  const what = o.replacement.trim();
  return {
    kind: 'swap', app: 'swap', videoModel: 'mirror', sourceVideo: o.sourceVideo, target: o.target.trim(), point: o.point ?? undefined,
    replacement: what, reference: o.reference ?? undefined, prompt: swapPrompt(what || 'the object from the picture'),
    userPrompt: `Swap ${o.target.trim()} for ${what || 'the picture'}`, width: size.w, height: size.h, seconds, count: o.count,
    shotName: `swap_${what || o.target}`.slice(0, 40),
  };
}

/** The engine inputs of a blocking the page drew (server/stage.ts Blocking). An agent sends none: the server draws the scene. */
export interface StageBlockingTokens { clayVideo?: string; depthVideo?: string; depthImage?: string; clayImage?: string }

export interface StageOpts {
  scene: StageScene;
  prompt: string;
  /** Render size, already capped for Stage (appTier('stage', ...)). */
  res: RenderTier;
  lookEngine: 'depth' | 'edit';
  /** A look frame to use; without one the server makes it from the depth pass first. */
  look?: { token: string; take?: number };
  count: number;
  blocking?: StageBlockingTokens;
}

/** Stage.tsx go(): the shot body. Sizes and frame count derive from the scene. */
export function stageBody(o: StageOpts): Body {
  const { scene, prompt, res, lookEngine, look, count } = o;
  const b = o.blocking ?? {};
  const size = stageSize(scene.aspect, res);
  const ls = lookSize(scene.aspect);
  const frames = stageFrames(scene.seconds);
  return {
    kind: 'stage', app: 'stage', videoModel: 'stage', prompt, userPrompt: prompt, scene, resolution: res, lookEngine,
    clayVideo: b.clayVideo, depthVideo: b.depthVideo, depthImage: b.depthImage, clayImage: b.clayImage,
    lookImage: look?.token, lookTake: look?.take, lookWidth: ls.w, lookHeight: ls.h,
    width: size.w, height: size.h, seconds: scene.seconds, frames, count,
    shotName: (prompt || describeScene(scene)).slice(0, 40),
  };
}

/** JSON round-trip: what actually goes over the wire (undefined keys drop). */
export const wire = (b: Body): Body => JSON.parse(JSON.stringify(b));

/** Viewer.tsx finishHdr(): re-render a finished video take as HDR. */
export function hdrBody(takeId: number): Body {
  return { kind: 'hdr', sourceTake: takeId };
}

export type SeamStrategy = 'auto' | 'trim' | 'regen' | 'bridge' | 'reseed';
/** Viewer.tsx fixSeam(): the fix-seam request body. */
export function fixSeamBody(strategy: SeamStrategy = 'auto'): Body {
  return { strategy };
}

export interface ObjectOpts { source: SourceRef; quality: 'draft' | 'quality'; cutout: boolean; count: number }

/** Object.tsx go(): a still (by take id, or an upload token) to a textured GLB. */
export function objectBody(o: ObjectOpts): Body {
  const { source, quality, cutout, count } = o;
  if (source.kind !== 'image') throw new Error('Make 3D needs a still.');
  return {
    kind: 'object', app: 'object', quality, removeBackground: cutout, count,
    ...(source.takeId ? { sourceTake: source.takeId } : { image: source.token }),
    shotName: `object_${(source.prompt || source.name || 'still').slice(0, 30)}`,
    userPrompt: source.prompt ? `3D: ${source.prompt}` : `3D from ${source.name}`,
  };
}
