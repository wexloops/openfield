/**
 * Write every app's ComfyUI workflow to workflows/<app>-<variant>.json, in
 * ComfyUI's API format, by calling the same graph builders the server runs.
 *
 *   npm run workflows
 *
 * Params are representative defaults (720p-class frames, the default render
 * size on a 24 GB card (src/renderTier.ts), the app's own default length,
 * seed 42). Inputs the user would supply are plain placeholder filenames
 * (input_start.png, input_video.mp4 ...) in place of OpenField's asset
 * tokens: put files with those names in ComfyUI's input/ folder, or pick your
 * own in the loader node, then queue. Each file loads by dropping it onto the
 * ComfyUI canvas. Re-run after changing a builder; the output is deterministic.
 * workflows/README.md is generated alongside, from the graphs themselves.
 * The files always name the stock LTX-2.5 weights, even when this machine's
 * .env sets OPENFIELD_LTX25_* (server/graphs/ltxfiles.ts).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../server/config.js';
import { buildLtx25Graph, snapFrames } from '../server/graphs/ltx25.js';
import { applyPost, buildCutGraph, buildPlannerGraph, PLANNER_SYSTEM } from '../server/graphs/director.js';
import { buildStillsGraph } from '../server/graphs/stills.js';
import { EDIT_ANGLES_LORA, EDIT_LIGHTNING_2509, buildEditGraph, editSize, expandLayout } from '../server/graphs/edit.js';
import { editVariants } from '../src/catalog.js';
import { buildMirrorGraph, type MirrorControl } from '../server/graphs/mirror.js';
import { buildReshootGraph, buildReshootWarpPreviewGraph } from '../server/graphs/reshoot.js';
import { buildDreamGraph, buildRedrawGraph, buildSharpenGraph, redrawBatch } from '../server/graphs/upscale.js';
import { buildH3Graph, snapH3Length } from '../server/graphs/h3.js';
import { buildLtxGraph } from '../server/graphs/ltx.js';
import { EFFECTS, effectPrompt } from '../src/effects.js';
import { buildExtendGraph, buildSoundGraph, buildSpeakGraph, buildTransitionGraph } from '../server/graphs/ltxtools.js';
import { buildCastVideoGraph, ingredientsPrompt, sheetLayout, type SheetMember } from '../server/graphs/cast.js';
import { CONTINUE_PROMPT, DIRECTOR_MOVES, SCENE_FRAMINGS, SOUND_PROMPT, SPEAK_PROMPT, TRANSITION_STYLES, eraGrade, restyleInstruction, restyleLook, restylePrompt, swapPrompt } from '../src/catalog.js';
import { buildSeamBridgeGraph, buildSeamRegenGraph, buildSeamTrimGraph } from '../server/graphs/seam.js';
import { buildHdrGraph } from '../server/graphs/hdr.js';
import { buildStageLookGraph, buildStageShotGraph, lookEditInstruction, lookPrompt } from '../server/graphs/stage.js';
import { lookSize, stageSize } from '../src/stage.js';
import { buildTrellisGraph } from '../server/graphs/trellis.js';
import { planBridge, planRegen } from '../server/seam.js';
import { buildCutoutStillGraph, buildCutoutVideoGraph } from '../server/graphs/cutout.js';
import { buildRestyleGraph, buildSwapGraph } from '../server/graphs/restyle.js';
import { clearLtx25Overrides } from '../server/graphs/ltxfiles.js';

export const OUT = join(ROOT, 'workflows');
const SEED = 42;
const STAGE_CLAY = stageSize('16:9', '720p');
const STAGE_LOOK = lookSize('16:9');

// Placeholder inputs. Each is what a LoadImage / VHS_LoadVideo widget reads.
const IN = {
  start: 'input_start.png',
  end: 'input_end.png',
  frame: 'input_first_frame.png',
  video: 'input_video.mp4',
  still: 'input_still.png',
  video2: 'input_video_2.mp4',
  audio: 'input_audio.wav',
  ref1: 'input_ref_1.png',
  ref2: 'input_ref_2.png',
  edit: 'input_image.png',
  cast1: 'input_cast_face.png',
  cast2: 'input_cast_three_quarter.png',
  cast3: 'input_cast_full_body.png',
  castPlace: 'input_cast_place.png',
  mask: 'input_mask.png',
  background: 'input_background.png',
  object: 'input_object.png',
  clay: 'input_clay.mp4',
  depth: 'input_depth.png',
  clayFrame: 'input_clay_frame.png',
  look: 'input_look.png',
};

const PROMPT = 'An old lighthouse keeper in a yellow raincoat on a stormy pier, waves breaking behind him.';
const STILL = 'A lighthouse on black rocks at dusk, storm clouds, one warm window lit, wet stone.';
// What the Director app compiles from its picks (camera, framing, light, stock, grade).
const DIRECTOR =
  'A lighthouse keeper on a stormy pier. Medium close-up, 35mm lens, low angle. ' +
  'Hard side light from a single lamp, deep shadows. Shot on Kodak Vision3 500T, ' +
  'fine grain, 1970s, teal and amber grade.';
const CAST_NOTES = 'a woman in her forties with a black bob with one silver streak, round tortoiseshell glasses, a rust corduroy jacket over a teal sweater';
const STAGE = 'A woman in a long dark coat in a rain-soaked night alley between a wooden crate and a concrete pillar, neon on wet stone.';
const MIRROR = 'A knight in dented steel armor in a torch-lit stone hall, same movement and timing.';

export interface Entry {
  file: string;
  app: string;
  build: () => Record<string, unknown>;
}

const mirror = (control: MirrorControl): Entry => ({
  file: `mirror-${control}`,
  app: 'Mirror',
  build: () => buildMirrorGraph({
    prompt: MIRROR, sourceVideo: IN.video, firstFrame: IN.frame,
    width: 1280, height: 704, seconds: 5, seed: SEED, control,
  }),
});

/** One workflow per effect, built the way server/index.ts buildEffectGraph does. */
const effect = (id: string): Entry => {
  const fx = EFFECTS.find((e) => e.id === id)!;
  const lora = { file: fx.lora, strength: fx.strength, trigger: fx.trigger };
  return {
    file: `effect-${fx.id}`,
    app: `Effects (${fx.name})`,
    build: () => buildLtx25Graph({
      prompt: effectPrompt(fx, ''), negative: fx.negative, width: 1280, height: 704,
      seconds: Math.min(4, fx.maxSeconds), seed: SEED,
      ...(fx.input === 'clip'
        ? { icLora: { ...lora, video: IN.video } }
        : { loras: [lora], startImage: IN.start, endImage: fx.loopable ? IN.start : undefined }),
      filenamePrefix: `openfield/effect_${fx.id}`,
    }),
  };
};

const reshootCommon = {
  sourceVideo: IN.video, width: 864, height: 480, seconds: 4,
  azimuth: 30, elevation: 10, pivotDepth: 1.05,
};

/** The Edit app: free edit (quality, draft, masked, three images) and one representative take per image app. */
function editEntries(): Entry[] {
  const out = editSize(1344, 768);
  const base = { images: [IN.edit], width: out.width, height: out.height, seed: SEED, lightning: EDIT_LIGHTNING_2509 };
  const one = (mode: Parameters<typeof editVariants>[0], chips: string[] = [], direction?: string) =>
    editVariants(mode, { text: '', chips, direction, count: 1 })[0].instruction;
  const free = 'Make it a snowy winter night, the lighthouse beam visible through falling snow.';
  const lay = expandLayout(1344, 768, 9 / 16, 0.8);
  return [
    { file: 'edit-free', app: 'Edit', build: () => buildEditGraph({ ...base, quality: 'quality', instruction: free }) },
    { file: 'edit-free-draft', app: 'Edit (draft)', build: () => buildEditGraph({ ...base, quality: 'draft', instruction: free }) },
    { file: 'edit-mask', app: 'Edit (painted mask)', build: () => buildEditGraph({ ...base, quality: 'draft', instruction: 'Replace the sky with a clear starry night.', mask: IN.mask }) },
    {
      file: 'edit-three-images', app: 'Edit (more images)',
      build: () => buildEditGraph({ ...base, images: [IN.edit, IN.ref1, IN.ref2], quality: 'draft', instruction: 'Put the person from image 2, wearing the coat from image 3, on the cliff in image 1.' }),
    },
    { file: 'edit-angle', app: 'New angle', build: () => buildEditGraph({ ...base, quality: 'draft', loras: [{ name: EDIT_ANGLES_LORA, strength: 1 }], instruction: one('angle', ['left-45']) }) },
    { file: 'edit-coverage', app: 'Coverage', build: () => buildEditGraph({ ...base, quality: 'draft', instruction: one('coverage', ['close']) }) },
    { file: 'edit-pushin', app: 'Push in', build: () => buildEditGraph({ ...base, quality: 'draft', loras: [{ name: EDIT_ANGLES_LORA, strength: 1 }], instruction: one('pushin', ['x4']) }) },
    { file: 'edit-next', app: 'Next beat', build: () => buildEditGraph({ ...base, quality: 'draft', instruction: one('next', ['later']) }) },
    { file: 'edit-relight', app: 'Relight', build: () => buildEditGraph({ ...base, quality: 'draft', instruction: one('relight', ['moon'], 'left') }) },
    {
      file: 'edit-expand', app: 'Expand',
      build: () => buildEditGraph({ ...base, quality: 'draft', width: lay.width, height: lay.height, pad: lay.pad, instruction: one('expand') }),
    },
  ];
}

/** Remove background (stills and clips), Restyle and Object swap. */
function cutoutEntries(): Entry[] {
  const clip = { sourceVideo: IN.video, width: 1280, height: 704, frames: 120, fps: 24, subject: 'person' };
  const look = restyleLook('watercolor', '');
  return [
    { file: 'cutout-still', app: 'Remove background (still, transparent PNG)', build: () => buildCutoutStillGraph({ image: IN.still, width: 1344, height: 768, background: 'transparent' }) },
    { file: 'cutout-still-blur', app: 'Remove background (still, blurred background)', build: () => buildCutoutStillGraph({ image: IN.still, width: 1344, height: 768, background: 'blur' }) },
    { file: 'cutout-still-picture', app: 'Remove background (still, new picture behind)', build: () => buildCutoutStillGraph({ image: IN.still, width: 1344, height: 768, background: 'image', backgroundImage: IN.background }) },
    { file: 'cutout-video-steady', app: 'Remove background (clip, steady, ProRes 4444 with alpha)', build: () => buildCutoutVideoGraph({ ...clip, method: 'hybrid', background: 'transparent' }) },
    { file: 'cutout-video-matte', app: 'Remove background (clip, soft matte, ProRes 4444 with alpha)', build: () => buildCutoutVideoGraph({ ...clip, method: 'matte', background: 'transparent' }) },
    { file: 'cutout-video-tracked-color', app: 'Remove background (clip, tracked, over a color)', build: () => buildCutoutVideoGraph({ ...clip, method: 'track', background: 'color', color: '#00b140' }) },
    {
      file: 'mirror-restyle', app: 'Mirror > Restyle',
      build: () => buildRestyleGraph({
        sourceVideo: IN.video, instruction: restyleInstruction(look), prompt: restylePrompt(look), width: 1280, height: 704, seconds: 5, seed: SEED,
        control: 'depth', guideStrength: 0.9, lightning: EDIT_LIGHTNING_2509,
      }),
    },
    {
      file: 'mirror-swap', app: 'Mirror > Object swap (experimental)',
      build: () => buildSwapGraph({
        sourceVideo: IN.video, target: 'the red car', replacement: 'a white horse at full gallop', reference: IN.object,
        prompt: swapPrompt('a white horse at full gallop'), width: 1280, height: 704, seconds: 4, seed: SEED, lightning: EDIT_LIGHTNING_2509,
      }),
    },
  ];
}

export const ENTRIES: Entry[] = [
  // ---- Video (LTX-2.5) ----
  {
    file: 'video-t2v', app: 'Video',
    build: () => buildLtx25Graph({ prompt: PROMPT, width: 1280, height: 704, seconds: 5, seed: SEED }),
  },
  {
    file: 'video-i2v', app: 'Video, Image > Animate',
    build: () => buildLtx25Graph({ prompt: PROMPT, width: 1280, height: 704, seconds: 5, seed: SEED, startImage: IN.start }),
  },
  {
    file: 'video-flf2v', app: 'Video (start + end frame)',
    build: () => buildLtx25Graph({
      prompt: PROMPT, width: 1280, height: 704, seconds: 5, seed: SEED, startImage: IN.start, endImage: IN.end,
    }),
  },
  {
    // Same file as first and last frame: the model closes the loop itself.
    file: 'video-loop', app: 'Seamless Loop, Image > Make a loop',
    build: () => buildLtx25Graph({
      prompt: PROMPT, width: 1280, height: 704, seconds: 5, seed: SEED, startImage: IN.start, endImage: IN.start,
    }),
  },

  // ---- Cast (@mentions) ----
  // What a mention of a character with three pictures compiles to (server/cast.ts).
  {
    file: 'cast-still', app: 'Image / Director frame with @cast (Qwen-Image-Edit 2509 compose)',
    build: () => buildEditGraph({
      images: [IN.cast1, IN.cast2, IN.cast3], width: 1328, height: 752, seed: SEED, quality: 'quality', compose: true,
      instruction: `Mara (the person shown in images 1 to 3: ${CAST_NOTES}) walks along a stormy pier at dusk, a lantern in her hand. ` +
        "Keep Mara's face, hair, build and clothing exactly as in the reference. Make one new, natural photograph of this scene with its own camera angle and lighting. Do not copy the reference backgrounds or lay the references side by side.",
    }),
  },
  {
    file: 'cast-video', app: 'Video / Director shot with @cast (LTX-2.5 Ingredients IC-LoRA, reference sheet)',
    build: () => {
      const members: SheetMember[] = [
        { name: 'Mara', kind: 'character', notes: CAST_NOTES, images: [IN.cast1, IN.cast2, IN.cast3] },
        { name: 'The pier', kind: 'place', notes: 'a long wooden pier in a storm, waves breaking over the rail', images: [IN.castPlace] },
      ];
      const layout = sheetLayout(members, 768, 448);
      return buildCastVideoGraph({
        prompt: ingredientsPrompt(members, layout, `Mara (${CAST_NOTES}) walks along the pier toward the camera, a lantern swinging in her hand, rain driving sideways.`),
        layout, seconds: 5, seed: SEED,
      });
    },
  },

  // ---- Image ----
  {
    file: 'image-qwen', app: 'Image',
    build: () => buildStillsGraph({ model: 'qwen', quality: 'quality', prompt: STILL, width: 1328, height: 752, seed: SEED }),
  },
  {
    file: 'image-qwen-draft', app: 'Image (draft)',
    build: () => buildStillsGraph({ model: 'qwen', quality: 'draft', prompt: STILL, width: 1328, height: 752, seed: SEED }),
  },
  {
    file: 'image-flux2', app: 'Image',
    build: () => buildStillsGraph({ model: 'flux2', quality: 'quality', prompt: STILL, width: 1328, height: 752, seed: SEED }),
  },
  {
    file: 'image-flux2-draft', app: 'Image (draft)',
    build: () => buildStillsGraph({ model: 'flux2', quality: 'draft', prompt: STILL, width: 1328, height: 752, seed: SEED }),
  },

  // ---- Edit + image apps (Qwen-Image-Edit 2509). The source is a 1344x768 still. ----
  ...editEntries(),
  ...cutoutEntries(),

  // ---- Director: hero frame, then the shot from it ----
  {
    file: 'director-frame-qwen', app: 'Director (frame)',
    build: () => buildStillsGraph({ model: 'qwen', quality: 'quality', prompt: DIRECTOR, width: 1328, height: 752, seed: SEED }),
  },
  {
    file: 'director-frame-flux2', app: 'Director (frame)',
    build: () => buildStillsGraph({ model: 'flux2', quality: 'quality', prompt: DIRECTOR, width: 1328, height: 752, seed: SEED }),
  },
  {
    file: 'director-shot', app: 'Director (shot)',
    build: () => buildLtx25Graph({ prompt: DIRECTOR, width: 1280, height: 704, seconds: 5, seed: SEED, startImage: IN.start }),
  },

  {
    file: 'director-frame-era', app: 'Director (frame, era 1974 graded)',
    build: () => {
      const g = buildStillsGraph({ model: 'qwen', quality: 'quality', prompt: DIRECTOR, width: 1328, height: 752, seed: SEED });
      applyPost(g as Record<string, any>, { grade: eraGrade(1974) });
      return g;
    },
  },
  {
    file: 'director-shot-era-ramp', app: 'Director (shot, era 1962 graded, bullet time)',
    build: () => {
      const g = buildLtx25Graph({ prompt: DIRECTOR, width: 1280, height: 704, seconds: 5, seed: SEED, startImage: IN.start });
      applyPost(g as Record<string, any>, { grade: eraGrade(1962), ramp: 'bullet', frames: snapFrames(5) });
      return g;
    },
  },
  {
    file: 'director-plan', app: 'Director (scene: shot list from the local LLM)',
    build: () => buildPlannerGraph({
      scene: 'A lighthouse keeper climbs the stairs with a lantern as the storm hits. At the top he sees a ship breaking apart on the rocks.',
      system: PLANNER_SYSTEM({ min: 2, max: 4 }, SCENE_FRAMINGS.map((f) => f.id), DIRECTOR_MOVES.map((m) => m.id)), seed: SEED,
    }),
  },
  {
    file: 'director-cut', app: 'Director (scene: shots cut together)',
    build: () => buildCutGraph({
      clips: [
        { file: 'input_shot_1.mp4', frames: 73, hasAudio: false },
        { file: 'input_shot_2.mp4', frames: 73, hasAudio: false },
        { file: 'input_shot_3.mp4', frames: 109, hasAudio: false },
      ],
      width: 1280, height: 704,
    }),
  },

  // ---- Mirror ----
  mirror('pose'),
  mirror('depth'),
  mirror('edges'),

  // ---- Reshoot ----
  {
    file: 'reshoot-preview', app: 'Reshoot (warp preview)',
    build: () => buildReshootWarpPreviewGraph(reshootCommon),
  },
  {
    file: 'reshoot-render', app: 'Reshoot',
    build: () => buildReshootGraph({ ...reshootCommon, prompt: '', seed: SEED }),
  },
  {
    file: 'reshoot-render-move', app: 'Reshoot (camera move)',
    build: () => buildReshootGraph({
      ...reshootCommon, prompt: '', seed: SEED,
      keyframes: [{ f: 1, az: 0, el: 0 }, { f: 96, az: 30, el: 10 }],
    }),
  },

  // ---- Effects ----
  ...EFFECTS.map((e) => effect(e.id)),

  // ---- Extend, Transitions, Speak, Add sound (LTX-2.5) ----
  // Clip inputs are assumed 5 s at 24 fps (120 frames) and 1280x704, like a
  // default Video take. Change frame_load_cap on the loader for another length.
  {
    file: 'extend-forward', app: 'Extend',
    build: () => buildExtendGraph({
      prompt: CONTINUE_PROMPT, sourceVideo: IN.video, sourceFrames: 120, sourceHasAudio: true, withAudio: true,
      width: 1280, height: 704, seconds: 3, direction: 'forward', seed: SEED,
    }),
  },
  {
    file: 'extend-backward', app: 'Extend (lead-in)',
    build: () => buildExtendGraph({
      prompt: CONTINUE_PROMPT, sourceVideo: IN.video, sourceFrames: 120, sourceHasAudio: true, withAudio: true,
      width: 1280, height: 704, seconds: 3, direction: 'backward', seed: SEED,
    }),
  },
  {
    file: 'transition-clips', app: 'Transitions (clip to clip)',
    build: () => buildTransitionGraph({
      prompt: TRANSITION_STYLES[0].text, seed: SEED, width: 1280, height: 704, seconds: 2, withAudio: true,
      a: { file: IN.video, kind: 'video', frames: 120, hasAudio: true }, b: { file: IN.video2, kind: 'video', frames: 120, hasAudio: true },
    }),
  },
  {
    file: 'transition-stills', app: 'Transitions (still to still)',
    build: () => buildTransitionGraph({
      prompt: TRANSITION_STYLES[1].text, seed: SEED, width: 1280, height: 704, seconds: 2,
      a: { file: IN.start, kind: 'image' }, b: { file: IN.end, kind: 'image' },
    }),
  },
  {
    file: 'speak', app: 'Speak (audio to video)',
    build: () => buildSpeakGraph({ prompt: SPEAK_PROMPT, image: IN.start, audio: IN.audio, seconds: 5, width: 1280, height: 704, seed: SEED }),
  },
  {
    file: 'add-sound', app: 'Add sound (video to audio)',
    build: () => buildSoundGraph({ prompt: SOUND_PROMPT, sourceVideo: IN.video, sourceFrames: 120, width: 768, height: 416, seed: SEED }),
  },

  // ---- Upscale (832x448 3 s source, the size of a 480p take) ----
  {
    file: 'upscale-sharpen', app: 'Upscale > Sharpen',
    build: () => buildSharpenGraph({ source: { kind: 'video', file: IN.video, withAudio: true, fps: 24 }, model: 'esrgan', scale: 2, rife: false }),
  },
  {
    file: 'upscale-sharpen-still', app: 'Upscale > Sharpen (still)',
    build: () => buildSharpenGraph({ source: { kind: 'image', file: IN.still }, model: 'esrgan', scale: 2, rife: false }),
  },
  {
    file: 'upscale-redraw', app: 'Upscale > Redraw',
    build: () => buildRedrawGraph({
      source: { kind: 'video', file: IN.video, withAudio: true, fps: 24 }, model: '3b',
      resolution: 1034, maxResolution: 1920, batchSize: redrawBatch(73, 33), color: 'lab', seed: SEED,
    }),
  },
  {
    file: 'upscale-redraw-still', app: 'Upscale > Redraw (still)',
    build: () => buildRedrawGraph({
      source: { kind: 'image', file: IN.still }, model: '3b', resolution: 1080, maxResolution: 1920, batchSize: 1, color: 'lab', seed: SEED,
    }),
  },
  {
    file: 'upscale-dream', app: 'Upscale > Dream',
    build: () => buildDreamGraph({
      source: { kind: 'video', file: IN.video, withAudio: true, fps: 24 },
      prompt: 'Wet stone, embers and fine sparks in sharp detail.', creativity: 0.5, width: 1664, height: 896, frames: 73, seed: SEED,
    }),
  },

  // ---- Finishing: Seam Doctor, HDR ----
  {
    // A 5 s loop at 832x448. The app measures the clip and picks the window; these are example numbers.
    file: 'seam-trim', app: 'Improve the seam (trim)',
    build: () => buildSeamTrimGraph({ video: IN.video, start: 6, frames: 104, fps: 24 }),
  },
  {
    file: 'seam-regen', app: 'Improve the seam (re-render across the wrap)',
    build: () => buildSeamRegenGraph({
      video: IN.video, n: 121, ...planRegen(121), width: 832, height: 448, fps: 24, seed: SEED, prompt: PROMPT, sigma: 0.65,
    }),
  },
  {
    file: 'seam-bridge', app: 'Improve the seam (first/last bridge, manual)',
    build: () => {
      const plan = planBridge(121, 24);
      return buildSeamBridgeGraph({
        video: IN.video, n: 121, anchorA: plan.anchorA, anchorB: plan.anchorB, bridgeFrames: plan.bridgeFrames,
        width: 832, height: 448, fps: 24, seed: SEED, prompt: PROMPT,
      });
    },
  },
  {
    file: 'finish-hdr', app: 'Finish in HDR',
    build: () => buildHdrGraph({ video: IN.video, frames: 121, seed: SEED, tag: 'example', withAudio: true }),
  },
  {
    file: 'finish-hdr-loop-pad', app: 'Finish in HDR (a 120-frame loop, padded to 121 with its own head)',
    build: () => buildHdrGraph({ video: IN.video, frames: 120, loop: true, seed: SEED, tag: 'example' }),
  },
  {
    file: 'object-draft', app: 'Object (image to 3D, Draft): GLB + turntable',
    build: () => buildTrellisGraph({ image: IN.object, seed: SEED, quality: 'draft', removeBackground: true }),
  },
  {
    file: 'object-high', app: 'Object (image to 3D, High): GLB with normal and AO maps + turntable',
    build: () => buildTrellisGraph({ image: IN.object, seed: SEED, quality: 'quality', removeBackground: true }),
  },
  {
    file: 'object-own-alpha', app: "Object from a cut-out PNG (the picture's own transparency, no BiRefNet)",
    build: () => buildTrellisGraph({ image: IN.object, seed: SEED, quality: 'draft', removeBackground: false }),
  },

  // ---- Stage (720p clay, the tier-free look frame) ----
  {
    file: 'stage-look-depth', app: 'Stage look frame (Z-Image Turbo + Fun ControlNet Union on the depth pass)',
    build: () => buildStageLookGraph({ depth: IN.depth, prompt: lookPrompt(STAGE), width: STAGE_LOOK.w, height: STAGE_LOOK.h, seed: SEED }),
  },
  {
    file: 'stage-look-edit', app: 'Stage look frame (Qwen-Image-Edit on the clay frame)',
    build: () => buildEditGraph({ images: [IN.clayFrame], instruction: lookEditInstruction(STAGE), width: STAGE_LOOK.w, height: STAGE_LOOK.h, seed: SEED, quality: 'draft', lightning: EDIT_LIGHTNING_2509 }),
  },
  {
    file: 'stage-shot', app: `Stage (LTX-2.5 Layout to Render, two-stage distilled, clay ${STAGE_CLAY.w}x${STAGE_CLAY.h})`,
    build: () => buildStageShotGraph({ clay: IN.clay, height: STAGE_CLAY.h, look: IN.look, prompt: STAGE, seed: SEED }),
  },

  // ---- Opt-in engines ----
  {
    file: 'video-h3-i2v', app: 'Video (MiniMax H3, opt-in)',
    build: () => buildH3Graph({
      prompt: PROMPT, width: 864, height: 480, lengthFrames: snapH3Length(124), seed: SEED, steps: 20, startImage: IN.start,
    }),
  },
  {
    file: 'video-h3-refs', app: 'Video (MiniMax H3 references, opt-in)',
    build: () => buildH3Graph({
      prompt: PROMPT, width: 864, height: 480, lengthFrames: snapH3Length(124), seed: SEED, steps: 20,
      refImages: [IN.ref1, IN.ref2],
    }),
  },
  {
    file: 'video-ltx23-i2v', app: 'Video (LTX-2.3 legacy)',
    build: () => buildLtxGraph({
      prompt: PROMPT, width: 1280, height: 704, seconds: 5, seed: SEED,
      checkpoint: 'ltx-2.3-22b-dev-fp8.safetensors', sampling: 'distilled', startImage: IN.start,
    }),
  },
];

/** Custom node packs, by the node classes OpenField uses from them. Anything
 *  not listed here ships with ComfyUI 0.38. */
const PACKS: Record<string, { pack: string; url: string }> = {
  VHS_LoadVideo: { pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
  VHS_VideoCombine: { pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
  'RIFE VFI': { pack: 'ComfyUI-Frame-Interpolation', url: 'https://github.com/Fannovel16/ComfyUI-Frame-Interpolation' },
  DWPreprocessor: { pack: 'comfyui_controlnet_aux', url: 'https://github.com/Fannovel16/comfyui_controlnet_aux' },
  DepthAnythingV2Preprocessor: { pack: 'comfyui_controlnet_aux', url: 'https://github.com/Fannovel16/comfyui_controlnet_aux' },
  CannyEdgePreprocessor: { pack: 'comfyui_controlnet_aux', url: 'https://github.com/Fannovel16/comfyui_controlnet_aux' },
  CrossViewWarp: { pack: 'ComfyUI-CrossViewWarp', url: 'https://github.com/cseti007/ComfyUI-CrossViewWarp' },
  LTXICLoRALoaderModelOnly: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  LTXAddVideoICLoRAGuide: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  SeedVR2VideoUpscaler: { pack: 'ComfyUI-SeedVR2_VideoUpscaler', url: 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler' },
  SeedVR2LoadDiTModel: { pack: 'ComfyUI-SeedVR2_VideoUpscaler', url: 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler' },
  SeedVR2LoadVAEModel: { pack: 'ComfyUI-SeedVR2_VideoUpscaler', url: 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler' },
  ReverseImageBatch: { pack: 'ComfyUI-KJNodes', url: 'https://github.com/kijai/ComfyUI-KJNodes' },
  GetImagesFromBatchIndexed: { pack: 'ComfyUI-KJNodes', url: 'https://github.com/kijai/ComfyUI-KJNodes' },
  LTXVSetAudioVideoMaskByTime: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  LTXVSDRToHDRWorkingSpace: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  LTXVHDRDecodePostprocess: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  LTXVSaveHLG: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  LTXVVAEForceFloat32: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  LTXVLoadConditioning: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  ImageCropByMaskAndResize: { pack: 'ComfyUI-KJNodes', url: 'https://github.com/kijai/ComfyUI-KJNodes' },
  ImageUncropByMask: { pack: 'ComfyUI-KJNodes', url: 'https://github.com/kijai/ComfyUI-KJNodes' },
  LTXVInpaintPreprocess: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  LTXVDilateVideoMask: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
  LTXVLaplacianPyramidBlend: { pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
};
/** Loader widgets that name a model file. */
const MODEL_INPUTS = ['bg_removal_name', 'unet_name', 'clip_name', 'vae_name', 'lora_name', 'model_name', 'ckpt_name', 'text_encoder', 'model', 'file_name', 'name'];
/** Loader widgets that name a user input file. */
const INPUT_INPUTS = ['image', 'video', 'audio', 'file'];

function inventory(graph: Record<string, unknown>) {
  const models = new Set<string>();
  const packs = new Set<string>();
  const inputs = new Set<string>();
  for (const node of Object.values(graph) as { class_type: string; inputs: Record<string, unknown> }[]) {
    const pk = PACKS[node.class_type];
    if (pk) packs.add(`[${pk.pack}](${pk.url})`);
    for (const k of MODEL_INPUTS) if (typeof node.inputs[k] === 'string') models.add(node.inputs[k] as string);
    for (const k of INPUT_INPUTS) if (typeof node.inputs[k] === 'string') inputs.add(node.inputs[k] as string);
  }
  return { models: [...models], packs: [...packs], inputs: [...inputs] };
}

const README_HEAD = `# Workflows

Every OpenField app is a plain ComfyUI workflow. These are those workflows in
ComfyUI's API format, written by \`npm run workflows\` from the same graph
builders in [\`server/graphs/\`](../server/graphs) that the app runs. This file
is generated with them; edit \`scripts/export-workflows.ts\`, not this file.

**To run one in ComfyUI** (0.38 or newer): drag the \`.json\` file onto the
ComfyUI canvas. Put your inputs in ComfyUI's \`input/\` folder under the
placeholder names below, or pick your own file in the loader node, then queue.
Model files must match these names exactly (see [\`docs/MODELS.md\`](../docs/MODELS.md)
and \`npm run models\`). Pasting the JSON as text does not load it; ComfyUI only
accepts its own UI format that way.

Params are representative defaults (each app's default size and length, seed 42).
For the exact graph behind one of your renders, use **Download workflow** or
**Open in ComfyUI** on the take in OpenField's viewer.

`;

function writeAll(): void {
  mkdirSync(OUT, { recursive: true });
  // Drop stale exports so a renamed or removed variant does not linger.
  for (const f of readdirSync(OUT)) if (f.endsWith('.json')) rmSync(join(OUT, f));

  const rows: string[] = [];
  for (const e of ENTRIES) {
    const graph = e.build();
    const leftover = JSON.stringify(graph).match(/asset:[0-9a-f-]{36}/i);
    if (leftover) throw new Error(`${e.file}: unresolved asset token ${leftover[0]}`);
    writeFileSync(join(OUT, `${e.file}.json`), JSON.stringify(graph, null, 2) + '\n');
    console.log(`workflows/${e.file}.json  (${Object.keys(graph).length} nodes)  ${e.app}`);
    const inv = inventory(graph);
    const code = (xs: string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join('<br>') : 'none');
    rows.push(
      `| [\`${e.file}.json\`](${e.file}.json) | ${e.app} | ${code(inv.models)} | ${inv.packs.join('<br>') || 'none (core only)'} | ${code(inv.inputs)} |`,
    );
  }
  writeFileSync(
    join(OUT, 'README.md'),
    README_HEAD +
      '| File | Used by | Models | Custom nodes | Inputs |\n| --- | --- | --- | --- | --- |\n' +
      rows.join('\n') +
      '\n',
  );
  console.log(`${ENTRIES.length} workflows written`);
}

// Run as `npm run workflows`; scripts/test-ltxfiles.ts imports ENTRIES without writing anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // These files are the shared examples in the repo: always the stock LTX-2.5
  // weights, whatever this machine's .env sets (server/graphs/ltxfiles.ts).
  clearLtx25Overrides();
  writeAll();
}
