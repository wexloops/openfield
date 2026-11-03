/**
 * Parity check: the MCP request bodies must equal what the pages send.
 *
 * Rather than trusting a hand transcription, this pulls the body literals and
 * the size/seconds math straight out of src/pages/*.tsx, strips the types with
 * the TypeScript compiler, evaluates them with the same inputs, and compares
 * the JSON that would go over the wire. A page edit that changes a body makes
 * this fail until mcp/bodies.ts follows.
 *
 *   npx tsx mcp/bodies.check.ts      (or: npm run mcp:check)
 *
 * No network, no GPU.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';
import * as catalog from '../src/catalog.ts';
import { secondsToFrames } from '../src/presets.ts';
import {
  cutoutBody, restyleBody, swapBody, directorBody, editBody, fixSeamBody, hdrBody, stageBody, effectBody, sceneBody, withGenre, extendBody, imageBody, mirrorBody, reshootBody, soundBody, speakBody, transitionBody, upscaleBody, videoBody, videoSize, wire,
  objectBody,
  type Body, type ClipMeta, type SourceRef,
} from './bodies.ts';
import { EFFECT_QUALITY, effectById, effectPrompt, effectSize } from '../src/effects.ts';
import { appTier, tierSizeOf, type RenderTier } from '../src/renderTier.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = (name: string) => readFileSync(join(ROOT, 'src/pages', name), 'utf8');

/** The source between two markers (exclusive), or a loud failure. */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `marker not found: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `end marker not found: ${end}`);
  return src.slice(a + start.length, b);
}

/** Evaluate a TS snippet (function body) with the given variables in scope. */
function run(body: string, scope: Record<string, unknown>): any {
  const js = ts.transpileModule(`(function (${Object.keys(scope).join(', ')}) {\n${body}\n})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.trim().replace(/;$/, '');
  // eslint-disable-next-line no-eval
  return (0, eval)(js)(...Object.values(scope));
}
const expr = (src: string, scope: Record<string, unknown>) => run(`return (${src});`, scope);

let passed = 0;
function same(name: string, mine: Body, oracle: Body) {
  assert.deepStrictEqual(wire(mine), wire(oracle), name);
  passed++;
  console.log(`ok  ${name}`);
}

const { VIDEO_MODELS, IMAGE_MODELS, IMAGE_RES, compilePrompt, presetById, sizeFor, videoFrame } = catalog;

// ---------- Video.tsx ----------
{
  const src = page('Video.tsx');
  const sizeSrc = between(src, 'const size = useMemo(() => {', '}, [aspect, res');
  const bodySrc = between(src, 'const body: Record<string, unknown> = ', ";\n      if (model.id === 'h3')");
  assert.ok(src.includes("if (model.id === 'h3') body.lengthFrames = secondsToFrames(seconds);"), 'Video.tsx h3 lengthFrames rule moved');
  assert.ok(src.includes("const end = mode === 'loop' ? start : refs.find((r) => r.role === 'end');"), 'Video.tsx loop end-frame rule moved');
  assert.ok(src.includes('const compiled = compilePrompt([prompt, preset.text]);'), 'Video.tsx prompt compile moved');
  assert.ok(src.includes("if (mode === 'loop' && autoFix) body.seamFix = 'auto';"), 'Video.tsx loop auto-fix rule moved');
  assert.ok(src.includes('const [autoFix, setAutoFix] = useState(false);'), 'Video.tsx auto-fix default moved');
  assert.ok(src.includes("const [res, setRes] = useTierChoice('video');"), 'Video.tsx no longer starts at the machine-wide render size');

  const cases: { name: string; model: 'ltx25' | 'h3'; prompt: string; preset: string; aspect: any; res: any; seconds: number; count: number; audio: boolean; start?: { token: string; w: number; h: number }; end?: { token: string }; loop?: boolean; autoFix?: boolean }[] = [
    { name: 'video t2v ltx25 + preset', model: 'ltx25', prompt: 'A blacksmith hammering glowing steel in a dark forge.', preset: 'embers', aspect: 'auto', res: '720p', seconds: 5, count: 1, audio: false },
    { name: 'video t2v fixed aspect 1080p', model: 'ltx25', prompt: 'a long hotel corridor', preset: 'dolly-zoom', aspect: '21:9', res: '1080p', seconds: 8, count: 2, audio: true },
    { name: 'video i2v portrait start, auto aspect', model: 'ltx25', prompt: '', preset: 'orbit-left', aspect: 'auto', res: '480p', seconds: 3, count: 1, audio: false, start: { token: 'openfield_1_a.png', w: 1080, h: 1920 } },
    { name: 'video flf2v h3 start+end', model: 'h3', prompt: 'she turns and walks away', preset: 'free', aspect: 'auto', res: '720p', seconds: 8, count: 3, audio: true, start: { token: 's.png', w: 1664, h: 928 }, end: { token: 'e.png' } },
    { name: 'loop (start = end)', model: 'ltx25', prompt: 'mist drifts, lanterns sway', preset: 'static', aspect: 'auto', res: '720p', seconds: 5, count: 1, audio: false, start: { token: 'loop.png', w: 1328, h: 1328 }, loop: true, autoFix: true },
    { name: 'loop, auto-fix off', model: 'ltx25', prompt: 'waves roll in', preset: 'static', aspect: 'auto', res: '480p', seconds: 3, count: 2, audio: false, start: { token: 'loop.png', w: 1344, h: 768 }, loop: true, autoFix: false },
  ];
  for (const c of cases) {
    const model = VIDEO_MODELS.find((m) => m.id === c.model)!;
    const preset = presetById(c.preset);
    const start = c.start;
    const end = c.loop ? start : c.end;
    const size = run(sizeSrc, { aspect: c.aspect, res: c.res, start, videoFrame });
    const compiled = compilePrompt([c.prompt, preset.text]);
    const oracle = expr(bodySrc, { model, compiled, prompt: c.prompt, preset, size, seconds: c.seconds, count: c.count, audio: c.audio, start, end });
    if (model.id === 'h3') oracle.lengthFrames = secondsToFrames(c.seconds);
    if (c.loop && c.autoFix) oracle.seamFix = 'auto';

    const mine = videoBody({
      model: c.model, prompt: c.prompt, preset: c.preset, size: videoSize(c.aspect, c.res, start && { w: start.w, h: start.h }),
      seconds: c.seconds, count: c.count, audio: c.audio, startImage: start?.token, endImage: c.end?.token, loop: c.loop, autoFix: c.autoFix,
    });
    same(c.name, mine, oracle);
  }
  // Your own LoRAs: LTX-2.5 only, sent as the chip holds them.
  assert.ok(src.includes("if (model.id === 'ltx25' && loras.length) body.loras = loras;"), 'Video.tsx LoRA rule moved');
  {
    const model = VIDEO_MODELS.find((m) => m.id === 'ltx25')!;
    const preset = presetById('free');
    const loras = [{ name: 'char.safetensors', strength: 0.9 }];
    const size = run(sizeSrc, { aspect: '16:9', res: '720p', start: undefined, videoFrame });
    const oracle = expr(bodySrc, { model, compiled: compilePrompt(['a man runs', preset.text]), prompt: 'a man runs', preset, size, seconds: 5, count: 1, audio: false, start: undefined, end: undefined });
    oracle.loras = loras;
    same('video ltx25 + your LoRA', videoBody({ model: 'ltx25', prompt: 'a man runs', preset: 'free', size: videoSize('16:9', '720p'), seconds: 5, count: 1, audio: false, loras }), oracle);
    assert.throws(() => videoBody({ model: 'h3', prompt: 'x', preset: 'free', size, seconds: 5, count: 1, audio: false, startImage: 's.png', loras }), /LTX-2.5/);
  }
  // H3 turbo: the page sends h3Turbo only on H3, as the chip picked it.
  assert.ok(src.includes("if (model.id === 'h3' && turbo) body.h3Turbo = turbo;"), 'Video.tsx H3 turbo rule moved');
  {
    const size = videoSize('16:9', '480p', { w: 1344, h: 768 });
    const b = videoBody({ model: 'h3', prompt: 'x', preset: 'free', size, seconds: 5, count: 1, audio: false, startImage: 's.png', turbo: 'v11-4' });
    assert.equal(b.h3Turbo, 'v11-4');
    assert.equal(videoBody({ model: 'h3', prompt: 'x', preset: 'free', size, seconds: 5, count: 1, audio: false, startImage: 's.png' }).h3Turbo, undefined);
    assert.throws(() => videoBody({ model: 'ltx25', prompt: 'x', preset: 'free', size, seconds: 5, count: 1, audio: false, turbo: 'v11-4' }), /H3/);
    console.log('ok  video h3 turbo');
  }
  // Cast: the page sends castMode only for a hero frame, while @mentions are in play.
  assert.ok(src.includes("if (castOn && castMode === 'frame') body.castMode = 'frame';"), 'Video.tsx cast mode rule moved');
  {
    const model = VIDEO_MODELS.find((m) => m.id === 'ltx25')!;
    const preset = presetById('free');
    const prompt = '@Mara walks through the market';
    const size = run(sizeSrc, { aspect: 'auto', res: '720p', start: undefined, videoFrame });
    const oracle = expr(bodySrc, { model, compiled: compilePrompt([prompt, preset.text]), prompt, preset, size, seconds: 5, count: 1, audio: false, start: undefined, end: undefined });
    oracle.castMode = 'frame';
    same('video cast hero frame mode', videoBody({ model: 'ltx25', prompt, preset: 'free', size: videoSize('auto', '720p'), seconds: 5, count: 1, audio: false, castMode: 'frame' }), oracle);
  }
}

// ---------- Image.tsx ----------
{
  const src = page('Image.tsx');
  const bodySrc = between(src, 'const r = await api.generate(', ');\n      toast(`Queued ${r.takeIds.length} image');
  assert.ok(src.includes("const size = sizeFor(aspect, IMAGE_RES.find((r) => r.id === res)!.mp);"), 'Image.tsx size rule moved');
  for (const c of [
    { name: 'image qwen 16:9 1K', model: 'qwen', prompt: 'a poster that says OPENFIELD in bold type', aspect: '16:9', quality: 'quality', res: '1K', count: 1 },
    { name: 'image flux2 9:16 2K draft x3', model: 'flux2', prompt: 'a paper lantern over tall grass at night', aspect: '9:16', quality: 'draft', res: '2K', count: 3 },
    { name: 'image qwen + your LoRA', model: 'qwen', prompt: 'a red door', aspect: '1:1', quality: 'draft', res: '1K', count: 1, loras: [{ name: 'my-style.safetensors', strength: 0.8 }] },
    { name: 'image flux2 refs + LoRAs', model: 'flux2', prompt: 'the man in image 1 at a bus stop', aspect: '16:9', quality: 'quality', res: '1K', count: 2,
      loras: [{ name: 'a.safetensors', strength: 1 }, { name: 'b.safetensors', strength: -0.4 }], refs: [{ token: 'asset:r1', name: 'r1.png' }, { token: 'asset:r2', name: 'r2.png' }] },
  ] as { name: string; model: 'qwen' | 'flux2'; prompt: string; aspect: any; quality: 'draft' | 'quality'; res: any; count: number; loras?: { name: string; strength: number }[]; refs?: { token: string; name: string }[] }[]) {
    const model = IMAGE_MODELS.find((m) => m.id === c.model)!;
    const size = sizeFor(c.aspect, IMAGE_RES.find((r) => r.id === c.res)!.mp);
    const loras = c.loras ?? [];
    const refs = c.refs ?? [];
    const oracle = expr(bodySrc, { model, quality: c.quality, prompt: c.prompt, size, count: c.count, loras, refs, refsOn: c.model === 'flux2' });
    same(c.name, imageBody({ model: c.model, prompt: c.prompt, aspect: c.aspect, quality: c.quality, res: c.res, count: c.count, loras, refImages: refs.map((r) => r.token) }), oracle);
  }
  assert.ok(src.includes("const refsOn = model.id === 'flux2';"), 'Image.tsx: references are FLUX.2 only');
  assert.throws(() => imageBody({ model: 'qwen', prompt: 'x', aspect: '1:1', quality: 'draft', res: '1K', count: 1, refImages: ['asset:r'] }), /need model flux2/);
}

// ---------- Director.tsx ----------
{
  const src = page('Director.tsx');
  const dirSrc = between(src, 'const direction = ', ';\n  const moveText');
  const moveSrc = between(src, 'const moveText = ', ';\n  const compiled');
  const sizeSrc = between(src, 'const size = ', ';\n  const toShoot');
  const commonSrc = between(src, 'const common = ', ';\n      const r = mode');
  const m = /\? await api\.generate\((\{[^\n]*\})\)\n\s*: await api\.generate\((\{[^\n]*\})\);/.exec(src);
  assert.ok(m, 'Director.tsx generate calls moved');
  assert.ok(src.includes("const compiled = compilePrompt([moveText, scene, direction.join(', ')]);"), 'Director.tsx compile moved');
  assert.ok(src.includes("setPicks(axis === 'genre' ? pickGenre(picks, id) : { ...picks, [axis]: id });"), 'Director.tsx genre pick rule moved (mcp withGenre mirrors it)');
  const { directorDirection } = catalog;
  for (const c of [
    { name: 'director frame, picks', mode: 'frame', scene: 'a lighthouse keeper climbs the stairs with a lantern as the storm hits', picks: { camera: 'anamorphic', light: 'candle', film: '500t', grade: 'teal' }, era: null, grade: true, ramp: 'linear', aspect: '21:9', count: 2, imageModel: 'qwen', move: 'push-in', seconds: 5, audio: false, res: '480p' },
    { name: 'director frame, no scene, era graded', mode: 'frame', scene: '', picks: { look: 'noir' }, era: 1962, grade: true, ramp: 'linear', aspect: '1:1', count: 4, imageModel: 'flux2', move: 'push-in', seconds: 5, audio: false, res: '720p' },
    { name: 'director shot from hero, genre + era prompt only', mode: 'shot', scene: 'the keeper reaches the lamp room', picks: { ...catalog.pickGenre({}, 'noir'), framing: 'low' }, era: 1974, grade: false, ramp: 'linear', aspect: '16:9', count: 1, imageModel: 'qwen', move: 'crane-up', seconds: 8, audio: true, hero: { token: 'hero.png', take: 7 }, res: '720p' },
    { name: 'director shot from text, bullet time, 480p', mode: 'shot', scene: 'a fox crosses a frozen lake', picks: {}, era: 2003, grade: true, ramp: 'bullet', aspect: '9:16', count: 2, imageModel: 'qwen', move: 'whip-pan', seconds: 3, audio: false, res: '480p' },
    { name: 'director shot 1080p hero shot', mode: 'shot', scene: 'the lamp turns', picks: {}, era: null, grade: true, ramp: 'linear', aspect: '21:9', count: 1, imageModel: 'qwen', move: 'push-in', seconds: 5, audio: false, res: '1080p' },
  ] as const) {
    const mode = c.mode === 'frame' ? 'image' : 'video'; // the page's names
    const picks = c.picks as Record<string, string>;
    const hero = 'hero' in c ? c.hero : null;
    const direction = expr(dirSrc, { directorDirection, picks, era: c.era });
    const moveText = expr(moveSrc, { mode, presetById, move: c.move });
    const compiled = compilePrompt([moveText, c.scene, direction.join(', ')]);
    const size = expr(sizeSrc, { mode, sizeFor, aspect: c.aspect, videoFrame, res: appTier('director', c.res) });
    const common = expr(commonSrc, { scene: c.scene, picks, era: c.era, grade: c.grade, compiled, size, count: c.count });
    const oracle = expr(mode === 'image' ? m![1] : m![2], { common, imageModel: c.imageModel, seconds: c.seconds, audio: c.audio, hero, move: c.move, presetById, ramp: c.ramp });
    const mine = directorBody({ mode: c.mode, scene: c.scene, picks, era: c.era, grade: c.grade, ramp: c.ramp, aspect: c.aspect, count: c.count, imageModel: c.imageModel, move: c.move, seconds: c.seconds, audio: c.audio, heroImage: hero?.token, res: c.res });
    same(c.name, mine, oracle);
  }
  // Genre through MCP: withGenre fills the axes the genre sets, explicit picks win.
  assert.deepStrictEqual(withGenre({ genre: 'noir', light: 'neon' }), { ...catalog.pickGenre({}, 'noir'), light: 'neon' });
  passed++;
  console.log('ok  director genre fills its axes, explicit picks override');

  assert.ok(src.includes("const [res, setRes] = useTierChoice(mode === 'scene' ? 'scene' : 'director');"), 'Director.tsx no longer starts at the machine-wide render size');
  // Scene mode: shootAll() body.
  const sceneSrc = between(src, 'const r = await api.directorScene(', ');\n      setCutId(r.cutId);');
  for (const c of [
    { name: 'director scene, planned shots, era + ramp', scene: 'A keeper climbs. He sees a wreck.', picks: { genre: 'drama', camera: 'large-format' }, era: 1974, grade: true, ramp: 'linear', audio: false, heroFrames: false, imageModel: 'qwen', aspect: '16:9', res: '480p', shots: [
      { framing: 'wide', move: 'static', action: 'The keeper climbs the stairs.', seconds: 3 },
      { framing: 'close', move: 'handheld', action: 'He sees the wreck.', seconds: 4, ramp: 'impact' },
    ] },
    { name: 'director scene, hero frames, 720p 9:16, sound', scene: 'A fox runs.', picks: {}, era: null, grade: true, ramp: 'slowmo', audio: true, heroFrames: true, imageModel: 'flux2', aspect: '9:16', res: '720p', shots: [
      { framing: 'top', move: 'fpv-dive', action: 'A fox runs across the snow.', seconds: 5 },
      { framing: 'ecu', move: 'rack-focus', action: 'Its breath steams.', seconds: 2 },
      { framing: 'low', move: 'crane-up', action: 'It vanishes into the trees.', seconds: 6, cast: [3] },
    ] },
  ] as const) {
    const size = expr(sizeSrc, { mode: 'scene', sizeFor, aspect: c.aspect, videoFrame, res: appTier('scene', c.res) });
    const list = c.shots.map((x) => ({ ...x, key: undefined, cut: undefined, take: undefined }));
    const oracle = expr(sceneSrc, { scene: c.scene, picks: c.picks, era: c.era, grade: c.grade, ramp: c.ramp, audio: c.audio, heroFrames: c.heroFrames, imageModel: c.imageModel, size, list });
    const mine = sceneBody({ scene: c.scene, picks: c.picks as Record<string, string>, era: c.era, grade: c.grade, ramp: c.ramp, audio: c.audio, heroFrames: c.heroFrames, imageModel: c.imageModel, aspect: c.aspect, res: c.res, shots: c.shots.map((x) => ({ ...x, cast: 'cast' in x ? [...x.cast] : undefined })) });
    same(c.name, mine, oracle);
  }
}

// ---------- Mirror.tsx ----------
{
  const src = page('Mirror.tsx');
  const secSrc = between(src, 'const seconds = ', ';\n  const size');
  const sizeSrc = between(src, 'const size = ', ';\n  const est');
  const bodySrc = between(src, 'const r = await api.generate(', ');\n      toast(`Queued ${r.takeIds.length} take');
  for (const c of [
    { name: 'mirror body, landscape clip, first frame, 720p', control: 'pose', clip: { seconds: 9.7, w: 1920, h: 1080 }, frame: 'knight.png', prompt: 'A knight in battered silver armor in a torchlit stone hall', strength: 0.8, audio: false, count: 1, res: '720p' },
    { name: 'mirror scene, portrait clip > 12s, 480p', control: 'depth', clip: { seconds: 15.2, w: 1080, h: 1920 }, frame: null, prompt: 'an astronaut on a red dune', strength: 1, audio: true, count: 2, res: '480p' },
    { name: 'mirror outlines, unknown size, 1080p asked = 720p', control: 'edges', clip: { seconds: 5, w: 0, h: 0 }, frame: null, prompt: 'chrome letters', strength: 0.6, audio: false, count: 1, res: '1080p' },
  ] as const) {
    const clip = { token: 'src.mp4', ...c.clip };
    const seconds = expr(secSrc, { clip });
    const size = expr(sizeSrc, { clip, res: appTier('mirror', c.res), mirrorSize: catalog.mirrorSize });
    const oracle = expr(bodySrc, { control: c.control, clip, frame: c.frame, prompt: c.prompt, size, seconds, strength: c.strength, audio: c.audio, count: c.count });
    const mine = mirrorBody({ control: c.control, sourceVideo: clip.token, clip: c.clip as ClipMeta, firstFrame: c.frame ?? undefined, prompt: c.prompt, strength: c.strength, audio: c.audio, count: c.count, res: c.res });
    same(c.name, mine, oracle);
  }
}

// ---------- Reshoot.tsx ----------
{
  const src = page('Reshoot.tsx');
  const secSrc = between(src, 'const seconds = ', ';\n  const size');
  const sizeSrc = between(src, 'const size = ', ';\n  const est');
  const bodySrc = between(src, "const body = (kind: 'reshoot' | 'reshoot-preview') => (", ');\n\n  async function runPreview');
  assert.ok(src.includes("await api.generate({ ...body('reshoot'), count })"), 'Reshoot.tsx go() moved');
  assert.ok(src.includes("await api.generate(body('reshoot-preview'))"), 'Reshoot.tsx runPreview() moved');
  for (const c of [
    { name: 'reshoot orbit + move, 720p', clip: { seconds: 6.4, w: 1920, h: 1080 }, az: 30, el: 10, pivot: 1.05, move: true, prompt: '', audio: true, count: 1, preview: false, res: '720p' },
    { name: 'reshoot three-quarter, prompt, x2, 480p', clip: { seconds: 12, w: 1080, h: 1350 }, az: 40, el: 12, pivot: 3, move: false, prompt: 'A bookshelf and a window to the left of the desk.', audio: false, count: 2, preview: false, res: '480p' },
    { name: 'reshoot-preview', clip: { seconds: 1.2, w: 0, h: 0 }, az: -30, el: 0, pivot: 0.5, move: false, prompt: '', audio: true, count: 3, preview: true, res: '1080p' },
  ] as const) {
    const clip = { token: 'src.mp4', url: 'blob:', ...c.clip };
    const seconds = expr(secSrc, { clip });
    const size = expr(sizeSrc, { clip, res: appTier('reshoot', c.res), tierSizeOf });
    const body = (kind: string) => expr(bodySrc, { kind, clip, az: c.az, el: c.el, pivot: c.pivot, move: c.move, seconds, prompt: c.prompt, size, audio: c.audio });
    const oracle = c.preview ? body('reshoot-preview') : { ...body('reshoot'), count: c.count };
    const mine = reshootBody({ sourceVideo: clip.token, clip: c.clip, azimuth: c.az, elevation: c.el, pivotDepth: c.pivot, move: c.move, prompt: c.prompt, audio: c.audio, count: c.count, preview: c.preview, res: c.res });
    same(c.name, mine, oracle);
  }
}

// ---------- Effects.tsx ----------
{
  const src = page('Effects.tsx');
  const secSrc = between(src, 'const seconds = ', ';\n  const size');
  const sizeSrc = between(src, 'const size = ', ';\n  const est');
  const bodySrc = between(src, 'const r = await api.generate(', ');\n      toast(`Queued ${r.takeIds.length} take');
  for (const c of [
    { name: 'effect cutout, landscape clip > max', effect: 'cutout', input: { token: 'src.mp4', w: 1280, h: 704, seconds: 9.4 }, text: '', quality: 'draft', seconds: 5, loop: true, count: 1 },
    { name: 'effect flood, portrait clip, high, text', effect: 'flood', input: { token: 'src.mp4', w: 1080, h: 1920, seconds: 3.6 }, text: 'a fast river with white foam', quality: 'high', seconds: 5, loop: false, count: 2 },
    { name: 'effect living photo, loop', effect: 'living-photo', input: { token: 'still.png', w: 1344, h: 768, seconds: 0 }, text: 'the steam rises', quality: 'draft', seconds: 8, loop: true, count: 1 },
    { name: 'effect pop, square still, 3s', effect: 'pop', input: { token: 'dog.png', w: 1024, h: 1024, seconds: 0 }, text: '', quality: 'high', seconds: 3, loop: true, count: 3 },
  ] as const) {
    const fx = effectById(c.effect)!;
    const input = c.input;
    const seconds = expr(secSrc, { fx, input, stillSeconds: c.seconds });
    const res = EFFECT_QUALITY.find((q) => q.id === c.quality)!.tier;
    const size = expr(sizeSrc, { effectSize, fx, input, res: appTier('effects', res) });
    const oracle = expr(bodySrc, { fx, effectPrompt, text: c.text, size, seconds, loop: c.loop, count: c.count, input });
    const mine = effectBody({ effect: c.effect, input: c.input, text: c.text, res, seconds: c.seconds, loop: c.loop, count: c.count });
    same(c.name, mine, oracle);
  }
}

// ---------- Edit.tsx ----------
{
  const src = page('Edit.tsx');
  const bodySrc = between(src, 'const r = await api.generate(', ");\n      setView('takes');");
  assert.ok(src.includes('const variants = editVariants(app.id, { text, chips, direction, count });'), 'Edit.tsx variants compile moved');
  assert.ok(src.includes('const ratio = EXPAND_ASPECTS.find((a) => a.id === expandTo)?.ratio ?? 0;'), 'Edit.tsx expand ratio moved');
  const { EDIT_APPS, EXPAND_ASPECTS, editAppById, editVariants } = catalog;
  const cases = [
    { name: 'edit free, refs + mask, x2', mode: 'free', source: { token: 'src.png', take: 44 }, refs: ['r2.png'], mask: 'm.png', text: 'Put the coat from image 2 on him.', chips: [], direction: 'auto', expandTo: '16:9', zoom: 0.8, quality: 'quality', count: 2 },
    { name: 'edit new angle, defaults', mode: 'angle', source: { token: 'src.png' }, refs: ['ignored.png'], mask: 'ignored.png', text: '', chips: EDIT_APPS.find((a) => a.id === 'angle')!.defaults, direction: 'auto', expandTo: '16:9', zoom: 0.8, quality: 'draft', count: 1 },
    { name: 'edit coverage, steer', mode: 'coverage', source: { token: 'src.png', take: 7 }, refs: [], mask: undefined, text: 'her red coat', chips: ['wide', 'close', 'ots'], direction: 'auto', expandTo: '16:9', zoom: 0.8, quality: 'draft', count: 1 },
    { name: 'edit relight from the left', mode: 'relight', source: { token: 'src.png' }, refs: [], mask: undefined, text: '', chips: ['golden', 'neon'], direction: 'left', expandTo: '16:9', zoom: 0.8, quality: 'quality', count: 1 },
    { name: 'edit expand 9:16 pull back x3', mode: 'expand', source: { token: 'src.png' }, refs: [], mask: undefined, text: 'a harbor town', chips: [], direction: 'auto', expandTo: '9:16', zoom: 0.7, quality: 'draft', count: 3 },
    { name: 'edit expand same shape', mode: 'expand', source: { token: 'src.png' }, refs: [], mask: undefined, text: '', chips: [], direction: 'auto', expandTo: 'same', zoom: 0.6, quality: 'draft', count: 1 },
  ] as const;
  for (const c of cases) {
    const app = editAppById(c.mode);
    const variants = editVariants(app.id, { text: c.text, chips: [...c.chips], direction: c.direction, count: c.count });
    const ratio = EXPAND_ASPECTS.find((a) => a.id === c.expandTo)?.ratio ?? 0;
    const oracle = expr(bodySrc, { app, quality: c.quality, source: c.source, refs: c.refs, mask: c.mask, ratio, zoom: c.zoom, variants, text: c.text });
    const mine = editBody({ mode: c.mode, source: c.source, refs: [...c.refs], mask: c.mask, text: c.text, chips: [...c.chips], direction: c.direction, expandTo: c.expandTo, zoom: c.zoom, quality: c.quality, count: c.count });
    same(c.name, mine, oracle);
  }
}

// ---------- Upscale.tsx ----------
{
  const src = page('Upscale.tsx');
  const bodySrc = between(src, 'const r = await api.generate(', ');\n      setCompare(null);');
  const modelSrc = between(src, 'const model = ', ';\n  const est');
  const engineSrc = between(src, 'const engine = ', ';\n\n  async function go()');
  const labelSrc = between(src, 'const modeLabel = ', ';\n');
  const { SHARPEN_MODELS, UPSCALE_MODES } = catalog;
  const modeLabel = expr(labelSrc, { UPSCALE_MODES });
  const base = { sharpModel: 'esrgan', rife: false, redrawModel: '3b', upHeight: 1080, color: 'lab', creativity: 0.45, prompt: '' } as const;
  for (const c of [
    { name: 'upscale sharpen, take, defaults', mode: 'sharpen', source: { kind: 'video', take: 46, name: 'sweep_t2v' } },
    { name: 'upscale sharpen, ultrasharp + rife, file', mode: 'sharpen', source: { kind: 'video', token: 'asset:clip', name: 'my clip' }, sharpModel: 'ultrasharp', rife: true },
    { name: 'upscale sharpen still ignores rife', mode: 'sharpen', source: { kind: 'image', take: 44, name: 'sweep_qwen' }, rife: true },
    { name: 'upscale redraw 7b 1440 wavelet', mode: 'redraw', source: { kind: 'video', take: 42, name: 'run' }, redrawModel: '7b', upHeight: 1440, color: 'wavelet' },
    { name: 'upscale redraw still', mode: 'redraw', source: { kind: 'image', token: 'asset:still', name: 'a still with a long file name that goes past forty characters' } },
    { name: 'upscale dream with prompt', mode: 'dream', source: { kind: 'video', take: 47, name: 'waves' }, creativity: 0.7, prompt: 'frost on the glass' },
    { name: 'upscale dream, no prompt', mode: 'dream', source: { kind: 'video', token: 'asset:v', name: 'v' }, creativity: 0.2, prompt: '   ' },
  ] as const) {
    const o = { ...base, ...c } as any;
    const video = o.source.kind === 'video';
    const model = expr(modelSrc, { mode: o.mode, sharpModel: o.sharpModel, redrawModel: o.redrawModel });
    const engine = expr(engineSrc, { mode: o.mode, SHARPEN_MODELS, sharpModel: o.sharpModel });
    const oracle = expr(bodySrc, { ...o, video, model, engine, modeLabel });
    same(c.name, upscaleBody(o), oracle);
  }
  assert.throws(() => upscaleBody({ ...base, mode: 'dream', source: { kind: 'image', take: 44, name: 'x' } } as any), /Dream works on video/);
  assert.ok(src.includes("const blocked = mode === 'dream' && source?.kind === 'image' ? 'Dream works on video. Use Sharpen or Redraw for a still.' : null;"), 'Upscale.tsx Dream still guard moved');
}

// ---------- Extend.tsx (Extend + Transition) ----------
{
  const src = page('Extend.tsx');
  const sizeSrc = between(src, 'const size = (() => {', '})();\n  const est');
  const extSrc = between(src, 'function extendBody() {', 'return body;');
  const trSrc = between(src, 'function transitionBody() {', 'return body;');
  assert.ok(src.includes('const style = TRANSITION_STYLES.find((s) => s.id === styleId) ?? TRANSITION_STYLES[0];'), 'Extend.tsx style lookup moved');
  const { CONTINUE_PROMPT, TRANSITION_STYLES } = catalog;
  const vid = (o: Partial<SourceRef> = {}): SourceRef => ({ token: 'clip.mp4', kind: 'video', name: 'take 47', w: 832, h: 448, seconds: 3.04, takeId: 47, prompt: 'a lighthouse at dusk', ...o });
  const still = (o: Partial<SourceRef> = {}): SourceRef => ({ token: 'still.png', kind: 'image', name: 'take 58', w: 1344, h: 768, seconds: 0, takeId: 58, ...o });
  for (const c of [
    { name: 'extend forward, empty prompt uses take prompt, 720p', s: vid(), direction: 'forward', prompt: '', seconds: 3, audio: true, count: 1, res: '720p' },
    { name: 'extend backward, own prompt, dropped file, 480p', s: vid({ takeId: undefined, prompt: undefined, name: 'phone clip' }), direction: 'backward', prompt: 'Fog rolls in first.', seconds: 5, audio: false, count: 2, res: '480p' },
    { name: 'extend, no prompt anywhere, 1080p asked = 720p', s: vid({ prompt: undefined }), direction: 'forward', prompt: '  ', seconds: 8, audio: true, count: 1, res: '1080p' },
  ] as const) {
    const size = run(sizeSrc, { src: c.s, to: null, res: appTier('extend', c.res), tierSizeOf });
    const oracle = run(`${extSrc}\nreturn body;`, { src: c.s, direction: c.direction, prompt: c.prompt, size, seconds: c.seconds, audio: c.audio, count: c.count, CONTINUE_PROMPT });
    same(c.name, extendBody({ source: c.s, direction: c.direction, prompt: c.prompt, seconds: c.seconds, audio: c.audio, count: c.count, res: c.res }), oracle);
  }
  for (const c of [
    { name: 'transition video -> still, whip, 720p', a: vid(), b: still(), style: 'whip', prompt: '', seconds: 2, audio: true, count: 1, res: '720p' },
    { name: 'transition still -> still, morph + words, 480p', a: still(), b: still({ w: 768, h: 1344 }), style: 'morph', prompt: 'The sparks become rain.', seconds: 3, audio: false, count: 2, res: '480p' },
    { name: 'transition still -> video, light leak', a: still(), b: vid({ w: 1280, h: 704 }), style: 'light-leak', prompt: '', seconds: 4, audio: true, count: 1, res: '720p' },
  ] as const) {
    const size = run(sizeSrc, { src: c.a, to: c.b, res: appTier('transition', c.res), tierSizeOf });
    const style = TRANSITION_STYLES.find((s) => s.id === c.style)!;
    const oracle = run(`${trSrc}\nreturn body;`, { src: c.a, to: c.b, style, prompt: c.prompt, size, seconds: c.seconds, audio: c.audio, count: c.count, compilePrompt });
    same(c.name, transitionBody({ from: c.a, to: c.b, style: c.style, prompt: c.prompt, seconds: c.seconds, audio: c.audio, count: c.count, res: c.res }), oracle);
  }
}

// ---------- Speak.tsx (Speak + Add sound) ----------
{
  const src = page('Speak.tsx');
  const sizeSrc = between(src, 'const size = (() => {', '})();\n  const seconds');
  const secSrc = between(src, 'const seconds = ', ';\n  const est');
  const spSrc = between(src, 'function speakBody() {', 'return body;');
  const soSrc = between(src, 'function soundBody() {', 'return body;');
  assert.ok(src.includes("const [res, setRes] = useTierChoice('speak');"), 'Speak.tsx no longer starts at the machine-wide render size');
  const { SPEAK_PROMPT, SOUND_PROMPT } = catalog;
  const face = (o: Partial<SourceRef> = {}): SourceRef => ({ token: 'face.png', kind: 'image', name: 'take 12', w: 1024, h: 576, seconds: 0, takeId: 12, ...o });
  const voice = (sec: number): SourceRef => ({ token: 'speech.wav', kind: 'audio', name: 'speech', w: 0, h: 0, seconds: sec });
  for (const c of [
    { name: 'speak 480p, words', f: face(), v: voice(6.39), words: 'Every night I climb these stairs.', prompt: '', res: '480p', count: 1 },
    { name: 'speak 720p portrait face, long audio capped, direction only', f: face({ w: 768, h: 1344 }), v: voice(14.2), words: '', prompt: 'A singer in a smoky club.', res: '720p', count: 2 },
  ] as const) {
    const size = run(sizeSrc, { res: appTier('speak', c.res), face: c.f, tierSizeOf });
    const seconds = expr(secSrc, { speak: true, voice: c.v, clip: null });
    const oracle = run(`${spSrc}\nreturn body;`, { face: c.f, voice: c.v, seconds, prompt: c.prompt, words: c.words, size, count: c.count, compilePrompt, SPEAK_PROMPT });
    same(c.name, speakBody({ face: c.f, voice: c.v, words: c.words, prompt: c.prompt, res: c.res, count: c.count }), oracle);
  }
  {
    // No face: a cast member named in the direction stands in (a hero portrait is made first).
    const v = voice(4), prompt = '@Mara talks quietly by the window';
    const size = run(sizeSrc, { res: '480p', face: null, tierSizeOf });
    const seconds = expr(secSrc, { speak: true, voice: v, clip: null });
    const oracle = run(`${spSrc}\nreturn body;`, { face: null, voice: v, seconds, prompt, words: '', size, count: 1, compilePrompt, SPEAK_PROMPT });
    same('speak with a cast member, no face', speakBody({ voice: v, words: '', prompt, res: '480p', count: 1 }), oracle);
  }
  for (const c of [
    { name: 'add sound, take, default prompt', clip: { token: 'c.mp4', kind: 'video', name: 'take 59', w: 832, h: 512, seconds: 3.04, takeId: 59 } as SourceRef, prompt: '', count: 1 },
    { name: 'add sound, long dropped clip, prompt', clip: { token: 'c.mp4', kind: 'video', name: 'beach', w: 1920, h: 1080, seconds: 31.5 } as SourceRef, prompt: 'Surf and gulls.', count: 3 },
  ] as const) {
    const seconds = expr(secSrc, { speak: false, voice: null, clip: c.clip });
    const oracle = run(`${soSrc}\nreturn body;`, { clip: c.clip, seconds, prompt: c.prompt, count: c.count, SOUND_PROMPT });
    same(c.name, soundBody({ clip: c.clip, prompt: c.prompt, count: c.count }), oracle);
  }
}

// ---------- Cutout.tsx (Remove background) ----------
{
  const src = page('Cutout.tsx');
  const bodySrc = between(src, 'function cutoutBody() {', 'return body;');
  for (const c of [
    { name: 'cutout still upload, transparent', s: { kind: 'image', token: 'k.png', name: 'kite', url: '', w: 1344, h: 768, seconds: 0 }, mode: 'hybrid', subject: '', background: 'transparent', color: '#ffffff', bgImage: null, audio: true },
    { name: 'cutout clip take, steady, color', s: { kind: 'video', take: 42, name: 'take 42', url: '', w: 1280, h: 704, seconds: 5 }, mode: 'hybrid', subject: 'the dog', background: 'color', color: '#00b140', bgImage: null, audio: false },
    { name: 'cutout clip upload, matte, picture, sound', s: { kind: 'video', token: 'c.mp4', name: 'a very long phone clip name that runs on and on', url: '', w: 1080, h: 1920, seconds: 31 }, mode: 'matte', subject: 'x', background: 'image', color: '#000000', bgImage: 'bg.png', audio: true },
    { name: 'cutout clip, tracked, blur', s: { kind: 'video', token: 'c.mp4', name: 'clip', url: '', w: 832, h: 448, seconds: 4 }, mode: 'track', subject: '  ', background: 'blur', color: '#000000', bgImage: null, audio: false },
  ] as const) {
    const video = c.s.kind === 'video';
    const oracle = run(`${bodySrc}\nreturn body;`, { src: c.s, video, subject: c.subject, mode: c.mode, background: c.background, color: c.color, bgImage: c.bgImage, audio: c.audio });
    const mine = cutoutBody({ source: c.s as any, mode: c.mode, subject: c.subject, background: c.background, color: c.color, backgroundImage: c.bgImage ?? undefined, audio: c.audio });
    same(c.name, mine, oracle);
  }
  const viewer = readFileSync(join(ROOT, 'src/Viewer.tsx'), 'utf8');
  assert.ok(viewer.includes('navigate(`/cutout?take=${t.id}`)'), 'Viewer.tsx Remove background no longer opens /cutout?take=<id> for clips');
  assert.ok(src.includes("const fromTake = Number(params.get('take')) || null;"), 'Cutout.tsx no longer reads ?take=');
  passed++;
  console.log('ok  viewer Remove background deep-links /cutout?take=<id>, which the page reads');
}

// ---------- MirrorEdit.tsx (Restyle + Object swap) ----------
{
  const src = page('MirrorEdit.tsx');
  const reSec = between(src, 'const seconds = ', ';\n  const size = mirrorSize');
  const reBody = between(src, 'function restyleBody() {', 'return body;');
  const swBody = between(src, 'function swapBody() {', 'return body;');
  const swSec = between(src.slice(src.indexOf('export function SwapControls')), 'const seconds = ', ';\n  const size');
  const { RESTYLE_STYLES, SWAP_MAX_SECONDS, mirrorSize, restyleById, restyleInstruction, restyleLook, restylePrompt, swapPrompt } = catalog;
  assert.equal(src.split('const size = mirrorSize(clip?.w ?? 0, clip?.h ?? 0, res);').length - 1, 2, 'MirrorEdit.tsx Restyle / Swap size rule moved');
  for (const c of [
    { name: 'restyle watercolor, depth, 720p', clip: { seconds: 9.7, w: 1920, h: 1080 }, style: 'watercolor', text: '', control: 'depth', strength: 0.9, audio: false, count: 1, res: '720p' },
    { name: 'restyle own look only, edges, portrait, 480p', clip: { seconds: 14, w: 1080, h: 1920 }, style: null, text: 'a 1930s rubber-hose cartoon', control: 'edges', strength: 0.7, audio: true, count: 2, res: '480p' },
    { name: 'restyle style + words', clip: { seconds: 3.2, w: 0, h: 0 }, style: RESTYLE_STYLES[5].id, text: 'warm autumn colors', control: 'depth', strength: 1, audio: false, count: 1, res: '720p' },
  ] as const) {
    const clip = { token: 'src.mp4', url: '', name: 'c', ...c.clip };
    const seconds = expr(reSec, { clip });
    const size = mirrorSize(clip.w, clip.h, c.res);
    const look = restyleLook(c.style, c.text);
    const oracle = run(`${reBody}\nreturn body;`, { style: c.style, text: c.text, control: c.control, clip, look, size, seconds, strength: c.strength, audio: c.audio, count: c.count, restyleById, restyleInstruction, restylePrompt });
    same(c.name, restyleBody({ sourceVideo: clip.token, clip: c.clip, style: c.style, text: c.text, control: c.control, strength: c.strength, audio: c.audio, count: c.count, res: c.res }), oracle);
  }
  for (const c of [
    { name: 'swap words only, 720p', clip: { seconds: 12, w: 1280, h: 704 }, target: ' the red car ', replacement: 'a white horse', reference: null, point: null, count: 1, res: '720p' },
    { name: 'swap click + picture, 480p', clip: { seconds: 3.5, w: 1080, h: 1920 }, target: 'the mug', replacement: '', reference: 'ref.png', point: { x: 0.4, y: 0.6 }, count: 2, res: '480p' },
  ] as const) {
    const clip = { token: 'src.mp4', url: '', name: 'c', ...c.clip };
    const seconds = expr(swSec, { clip, SWAP_MAX_SECONDS });
    const size = mirrorSize(clip.w, clip.h, c.res);
    const oracle = run(`${swBody}\nreturn body;`, { replacement: c.replacement, target: c.target, point: c.point, reference: c.reference, clip, size, seconds, count: c.count, swapPrompt });
    same(c.name, swapBody({ sourceVideo: clip.token, clip: c.clip, target: c.target, point: c.point ?? undefined, replacement: c.replacement, reference: c.reference ?? undefined, count: c.count, res: c.res }), oracle);
  }
}

// ---------- Stage.tsx ----------
{
  const src = page('Stage.tsx');
  const bodySrc = between(src, "const body = {\n        kind: 'stage', ", ";\n      const r = await api.generate(body);\n      toast(look ?");
  assert.ok(src.includes('const size = stageSize(scene.aspect, res);'), 'Stage.tsx size rule moved');
  assert.ok(src.includes('const ls = lookSize(scene.aspect);'), 'Stage.tsx look size rule moved');
  assert.ok(src.includes('const frames = stageFrames(scene.seconds);'), 'Stage.tsx frame count rule moved');
  const stage = await import('../src/stage.ts');
  const base = stage.defaultScene();
  const tall = stage.cleanStageScene({ ...base, aspect: '9:16', seconds: 4, lens: 24, keys: stage.orbit(base.keys[0], 40) });
  // Three hand-timed keys and a prop that moves for part of the shot, as the page saves them.
  const keyed = stage.cleanStageScene({
    ...base, move: 'custom', seconds: 3,
    keys: [{ ...base.keys[0], t: 0 }, { pos: [2.5, 1.8, 5], target: [0, 1.1, 0], t: 0.25 }, { ...base.keys[1], t: 1 }],
    props: base.props.map((p, i) => (i === 0 ? { ...p, to: [1.5, 0, 0.5], span: [0.2, 0.7] } : p)),
  });
  assert.deepEqual(stage.cleanStageScene(JSON.parse(JSON.stringify(keyed))), keyed, 'a timed scene does not survive a save and reload');
  for (const ease of ['smooth', 'linear'] as const) {
    const sc = { ...keyed, ease };
    stage.keyTimes(sc).forEach((kt, i) => {
      const c = stage.cameraAt(sc, kt);
      assert.ok(Math.hypot(...c.pos.map((v, j) => v - sc.keys[i].pos[j]) as [number, number, number]) < 1e-6, `${ease}: the camera misses key ${i + 1} at its time`);
    });
    // Untimed keys and the same keys with their implied times draw the same path.
    const even = { ...stage.defaultScene(), keys: stage.orbit(base.keys[0], 40), ease };
    const written = { ...even, keys: stage.timedKeys(even) };
    for (const u of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
      const a = stage.cameraAt(even, u).pos, b = stage.cameraAt(written, u).pos;
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-3, `${ease}: writing out key times moves the camera at t=${u}`);
    }
  }
  assert.deepEqual(stage.propAt(keyed.props[0], 0.1), keyed.props[0].pos, 'a prop moves before its span starts');
  assert.deepEqual(stage.propAt(keyed.props[0], 0.9), keyed.props[0].to, 'a prop is not at its end after its span');
  assert.throws(() => stage.cleanStageScene({ ...keyed, keys: [{ pos: keyed.keys[0].pos, target: keyed.keys[0].target }, keyed.keys[1], keyed.keys[2]] }), /time/, 'mixed timed and untimed keys must be refused');
  assert.throws(() => stage.cleanStageScene({ ...keyed, keys: [keyed.keys[0], { ...keyed.keys[1], t: 1.2 }, keyed.keys[2]] }), /rise/, 'key times out of order must be refused');
  // Stage sizes per tier: 480p is the measured fast size, 720p tierSize on 64, capped at 720p; the look frame is tier-free.
  assert.deepEqual(stage.stageSize('16:9', '480p'), { w: 768, h: 448 }, 'Stage 480p moved off its measured size');
  assert.deepEqual(stage.stageSize('16:9', '720p'), { w: 1280, h: 704 }, 'Stage 720p is not 1280x704');
  assert.deepEqual(stage.stageSize('16:9', '1080p'), stage.stageSize('16:9', '720p'), 'Stage must cap at 720p');
  for (const asp of ['16:9', '9:16', '1:1'] as const) for (const t of ['480p', '720p'] as const) {
    const z = stage.stageSize(asp, t);
    assert.ok(z.w % 64 === 0 && z.h % 64 === 0, `Stage ${asp} ${t} is not 64-aligned`);
  }
  assert.equal(stage.stageTier('final'), '720p'); assert.equal(stage.stageTier('draft'), '480p'); assert.equal(stage.stageTier('1080p'), '720p');
  const blocking = { clayVideo: 'asset:00000000-0000-0000-0000-000000000001', depthVideo: 'asset:00000000-0000-0000-0000-000000000002', depthImage: 'asset:00000000-0000-0000-0000-000000000003', clayImage: 'asset:00000000-0000-0000-0000-000000000004' };
  for (const c of [
    { name: 'stage 480p, page blocking, no look (made first)', scene: base, prompt: 'A rainy alley at night', res: '480p', lookEngine: 'depth', look: null, count: 1, b: blocking },
    { name: 'stage 720p, portrait orbit, own look frame', scene: tall, prompt: '', res: '720p', lookEngine: 'edit', look: { token: 'asset:00000000-0000-0000-0000-00000000000a', take: 12 }, count: 2, b: blocking },
    { name: 'stage from an agent: scene only, the server draws it', scene: base, prompt: 'A desert outpost at noon', res: '480p', lookEngine: 'depth', look: null, count: 1, b: {} },
    { name: 'stage with three timed keys and a timed prop move', scene: keyed, prompt: 'A ferry deck at dawn', res: '480p', lookEngine: 'depth', look: { token: 'asset:00000000-0000-0000-0000-00000000000b' }, count: 1, b: blocking },
  ] as const) {
    const size = stage.stageSize(c.scene.aspect, c.res);
    const ls = stage.lookSize(c.scene.aspect);
    const frames = stage.stageFrames(c.scene.seconds);
    const oracle = expr(`{\n        kind: 'stage', ${bodySrc}`, { prompt: c.prompt, scene: c.scene, res: c.res, lookEngine: c.lookEngine, b: c.b, look: c.look, ls, size, frames, count: c.count, describeScene: stage.describeScene });
    const mine = stageBody({ scene: c.scene, prompt: c.prompt, res: c.res, lookEngine: c.lookEngine, look: c.look ?? undefined, count: c.count, blocking: c.b });
    same(c.name, mine, oracle);
  }
  const viewer = readFileSync(join(ROOT, 'src/Viewer.tsx'), 'utf8');
  assert.ok(viewer.includes('navigate(`/stage?take=${take.id}`)'), 'Viewer.tsx Open in Stage no longer opens /stage?take=<id>');
  assert.ok(src.includes("const fromTake = Number(params.get('take')) || null;"), 'Stage.tsx no longer reads ?take=');
  assert.ok(viewer.includes('navigate(`/stage?look=${take.id}`)') && src.includes("Number(params.get('look'))"), 'Use as Stage look frame: Viewer and Stage.tsx disagree on /stage?look=<id>');
  assert.ok(viewer.includes('navigate(`/stage?prop=${take.id}`)') && src.includes("Number(params.get('prop'))"), 'Use in Stage: Viewer and Stage.tsx disagree on /stage?prop=<id>');
  passed++;
  console.log('ok  viewer Open in Stage deep-links /stage?take=<id>, which the page reads');
}

// ---------- Object.tsx (image to 3D) ----------
{
  const src = page('Object.tsx');
  // The page's first generate call is its Remove background preview; the object body is in go().
  const bodySrc = between(src.slice(src.indexOf('async function go()')), 'const r = await api.generate(', ');\n      setSelected(');
  for (const c of [
    { name: 'object from a take, draft, cutout', source: { token: 'asset:t', kind: 'image', name: 'take 62', w: 1024, h: 1024, seconds: 0, takeId: 62, prompt: 'Product photo of a matte teal enamel stovetop kettle with a curved wooden handle' }, quality: 'draft', cutout: true, count: 1 },
    { name: 'object from a dropped file, high, own alpha, 3 takes', source: { token: 'asset:f', kind: 'image', name: 'chair cutout', w: 900, h: 1200, seconds: 0 }, quality: 'quality', cutout: false, count: 3 },
  ] as const) {
    // MCP has no cutout preview: the page with none showing.
    const oracle = expr(bodySrc, { source: c.source, quality: c.quality, cutout: c.cutout, count: c.count, usingCut: false, cut: undefined });
    same(c.name, objectBody(c as any), oracle);
  }
  assert.throws(() => objectBody({ source: { token: 'x', kind: 'video', name: 'v', w: 1, h: 1, seconds: 3 }, quality: 'draft', cutout: true, count: 1 }), /needs a still/);
  const viewer = readFileSync(join(ROOT, 'src/Viewer.tsx'), 'utf8');
  assert.ok(viewer.includes('navigate(`/object?take=${take.id}`)'), 'Viewer.tsx Make 3D no longer opens /object?take=<id>');
  assert.ok(src.includes("useTakeParam(params.get('take'),"), 'Object.tsx no longer reads ?take=');
  passed++;
  console.log('ok  viewer Make 3D deep-links /object?take=<id>, which the page reads');
}

// ---------- Viewer.tsx (upscale + continue actions) ----------
{
  const src = readFileSync(join(ROOT, 'src/Viewer.tsx'), 'utf8');
  assert.ok(src.includes('navigate(`/upscale?take=${take.id}`)'), 'Viewer.tsx Upscale no longer opens /upscale?take=<id>');
  const app = readFileSync(join(ROOT, 'src/pages/Upscale.tsx'), 'utf8');
  assert.ok(app.includes("const deepTake = Number(params.get('take')) || null;"), 'Upscale.tsx no longer reads ?take=');
  passed++;
  console.log('ok  viewer Upscale deep-links /upscale?take=<id>, which the page reads');
  for (const route of ['/extend?take=', '/extend?mode=transition&take=', '/speak?take=', '/speak?mode=sound&take=']) {
    assert.ok(src.includes(`navigate(\`${route}\${take.id}\`)`), `Viewer.tsx no longer hands off to ${route}`);
  }
  passed++;
  console.log('ok  continue-actions hand off to Extend, Transition, Speak, Add sound (Viewer.tsx)');
  assert.ok(src.includes('navigate(`/edit?take=${take.id}`)'), 'Viewer.tsx Edit... no longer opens /edit?take=<id>');
  const edit = readFileSync(join(ROOT, 'src/pages/Edit.tsx'), 'utf8');
  assert.ok(edit.includes("const fromTake = Number(params.get('take')) || null;"), 'Edit.tsx no longer reads ?take=');
  passed++;
  console.log('ok  viewer Edit... deep-links /edit?take=<id>, which the page reads');
  const hdr = between(src, 'export async function finishHdr(t: Take) {\n  await api.generate(', ');\n  toast(\'Finishing in HDR');
  same('viewer Finish in HDR', hdrBody(7), expr(hdr, { t: { id: 7 } }));
  assert.ok(src.includes("const r = await api.fixSeam(t.id, 'auto');"), 'Viewer.tsx Improve the seam no longer asks for the auto strategy');
  const apiSrc = readFileSync(join(ROOT, 'src/api.ts'), 'utf8');
  assert.ok(apiSrc.includes("`/api/takes/${id}/fix-seam`, { method: 'POST', body: JSON.stringify({ strategy }) }"), 'src/api.ts fixSeam body moved');
  same('viewer Improve the seam', fixSeamBody('auto'), expr('{ strategy }', { strategy: 'auto' }));
}

console.log(`\n${passed} parity checks passed`);
