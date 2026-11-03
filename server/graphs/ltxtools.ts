/**
 * LTX-2.5 continue tools: Extend, Transition, Speak (audio to video) and
 * Add sound (video to audio). All four run on the same distilled LTX-2.5
 * weights as ./ltx25.ts, with no extra downloads.
 *
 * The shared trick is the AV noise mask. LTX-2.5 denoises one concatenated
 * audio + video latent, and every token can carry its own denoise strength
 * (that is how LTXVImgToVideoInplace pins a start frame). Encode real frames
 * or real audio into the latent, mark them 0 (frozen), mark the rest 1, and
 * the model fills in only what is missing, in context:
 *
 *   Extend      the last second of a clip is frozen at the start of the latent
 *               and the new seconds after it are generated. Backward runs the
 *               same pass on the reversed clip (see buildExtendGraph).
 *   Speak       the user's audio is encoded and frozen; only video is generated,
 *               so the picture follows the sound (lips, beats). Port of the
 *               official LTX-2.5_A2V_Two_Stage_Distilled example workflow.
 *   Add sound   the clip's frames are encoded and frozen; only audio is
 *               generated (LTXVSetAudioVideoMaskByTime, mask_video off).
 *   Transition  first + last frame (the flf2v recipe in ./ltx25.ts) from the
 *               last frame of A to the first frame of B, then A + bridge + B.
 *
 * Joins are done in the graph with ImageBatch / AudioConcat / CreateVideo, so
 * the saved take is the finished clip and its workflow reproduces it in ComfyUI.
 *
 * Frame bookkeeping: the video VAE packs frame 0 alone and every later 8
 * frames into one latent frame. Real and generated spans are kept on those
 * boundaries (8k+1 real frames and 8m new ones), so no latent frame is half
 * real and half generated.
 */
import { LTX25_FPS, snapFrames } from './ltx25.js';
import { ltx25Files } from './ltxfiles.js';

const UPSCALER = 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors';
const NEGATIVE = 'pc game, console game, video game, cartoon, childish, ugly, blurry, low quality, text, watermark';
const SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
/** Stage 2 of the official A2V example (3 refine steps after the x2 upsample). */
const SIGMAS_REFINE_A2V = '0.909375, 0.725, 0.421875, 0.0';

type Ref = [string, number];
type Graph = Record<string, any>;

const snap32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);
const snap64 = (n: number) => Math.max(128, Math.round(n / 64) * 64);
/** Round a frame count down onto the 8-frame latent grid. */
const floor8 = (n: number) => Math.max(8, Math.floor(n / 8) * 8);
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Loaders, prompt conditioning and the distilled sampler pieces every tool shares. */
function base(g: Graph, prompt: string, negative: string | undefined, fps: number, seed: number) {
  Object.assign(g, {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: ltx25Files().transformer, weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: ltx25Files().textEncoder, type: 'ltxv', device: 'default' } },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: ltx25Files().videoVae } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: ltx25Files().audioVae } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: negative || NEGATIVE } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: fps } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
  });
}

/** One distilled pass over an AV latent; returns the separated [video, audio] outputs. */
function samplePass(g: Graph, key: string, latent: Ref, pos: Ref, neg: Ref, sigmas: Ref = ['sigmas', 0], noise: Ref = ['noise', 0]) {
  Object.assign(g, {
    [`${key}Guide`]: { class_type: 'CFGGuider', inputs: { model: ['unet', 0], positive: pos, negative: neg, cfg: 1.0 } },
    [`${key}Sample`]: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise, guider: [`${key}Guide`, 0], sampler: ['sampler', 0], sigmas, latent_image: latent },
    },
    [`${key}Split`]: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: [`${key}Sample`, 0] } },
  });
  return { video: [`${key}Split`, 0] as Ref, audio: [`${key}Split`, 1] as Ref };
}

function decodeVideo(g: Graph, key: string, latent: Ref): Ref {
  g[key] = {
    class_type: 'VAEDecodeTiled',
    inputs: { samples: latent, vae: ['vvae', 0], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 64 },
  };
  return [key, 0];
}

/**
 * A clip as frames at the working size. VHS_LoadVideo resamples to `fps` and
 * caps the frame count, so the frame math below is exact whatever the source
 * rate was. Its audio output fails on a silent file, so only wire it when the
 * server has probed an audio stream.
 */
function loadClip(g: Graph, key: string, file: string, frames: number, W: number, H: number, fps: number): { frames: Ref; audio: Ref } {
  Object.assign(g, {
    [key]: {
      class_type: 'VHS_LoadVideo',
      inputs: {
        video: file, force_rate: fps, custom_width: 0, custom_height: 0,
        frame_load_cap: frames, skip_first_frames: 0, select_every_nth: 1,
      },
    },
    [`${key}Fit`]: { class_type: 'ImageScale', inputs: { image: [key, 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },
  });
  return { frames: [`${key}Fit`, 0], audio: [key, 2] };
}

const slice = (g: Graph, key: string, image: Ref, index: number, length: number): Ref => {
  g[key] = { class_type: 'ImageFromBatch', inputs: { image, batch_index: index, length } };
  return [key, 0];
};
const batch = (g: Graph, key: string, a: Ref, b: Ref): Ref => {
  g[key] = { class_type: 'ImageBatch', inputs: { image1: a, image2: b } };
  return [key, 0];
};
const trimAudio = (g: Graph, key: string, audio: Ref, start: number, duration: number): Ref => {
  g[key] = { class_type: 'TrimAudioDuration', inputs: { audio, start_index: r4(start), duration: r4(duration) } };
  return [key, 0];
};
const silence = (g: Graph, key: string, duration: number): Ref => {
  g[key] = { class_type: 'EmptyAudio', inputs: { duration: r4(duration), sample_rate: 48000, channels: 2 } };
  return [key, 0];
};
const joinAudio = (g: Graph, key: string, a: Ref, b: Ref): Ref => {
  g[key] = { class_type: 'AudioConcat', inputs: { audio1: a, audio2: b, direction: 'after' } };
  return [key, 0];
};

function save(g: Graph, frames: Ref, fps: number, audio: Ref | undefined, prefix: string) {
  g.video = { class_type: 'CreateVideo', inputs: { images: frames, fps, ...(audio ? { audio } : {}) } };
  g.save = { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } };
}

// ---------------------------------------------------------------- Extend

export type ExtendDirection = 'forward' | 'backward';

export interface ExtendParams {
  prompt: string;
  negative?: string;
  sourceVideo: string;        // asset token or input filename (VHS_LoadVideo)
  /** Frames of the source to use, at `fps`. The server probes the clip and passes floor(duration * fps). */
  sourceFrames: number;
  sourceHasAudio: boolean;
  width: number;
  height: number;
  seconds: number;            // how much new footage
  direction: ExtendDirection;
  seed: number;
  fps?: number;
  /** Seconds of the source the model sees (frozen) while it writes the new part. Default 1. */
  contextSeconds?: number;
  /** Carry sound through: the source audio stays, the new part gets generated sound in context. Needs sourceHasAudio. */
  withAudio?: boolean;
  filenamePrefix?: string;
}

/** Frame counts an extend will use, exported for the UI and the tests. */
export function extendPlan(p: Pick<ExtendParams, 'sourceFrames' | 'seconds' | 'contextSeconds' | 'fps'>) {
  const fps = p.fps ?? LTX25_FPS;
  // Context is 8k+1 real frames, new footage is 8m frames: total 8(k+m)+1, on the latent grid.
  const ctxWant = Math.round((p.contextSeconds ?? 1) * fps);
  const context = Math.min(floor8(ctxWant) + 1, floor8(Math.max(9, p.sourceFrames) - 1) + 1);
  const newFrames = floor8(p.seconds * fps);
  return { fps, context, newFrames, total: context + newFrames, outputFrames: p.sourceFrames + newFrames };
}

/**
 * Forward: the clip's last second is encoded in place at the start of the
 * latent and frozen with an AV noise mask; its sound is frozen the same way,
 * so picture and audio both continue from it.
 *
 * Backward runs the same forward pass on the clip played in reverse, then
 * reverses the result, so the new lead-in arrives at the clip's first frame
 * with matching motion. Its picture is therefore generated in reversed time:
 * camera moves, drift, wind and water read naturally; a person walking would
 * walk backwards. Two direct approaches were tried first on the same clip and
 * seed (2026-10-17) and both eased into a ~20-frame freeze before the cut:
 * freezing the first second in place at the END of the latent, and placing it
 * there as an LTXVAddGuide keyframe (that one also jumped at the cut, mean
 * frame difference 7.1 against a 1.3 median). Reversal measured 2.9 at the
 * cut with steady motion throughout. The backward lead-in is silent; the
 * clip's own sound follows it.
 */
export function buildExtendGraph(p: ExtendParams): Graph {
  const { fps, context: ctx, newFrames: nw, total } = extendPlan(p);
  const W = snap32(p.width);
  const H = snap32(p.height);
  const audioOn = !!p.withAudio && p.sourceHasAudio;
  const back = p.direction === 'backward';
  const g: Graph = {};
  base(g, p.prompt, p.negative, fps, p.seed);
  const src = loadClip(g, 'src', p.sourceVideo, p.sourceFrames, W, H, fps);
  const srcAudio = audioOn ? trimAudio(g, 'srcA', src.audio, 0, p.sourceFrames / fps) : undefined;
  let clip = src.frames;
  if (back) {
    g.rev = { class_type: 'ReverseImageBatch', inputs: { images: clip } };
    clip = ['rev', 0];
  }

  // Pixel batch: real context + filler. The filler is fully re-noised (mask 1),
  // so its content does not matter; holding the edge frame keeps the encoder calm.
  const tail = slice(g, 'ctx', clip, -ctx, ctx);
  const edge = slice(g, 'edge', clip, -1, 1);
  g.fill = { class_type: 'RepeatImageBatch', inputs: { image: edge, amount: nw } };
  g.latV = { class_type: 'VAEEncode', inputs: { pixels: batch(g, 'pix', tail, ['fill', 0]), vae: ['vvae', 0] } };
  if (srcAudio && !back) {
    const ctxA = trimAudio(g, 'ctxA', srcAudio, (p.sourceFrames - ctx) / fps, ctx / fps);
    const both = joinAudio(g, 'pixA', ctxA, silence(g, 'gapA', nw / fps));
    g.latA = { class_type: 'LTXVAudioVAEEncode', inputs: { audio: both, audio_vae: ['avae', 0] } };
  } else {
    g.latA = { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: total, frame_rate: fps, batch_size: 1, audio_vae: ['avae', 0] } };
  }
  g.av = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['latV', 0], audio_latent: ['latA', 0] } };
  // 0 = keep, 1 = generate. start_time lands exactly on the first new latent frame.
  g.mask = {
    class_type: 'LTXVSetAudioVideoMaskByTime',
    inputs: {
      av_latent: ['av', 0], positive: ['cond', 0], negative: ['cond', 1], model: ['unet', 0], vae: ['vvae', 0], audio_vae: ['avae', 0],
      start_time: r4(ctx / fps), end_time: r4(total / fps + 1), video_fps: fps, mask_video: true, mask_audio: true,
      mask_init_value_video: 0, mask_init_value_audio: 0, slope_len: 3,
    },
  };
  const out = samplePass(g, 's1', ['mask', 2], ['mask', 0], ['mask', 1]);
  const dv = decodeVideo(g, 'dv', out.video);
  const fresh = slice(g, 'new', dv, ctx, nw);
  let frames = batch(g, 'join', clip, fresh);
  if (back) {
    g.unrev = { class_type: 'ReverseImageBatch', inputs: { images: frames } };
    frames = ['unrev', 0];
  }

  let audio: Ref | undefined;
  if (srcAudio && back) {
    audio = joinAudio(g, 'joinA', silence(g, 'newA', nw / fps), srcAudio);
  } else if (srcAudio) {
    g.da = { class_type: 'LTXVAudioVAEDecode', inputs: { samples: out.audio, audio_vae: ['avae', 0] } };
    audio = joinAudio(g, 'joinA', srcAudio, trimAudio(g, 'newA', ['da', 0], ctx / fps, nw / fps));
  }
  save(g, frames, fps, audio, p.filenamePrefix ?? 'openfield/extend');
  return g;
}

// ---------------------------------------------------------------- Transition

/** One end of a transition: a video take (its last / first frame is used) or a still. */
export interface TransitionEnd {
  file: string;               // asset token or input filename
  kind: 'video' | 'image';
  /** Video only: frames at fps, from the server's probe. */
  frames?: number;
  hasAudio?: boolean;
}

export interface TransitionParams {
  prompt: string;
  negative?: string;
  a: TransitionEnd;
  b: TransitionEnd;
  width: number;
  height: number;
  seconds: number;            // bridge length
  seed: number;
  fps?: number;
  /** Keep sound: A's and B's own audio, generated sound under the bridge. */
  withAudio?: boolean;
  /** How hard the bridge's first and last frames hold to A and B. 0.7 is the loop recipe. */
  guideStrength?: number;
  filenamePrefix?: string;
}

export function buildTransitionGraph(p: TransitionParams): Graph {
  const fps = p.fps ?? LTX25_FPS;
  const W = snap32(p.width);
  const H = snap32(p.height);
  const frames = snapFrames(p.seconds, fps);
  const strength = p.guideStrength ?? 0.85;
  const g: Graph = {};
  base(g, p.prompt, p.negative, fps, p.seed);

  const end = (key: string, e: TransitionEnd) => {
    if (e.kind === 'video') return { clip: loadClip(g, key, e.file, e.frames!, W, H, fps) };
    g[key] = { class_type: 'LoadImage', inputs: { image: e.file } };
    g[`${key}Fit`] = { class_type: 'ImageScale', inputs: { image: [key, 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } };
    return { still: [`${key}Fit`, 0] as Ref };
  };
  const A = end('a', p.a);
  const B = end('b', p.b);
  const lastA = A.clip ? slice(g, 'aLast', A.clip.frames, -1, 1) : A.still!;
  const firstB = B.clip ? slice(g, 'bFirst', B.clip.frames, 0, 1) : B.still!;

  // flf2v, as in ./ltx25.ts: guide frame 0 and frame -1, single pass, crop the guides.
  Object.assign(g, {
    aPrep: { class_type: 'LTXVPreprocess', inputs: { image: lastA, img_compression: 18 } },
    bPrep: { class_type: 'LTXVPreprocess', inputs: { image: firstB, img_compression: 18 } },
    lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: W, height: H, length: frames, batch_size: 1 } },
    gA: {
      class_type: 'LTXVAddGuide',
      inputs: { positive: ['cond', 0], negative: ['cond', 1], vae: ['vvae', 0], latent: ['lat', 0], image: ['aPrep', 0], frame_idx: 0, strength },
    },
    gB: {
      class_type: 'LTXVAddGuide',
      inputs: { positive: ['gA', 0], negative: ['gA', 1], vae: ['vvae', 0], latent: ['gA', 2], image: ['bPrep', 0], frame_idx: -1, strength },
    },
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: ['avae', 0] } },
    av: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['gB', 2], audio_latent: ['latA', 0] } },
  });
  const out = samplePass(g, 's1', ['av', 0], ['gB', 0], ['gB', 1]);
  g.crop = { class_type: 'LTXVCropGuides', inputs: { positive: ['gB', 0], negative: ['gB', 1], latent: out.video } };
  const dv = decodeVideo(g, 'dv', ['crop', 2]);

  // The bridge's end frames are near-copies of A's last and B's first frame.
  // Next to real footage they would read as a one-frame stall, so drop them.
  const from = A.clip ? 1 : 0;
  const len = frames - from - (B.clip ? 1 : 0);
  const bridge = slice(g, 'bridge', dv, from, len);
  let seq = A.clip ? batch(g, 'joinA', A.clip.frames, bridge) : bridge;
  if (B.clip) seq = batch(g, 'joinB', seq, B.clip.frames);

  let audio: Ref | undefined;
  if (p.withAudio) {
    g.da = { class_type: 'LTXVAudioVAEDecode', inputs: { samples: out.audio, audio_vae: ['avae', 0] } };
    let track = trimAudio(g, 'bridgeA', ['da', 0], from / fps, len / fps);
    if (A.clip) {
      const a = p.a.hasAudio ? trimAudio(g, 'aA', A.clip.audio, 0, p.a.frames! / fps) : silence(g, 'aA', p.a.frames! / fps);
      track = joinAudio(g, 'joinAudioA', a, track);
    }
    if (B.clip) {
      const b = p.b.hasAudio ? trimAudio(g, 'bA', B.clip.audio, 0, p.b.frames! / fps) : silence(g, 'bA', p.b.frames! / fps);
      track = joinAudio(g, 'joinAudioB', track, b);
    }
    audio = track;
  }
  save(g, seq, fps, audio, p.filenamePrefix ?? 'openfield/transition');
  return g;
}

// ---------------------------------------------------------------- Speak (audio to video)

export interface SpeakParams {
  prompt: string;
  negative?: string;
  image: string;              // asset token / filename for LoadImage (the face, or any start frame)
  audio: string;              // asset token / filename for LoadAudio (wav, mp3, or a clip with sound)
  audioStart?: number;        // seconds into the audio file
  seconds: number;            // length; the audio is trimmed to it
  width: number;
  height: number;
  seed: number;
  fps?: number;
  filenamePrefix?: string;
}

/**
 * Port of LTX-2.5_A2V_Two_Stage_Distilled.json (ComfyUI-LTXVideo 2.5 examples):
 * the trimmed audio is encoded and frozen (SolidMask 0 -> SetLatentNoiseMask)
 * in both stages, the start image is injected at 0.7 then 1.0, and the
 * original waveform (not a re-decode) is muxed into the output.
 */
export function buildSpeakGraph(p: SpeakParams): Graph {
  const fps = p.fps ?? LTX25_FPS;
  const frames = snapFrames(p.seconds, fps);
  const dur = r4(frames / fps);
  const W = snap64(p.width);
  const H = snap64(p.height);
  const g: Graph = {};
  base(g, p.prompt, p.negative, fps, p.seed);
  Object.assign(g, {
    img: { class_type: 'LoadImage', inputs: { image: p.image } },
    imgEdge: { class_type: 'ResizeImagesByLongerEdge', inputs: { images: ['img', 0], longer_edge: 1536 } },
    imgPrep: { class_type: 'LTXVPreprocess', inputs: { image: ['imgEdge', 0], img_compression: 18 } },

    aud: { class_type: 'LoadAudio', inputs: { audio: p.audio } },
    audTrim: { class_type: 'TrimAudioDuration', inputs: { audio: ['aud', 0], start_index: r4(p.audioStart ?? 0), duration: dur } },
    audLat: { class_type: 'LTXVAudioVAEEncode', inputs: { audio: ['audTrim', 0], audio_vae: ['avae', 0] } },
    freeze: { class_type: 'SolidMask', inputs: { value: 0, width: 1024, height: 1024 } },
    audFrozen: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['audLat', 0], mask: ['freeze', 0] } },

    // ---- stage 1, half resolution ----
    latV: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: W / 2, height: H / 2, length: frames, batch_size: 1 } },
    inj1: { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['vvae', 0], image: ['imgPrep', 0], latent: ['latV', 0], strength: 0.7, bypass: false } },
    av1: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['inj1', 0], audio_latent: ['audFrozen', 0] } },
  });
  const s1 = samplePass(g, 's1', ['av1', 0], ['cond', 0], ['cond', 1]);

  // ---- stage 2: x2 latent upsample, refine against the ORIGINAL frozen audio ----
  Object.assign(g, {
    upModel: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: UPSCALER } },
    up: { class_type: 'LTXVLatentUpsampler', inputs: { samples: s1.video, upscale_model: ['upModel', 0], vae: ['vvae', 0] } },
    inj2: { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['vvae', 0], image: ['imgPrep', 0], latent: ['up', 0], strength: 1.0, bypass: false } },
    av2: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['inj2', 0], audio_latent: ['audFrozen', 0] } },
    sigmas2: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS_REFINE_A2V } },
    noise2: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed + 1 } },
  });
  const s2 = samplePass(g, 's2', ['av2', 0], ['cond', 0], ['cond', 1], ['sigmas2', 0], ['noise2', 0]);
  const dv = decodeVideo(g, 'dv', s2.video);
  save(g, dv, fps, ['audTrim', 0], p.filenamePrefix ?? 'openfield/speak');
  return g;
}

/** The size a Speak render delivers (two-stage, so 64-aligned). */
export const speakEffectiveSize = (w: number, h: number) => ({ width: snap64(w), height: snap64(h) });

// ---------------------------------------------------------------- Add sound (video to audio)

export interface SoundParams {
  prompt: string;             // what should be heard
  negative?: string;
  sourceVideo: string;
  sourceFrames: number;       // at fps, from the probe
  width: number;              // working size the frames are encoded at (the output keeps the clip's own size)
  height: number;
  seed: number;
  fps?: number;
  filenamePrefix?: string;
}

/** Frames an Add sound pass covers: the clip, trimmed down onto the 8n+1 grid. */
export const soundFrames = (sourceFrames: number) => Math.max(9, Math.floor((sourceFrames - 1) / 8) * 8 + 1);

export function buildSoundGraph(p: SoundParams): Graph {
  const fps = p.fps ?? LTX25_FPS;
  const n = soundFrames(p.sourceFrames);
  const W = snap32(p.width);
  const H = snap32(p.height);
  const g: Graph = {};
  base(g, p.prompt, p.negative, fps, p.seed);
  Object.assign(g, {
    src: {
      class_type: 'VHS_LoadVideo',
      inputs: { video: p.sourceVideo, force_rate: fps, custom_width: 0, custom_height: 0, frame_load_cap: n, skip_first_frames: 0, select_every_nth: 1 },
    },
    srcFit: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },
    latV: { class_type: 'VAEEncode', inputs: { pixels: ['srcFit', 0], vae: ['vvae', 0] } },
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: n, frame_rate: fps, batch_size: 1, audio_vae: ['avae', 0] } },
    av: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['latV', 0], audio_latent: ['latA', 0] } },
    // Video stays frozen (mask_video off leaves it at the init value 0); audio is generated over the whole clip.
    mask: {
      class_type: 'LTXVSetAudioVideoMaskByTime',
      inputs: {
        av_latent: ['av', 0], positive: ['cond', 0], negative: ['cond', 1], model: ['unet', 0], vae: ['vvae', 0], audio_vae: ['avae', 0],
        start_time: 0, end_time: r4(n / fps + 1), video_fps: fps, mask_video: false, mask_audio: true,
        mask_init_value_video: 0, mask_init_value_audio: 0, slope_len: 3,
      },
    },
  });
  const out = samplePass(g, 's1', ['mask', 2], ['mask', 0], ['mask', 1]);
  g.da = { class_type: 'LTXVAudioVAEDecode', inputs: { samples: out.audio, audio_vae: ['avae', 0] } };
  // Picture out = the clip's own frames, untouched; only the soundtrack is new.
  save(g, ['src', 0], fps, ['da', 0], p.filenamePrefix ?? 'openfield/sound');
  return g;
}
