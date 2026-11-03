/**
 * Restyle and Object swap: change a clip's look, or one thing in it, while
 * keeping its motion. Both are one ComfyUI job that chains two models:
 *
 *   Restyle  frame 0 of the source -> Qwen-Image-Edit 2509 ("redraw this as a
 *            watercolor...") -> the restyled frame becomes Mirror's first frame
 *            -> LTX-2.5 + IC-LoRA Union Control (depth or edges of the source)
 *            carries the source's motion through the new look. The edited frame
 *            shares the source's framing exactly, which is what Mirror needs.
 *
 *   Swap     SAM 3.1 finds the object (a word, or a click on frame 0) and
 *            tracks it through the clip -> the track, grown, is the inpaint
 *            mask -> Qwen-Image-Edit replaces the object in frame 0 inside that
 *            mask (optionally from a reference picture) -> LTX-2.5 with the
 *            in/outpainting IC-LoRA fills the masked region of every frame,
 *            starting from the edited frame -> a Laplacian-pyramid blend puts the
 *            untouched source back outside the mask. Port of the official
 *            LTX-2.5 ICLoRA Inpaint example, stage 1 only.
 *
 * The edit graph is built by ./edit.ts and merged in under an `e_` prefix, with
 * its LoadImage replaced by a frame of the source.
 */
import { buildEditGraph, editSize } from './edit.js';
import { buildMirrorGraph, type MirrorControl } from './mirror.js';
import { SAM3 } from './cutout.js';
import { snapFrames } from './ltx25.js';
import { ltx25Files } from './ltxfiles.js';

type Ref = [string, number];
type Graph = Record<string, any>;

export const INPAINT_LORA = 'ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors';
const SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
const NEGATIVE = 'pc game, console game, video game, cartoon, childish, ugly, green screen, chroma key, blurry, low quality, text, watermark';
const FPS = 24;

/** IC-LoRA guides need a 64-aligned frame (a 32-only size gives an odd latent grid). */
const snap64 = (n: number) => Math.max(128, Math.round(n / 64) * 64);

/**
 * Copy `src` into `into` with every node id prefixed, rewriting the links
 * between them. Links to ids outside `src` are left alone, so a prefixed graph
 * can point at nodes of the graph it is merged into.
 */
export function mergePrefixed(into: Graph, src: Graph, prefix: string): void {
  const ids = new Set(Object.keys(src));
  for (const [id, node] of Object.entries(src)) {
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((node as any).inputs ?? {})) {
      inputs[k] = Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number' && ids.has(v[0])
        ? [`${prefix}${v[0]}`, v[1]] : v;
    }
    into[`${prefix}${id}`] = { ...(node as any), inputs };
  }
}

interface FrameEdit {
  instruction: string;
  seed: number;
  /** Lightning LoRA filename for the 8-step draft edit. */
  lightning: string;
  quality: 'draft' | 'quality';
  /** Edit canvas, about 1 MP at the clip's aspect. */
  width: number;
  height: number;
  /** Optional second image for the edit (Swap: what the object becomes). */
  reference?: string;
  /** Swap: context kept around the object in the edit crop, in px of the working frame. */
  cropPad?: number;
}

/**
 * Qwen-Image-Edit on a frame produced elsewhere in the graph. Returns the
 * edited frame.
 *
 * With a `mask` (a clip's mask track, foreground = may change) the edit runs on
 * a crop around the object, scaled to about 1 MP, and only the masked part is
 * pasted back into the source frame. Two failures this avoids: a latent noise
 * mask on the whole frame made Qwen-Edit redraw the object almost unchanged (an
 * armored arm on a running man), and a whole-frame edit can pick a different
 * object than SAM did ("the white van" became the silver car next to it).
 * The crop and paste are KJNodes' ImageCropByMaskAndResize / ImageUncropByMask.
 */
function editFrame(g: Graph, frame: Ref, e: FrameEdit, mask?: Ref): Ref {
  const placeholder = 'frame.png';
  const eg = buildEditGraph({
    images: e.reference ? [placeholder, e.reference] : [placeholder],
    instruction: e.instruction, width: e.width, height: e.height, seed: e.seed,
    quality: e.quality, lightning: e.lightning,
  }) as Graph;
  delete eg.save;
  mergePrefixed(g, eg, 'e_');
  g.e_frame0 = { class_type: 'ImageFromBatch', inputs: { image: frame, batch_index: 0, length: 1 } };
  g.e_img1 = { class_type: 'ImageFromBatch', inputs: { image: ['e_frame0', 0], batch_index: 0, length: 1 } };
  g.e_preview = { class_type: 'PreviewImage', inputs: { images: ['e_d', 0] } };
  if (!mask) return ['e_d', 0];
  g.e_maskImg = { class_type: 'MaskToImage', inputs: { mask } };
  g.e_mask0Img = { class_type: 'ImageFromBatch', inputs: { image: ['e_maskImg', 0], batch_index: 0, length: 1 } };
  g.e_mask0 = { class_type: 'ImageToMask', inputs: { image: ['e_mask0Img', 0], channel: 'red' } };
  g.e_crop = {
    class_type: 'ImageCropByMaskAndResize',
    inputs: { image: ['e_frame0', 0], mask: ['e_mask0', 0], base_resolution: 1024, padding: e.cropPad ?? 48, min_crop_resolution: 128, max_crop_resolution: 4096 },
  };
  g.e_img1 = { class_type: 'ImageFromBatch', inputs: { image: ['e_crop', 0], batch_index: 0, length: 1 } };
  // The crop keeps its own aspect: scale it to ~1 MP instead of to a fixed size.
  g.e_s1 = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['e_img1', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 } };
  g.e_paste = { class_type: 'ImageUncropByMask', inputs: { destination: ['e_frame0', 0], source: ['e_d', 0], mask: ['e_crop', 1], bbox: ['e_crop', 2] } };
  return ['e_paste', 0];
}

// ---------------------------------------------------------------- Restyle

export interface RestyleParams {
  sourceVideo: string;
  /** The edit instruction for frame 0 (from the style recipe and the user's words). */
  instruction: string;
  /** What the finished shot looks like, for LTX. */
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  seconds: number;
  seed: number;
  control: Exclude<MirrorControl, 'pose'>;
  guideStrength?: number;
  lightning: string;
  quality?: 'draft' | 'quality';
  withAudio?: boolean;
}

export function buildRestyleGraph(p: RestyleParams): Graph {
  const W = snap64(p.width);
  const H = snap64(p.height);
  const g = buildMirrorGraph({
    prompt: p.prompt, negative: p.negative, sourceVideo: p.sourceVideo, firstFrame: 'frame.png',
    width: W, height: H, seconds: p.seconds, seed: p.seed, control: p.control,
    guideStrength: p.guideStrength, withAudio: p.withAudio, filenamePrefix: 'openfield/restyle',
  }) as Graph;
  const size = editSize(W, H, 1);
  const edited = editFrame(g, ['src', 0], {
    instruction: p.instruction, seed: p.seed, lightning: p.lightning, quality: p.quality ?? 'draft',
    width: size.width, height: size.height,
  });
  delete g.ffLoad;
  g.ffFit.inputs.image = edited;
  return g;
}

// ---------------------------------------------------------------- Swap

export interface SwapParams {
  sourceVideo: string;
  /** What to replace, as SAM finds it: "the red car". */
  target: string;
  /** Optional click on frame 0, in 0..1 of the frame. Wins over the word for the first frame. */
  point?: { x: number; y: number };
  /** What it becomes, in words. */
  replacement: string;
  /** Optional picture of what it becomes. */
  reference?: string;
  /** The finished scene, for LTX. */
  prompt: string;
  width: number;
  height: number;
  seconds: number;
  seed: number;
  lightning: string;
  quality?: 'draft' | 'quality';
  /** How far past the object's outline the new pixels may go, in px at the working size. */
  grow?: number;
}

export function buildSwapGraph(p: SwapParams): Graph {
  const W = snap64(p.width);
  const H = snap64(p.height);
  const frames = snapFrames(p.seconds, FPS);
  const grow = Math.max(4, Math.round(p.grow ?? Math.min(W, H) * 0.03));
  const g: Graph = {
    src: {
      class_type: 'VHS_LoadVideo',
      inputs: { video: p.sourceVideo, force_rate: FPS, custom_width: 0, custom_height: 0, frame_load_cap: frames, skip_first_frames: 0, select_every_nth: 1 },
    },
    fit: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },

    // ---- find and follow the object ----
    sam: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: SAM3 } },
    // SAM 3 wants a short noun phrase: "red car", not "the red car".
    samText: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam', 1], text: p.target.replace(/^(the|a|an)\s+/i, '') } },
    samTrack: {
      class_type: 'SAM3_VideoTrack',
      inputs: { images: ['fit', 0], model: ['sam', 0], conditioning: ['samText', 0], detection_threshold: 0.4, max_objects: 1, detect_interval: 1 },
    },
    samMask: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['samTrack', 0], object_indices: '0' } },
    // Grown in space (the new object may be a different shape) and by one
    // frame in time (motion blur at the object's leading edge).
    mask: { class_type: 'LTXVDilateVideoMask', inputs: { mask: ['samMask', 0], spatial_radius: grow, temporal_radius: 1 } },
  };
  if (p.point) {
    // A click picks one object on frame 0; the tracker follows that one.
    const xy = JSON.stringify([{ x: Math.round(p.point.x * W), y: Math.round(p.point.y * H) }]);
    g.samFirst = { class_type: 'ImageFromBatch', inputs: { image: ['fit', 0], batch_index: 0, length: 1 } };
    g.samClick = {
      class_type: 'SAM3_Detect',
      inputs: { model: ['sam', 0], image: ['samFirst', 0], threshold: 0.5, refine_iterations: 2, individual_masks: false, positive_coords: xy },
    };
    g.samTrack.inputs.initial_mask = ['samClick', 0];
    delete g.samTrack.inputs.conditioning;
  }

  // ---- frame 0: replace the object ----
  const size = editSize(W, H, 1);
  // Qwen-Edit leans toward small edits; on a draft pass "replace the man with a
  // knight" armored one arm. Say that all of it goes, and run full sampling.
  const what = p.reference ? `${p.replacement}, the one shown in image 2` : p.replacement;
  const instruction = `Completely replace ${p.target} with ${what}. Nothing of the original ${p.target.replace(/^(the|a|an) /i, '')} remains: every part of it is now ${p.replacement}. Same position, size, pose, perspective and lighting. Keep everything else in the picture exactly the same.`;
  const edited = editFrame(g, ['fit', 0], {
    instruction, seed: p.seed, lightning: p.lightning, quality: p.quality ?? 'quality',
    width: size.width, height: size.height, reference: p.reference,
  }, ['mask', 0]);

  // ---- LTX-2.5 inpaint, IC-LoRA guide = the source with the object keyed out ----
  Object.assign(g, {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: ltx25Files().transformer, weight_dtype: 'default' } },
    icl: { class_type: 'LTXICLoRALoaderModelOnly', inputs: { model: ['unet', 0], lora_name: INPAINT_LORA, strength_model: 1.0 } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: ltx25Files().textEncoder, type: 'ltxv', device: 'default' } },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: ltx25Files().videoVae } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: ltx25Files().audioVae } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: NEGATIVE } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: FPS } },
    keyed: { class_type: 'LTXVInpaintPreprocess', inputs: { images: ['fit', 0], mask: ['mask', 0] } },
    lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: W, height: H, length: frames, batch_size: 1 } },
    ffFit: { class_type: 'ImageScale', inputs: { image: edited, upscale_method: 'lanczos', width: W, height: H, crop: 'disabled' } },
    ffPrep: { class_type: 'LTXVPreprocess', inputs: { image: ['ffFit', 0], img_compression: 18 } },
    ff: { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['vvae', 0], image: ['ffPrep', 0], latent: ['lat', 0], strength: 0.7, bypass: false } },
    guide: {
      class_type: 'LTXAddVideoICLoRAGuide',
      inputs: {
        positive: ['cond', 0], negative: ['cond', 1], vae: ['vvae', 0], latent: ['ff', 0],
        image: ['keyed', 0], frame_idx: 0, strength: 1.0, latent_downscale_factor: ['icl', 1],
        crop: 'disabled', use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
      },
    },
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: FPS, batch_size: 1, audio_vae: ['avae', 0] } },
    av: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['guide', 2], audio_latent: ['latA', 0] } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['icl', 0], positive: ['guide', 0], negative: ['guide', 1], cfg: 1.0 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    sample: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['av', 0] },
    },
    split: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } },
    crop: { class_type: 'LTXVCropGuides', inputs: { positive: ['guide', 0], negative: ['guide', 1], latent: ['split', 0] } },
    decode: {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['crop', 2], vae: ['vvae', 0], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 64 },
    },
    // White = the new pixels, black = the source exactly as filmed.
    blend: {
      class_type: 'LTXVLaplacianPyramidBlend',
      inputs: { image_a: ['decode', 0], image_b: ['fit', 0], mask: ['mask', 0], trim_to_shortest: true, mask_low_res_dilation: 5 },
    },
    video: { class_type: 'CreateVideo', inputs: { images: ['blend', 0], fps: FPS } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: 'openfield/swap', format: 'auto', codec: 'auto' } },
  });
  return g;
}
