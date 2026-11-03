/**
 * Stage graphs.
 *
 * Shot: LTX-2.5 Layout to Render, the two-stage distilled IC-LoRA graph
 * Lightricks publishes with the LoRA
 * (LTX-2.5_ICLoRA_Layout_To_Render_Two_Stage_Distilled.json), flattened to API
 * format. Changes from the official graph:
 *   - our int8 transformer and Gemma 4 encoder (the ltx25 slots in slots.ts)
 *     in place of the bf16 files;
 *   - plain CLIPTextEncode only: the official graph can route the prompt to
 *     Lightricks' hosted Gemma API instead, which never runs locally;
 *   - stage 1 at half the clay's height, so the clay sets the output size.
 * The clay clip carries the camera, the motion and where things stand; the
 * look frame (the first frame's art direction) sets palette, light and
 * materials. Both guides go in at both stages. CFG 1, euler_ancestral, the
 * official sigmas. No audio latent: the graph is picture only.
 *
 * Look frame: Z-Image Turbo with the Fun ControlNet Union reading an exact
 * depth pass of the blocking, so the art-direction frame keeps the set's
 * layout. Where the look frame and the clay disagree, the shot follows the
 * look frame, so the look frame is drawn on the depth pass.
 */
import { slotFile } from './slots.js';

const SIGMAS_STAGE1 = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
const SIGMAS_STAGE2 = '0.909375, 0.725, 0.421875, 0.0';
export const STAGE_NEGATIVE = '';

export interface StageShotParams {
  /** The clay clip (asset token or loader filename). Its size is the output size; 64-aligned. */
  clay: string;
  /** Its height: stage 1 runs at half of it. */
  height: number;
  /** The look frame (asset token or loader filename). */
  look: string;
  prompt: string;
  negative?: string;
  seed: number;
  filenamePrefix?: string;
}

export function buildStageShotGraph(p: StageShotParams): Record<string, unknown> {
  if (p.height % 64) throw new Error(`The clay height must be a multiple of 64 (got ${p.height})`);
  const guide = (positive: [string, number], negative: [string, number], latent: [string, number], image: [string, number], frame: number, factor: number | [string, number], crop: 'disabled' | 'center') => ({
    class_type: 'LTXAddVideoICLoRAGuide',
    inputs: {
      positive, negative, vae: ['vvae', 0], latent, image, frame_idx: frame, strength: 1, latent_downscale_factor: factor,
      crop, use_tiled_encode: false, tile_size: 256, tile_overlap: 64, use_streaming: false, tile_frames: 97,
    },
  });
  return {
    // ---- loaders ----
    vvae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.videoVae') } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('ltx25.transformer'), weight_dtype: 'default' } },
    icl: { class_type: 'LTXICLoRALoaderModelOnly', inputs: { model: ['unet', 0], lora_name: slotFile('ltx25-loras.stage'), strength_model: 1 } },
    upmodel: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: slotFile('ltx25.upscaler') } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('ltx25.textEncoder'), type: 'ltxv', device: 'default' } },

    // ---- inputs: the clay clip (camera, motion, layout) and the look frame (art direction) ----
    clay: { class_type: 'LoadVideo', inputs: { file: p.clay } },
    clayParts: { class_type: 'GetVideoComponents', inputs: { video: ['clay', 0] } },
    clayHalf: {
      class_type: 'ResizeImageMaskNode',
      inputs: { input: ['clayParts', 0], resize_type: 'scale shorter dimension', 'resize_type.shorter_size': p.height / 2, scale_method: 'lanczos' },
    },
    claySize: { class_type: 'GetImageSize', inputs: { image: ['clayHalf', 0] } },
    look: { class_type: 'LoadImage', inputs: { image: p.look } },

    // ---- prompt ----
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.negative ?? STAGE_NEGATIVE } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: ['clayParts', 2] } },

    // ---- stage 1: half size, 8 steps ----
    lat1: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: ['claySize', 0], height: ['claySize', 1], length: ['claySize', 2], batch_size: 1 } },
    g1clay: guide(['cond', 0], ['cond', 1], ['lat1', 0], ['clayHalf', 0], 0, ['icl', 1], 'disabled'),
    g1look: guide(['g1clay', 0], ['g1clay', 1], ['g1clay', 2], ['look', 0], -1, ['icl', 1], 'center'),
    noise1: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    cfg1: { class_type: 'CFGGuider', inputs: { model: ['icl', 0], positive: ['g1look', 0], negative: ['g1look', 1], cfg: 1 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    sig1: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS_STAGE1 } },
    s1: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise1', 0], guider: ['cfg1', 0], sampler: ['sampler', 0], sigmas: ['sig1', 0], latent_image: ['g1look', 2] } },
    crop1: { class_type: 'LTXVCropGuides', inputs: { positive: ['g1look', 0], negative: ['g1look', 1], latent: ['s1', 0] } },

    // ---- stage 2: x2 latent upsample, full size, 3 steps ----
    up: { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['crop1', 2], upscale_model: ['upmodel', 0], vae: ['vvae', 0] } },
    g2clay: guide(['cond', 0], ['cond', 1], ['up', 0], ['clayHalf', 0], 0, 1, 'disabled'),
    g2look: guide(['g2clay', 0], ['g2clay', 1], ['g2clay', 2], ['look', 0], -1, 1, 'center'),
    noise2: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    cfg2: { class_type: 'CFGGuider', inputs: { model: ['icl', 0], positive: ['g2look', 0], negative: ['g2look', 1], cfg: 1 } },
    sig2: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS_STAGE2 } },
    s2: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise2', 0], guider: ['cfg2', 0], sampler: ['sampler', 0], sigmas: ['sig2', 0], latent_image: ['g2look', 2] } },
    crop2: { class_type: 'LTXVCropGuides', inputs: { positive: ['g2look', 0], negative: ['g2look', 1], latent: ['s2', 0] } },

    // ---- decode ----
    dv: { class_type: 'VAEDecodeTiled', inputs: { samples: ['crop2', 2], vae: ['vvae', 0], tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dv', 0], fps: ['clayParts', 2], bit_depth: 8, color_space: 'sRGB', codec: 'none' } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: p.filenamePrefix ?? 'openfield/stage', format: 'auto', codec: 'auto' } },
  };
}

export interface StageLookParams {
  /** The depth pass of the first frame (near = white). */
  depth: string;
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /** How hard the depth holds the layout, 0..1. */
  strength?: number;
  /** Depth softening in pixels (sigma). Stage figures are capsules: traced sharp at full strength they
   *  come out as a pictogram of a person, softened the model draws a body that stands where they stand. */
  soften?: number;
}

/** Z-Image Turbo + Fun ControlNet Union on the depth pass: 9 steps, CFG 1. */
export function buildStageLookGraph(p: StageLookParams): Record<string, unknown> {
  return {
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('zimage.textEncoder'), type: 'lumina2', device: 'default' } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('zimage.model'), weight_dtype: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('zimage.vae') } },
    control: { class_type: 'ModelPatchLoader', inputs: { name: slotFile('zimage.control') } },
    depth: { class_type: 'LoadImage', inputs: { image: p.depth } },
    depthScale: { class_type: 'ImageScale', inputs: { image: ['depth', 0], upscale_method: 'lanczos', width: p.width, height: p.height, crop: 'disabled' } },
    depthFit: { class_type: 'ImageBlur', inputs: { image: ['depthScale', 0], blur_radius: Math.ceil((p.soften ?? 4) * 2.5), sigma: p.soften ?? 4 } },
    shift: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['unet', 0], shift: 3 } },
    guided: {
      class_type: 'QwenImageDiffsynthControlnet',
      inputs: { model: ['shift', 0], model_patch: ['control', 0], vae: ['vae', 0], image: ['depthFit', 0], strength: p.strength ?? 0.75 },
    },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.prompt } },
    neg: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } },
    lat: { class_type: 'EmptySD3LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    k: {
      class_type: 'KSampler',
      inputs: {
        model: ['guided', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0],
        seed: p.seed, steps: 9, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
      },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['d', 0], filename_prefix: 'openfield/stage_look' } },
  };
}

/**
 * The look-frame prompt. The words describe the finished picture; the line
 * about the camera keeps Z-Image from adding props the set does not have.
 */
export function lookPrompt(text: string, figures = 0): string {
  const t = text.trim().replace(/\s+/g, ' ');
  // the blocking figures are stand-ins: say what they become, or the model draws the stand-in
  const who = figures === 1 ? ' The standing figure is a real, fully detailed person photographed in the scene: face, hair, clothing and skin.'
    : figures > 1 ? ` The ${figures} standing figures are real, fully detailed people photographed in the scene: faces, hair, clothing and skin.` : '';
  return `${t.replace(/([^.!?])$/, '$1.')}${who} Cinematic film still, natural light falling on real materials, every object where the layout puts it.`;
}

/** Qwen-Image-Edit fallback: the clay frame is the picture being edited, so the instruction locks its geometry. */
export function lookEditInstruction(text: string): string {
  return 'Keep the exact camera angle, framing, perspective, object positions, sizes and proportions of image 1. '
    + 'Do not move, add or remove anything. Turn the grey clay shapes into a finished, photographic film still: '
    + text.trim().replace(/([^.!?])$/, '$1.');
}
