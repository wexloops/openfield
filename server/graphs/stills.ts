/**
 * Stills graph builders — two models, each with a DRAFT and QUALITY mode.
 *
 *  qwen  — Qwen-Image fp8. DRAFT = Lightning 8-step LoRA (fast, softer);
 *          QUALITY = no LoRA, 50 steps, CFG 2.5 (the model's real output).
 *          QUALITY is also the only mode where `negative` does anything, since
 *          a negative prompt needs CFG > 1 to have any effect.
 *  flux2 — FLUX.2 dev fp8mixed, the open-weights photorealism lead.
 *          DRAFT = Turbo LoRA @ 8 steps; QUALITY = 20 steps, FluxGuidance 4.
 *          Graph shape from the official image_flux2_fp8 template.
 *          Reference images (cast pictures or your own) go in as
 *          ReferenceLatents, the FLUX.2 multi-reference recipe: identity and
 *          wardrobe carry over while the frame, light and skin stay photographic.
 *
 * Your own LoRAs chain after the model (and after the draft distill).
 */
import { slotFile } from './slots.js';

export interface StillsParams {
  model: 'qwen' | 'flux2';
  quality: 'draft' | 'quality';
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /**
   * Things to keep OUT of the image. This is the only place exclusions work:
   * Qwen draws whatever you negate in the POSITIVE prompt ("no rope" renders a
   * rope), because the encoder embeds the noun and the sampler renders it. Only
   * effective in QUALITY mode, which runs CFG 2.5; DRAFT is CFG 1.0 and ignores
   * the negative entirely.
   */
  negative?: string;
  /** Your own LoRAs (server/loras.ts checked the family), applied in order. */
  loras?: { name: string; strength: number }[];
  /** FLUX.2 only: reference pictures, input tokens, each a ReferenceLatent. */
  refImages?: string[];
}

/** Chain LoraLoaderModelOnly nodes after `from`; returns the last model output. */
function chainLoras(g: Record<string, unknown>, from: [string, number], loras: StillsParams['loras']): [string, number] {
  let model = from;
  (loras ?? []).forEach((l, i) => {
    g[`ulora${i}`] = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: l.name, strength_model: l.strength } };
    model = [`ulora${i}`, 0];
  });
  return model;
}

function qwenGraph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const g0: Record<string, unknown> = {};
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('qwen.model'), weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('qwen.textEncoder'), type: 'qwen_image', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: slotFile('qwen.vae') } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.negative ?? '' } },
    lat: { class_type: 'EmptySD3LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    k: {
      class_type: 'KSampler',
      inputs: {
        model: chainLoras(g0, [draft ? 'lora' : 'u', 0], p.loras), positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0],
        seed: p.seed,
        steps: draft ? 8 : 50,
        cfg: draft ? 1.0 : 2.5,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['d', 0], filename_prefix: 'OpenField_still' } },
  };
  if (draft) {
    g.lora = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['u', 0], lora_name: slotFile('qwen.lightning'), strength_model: 1.0 },
    };
  }
  return { ...g, ...g0 };
}

function flux2Graph(p: StillsParams): Record<string, unknown> {
  const draft = p.quality === 'draft';
  const steps = draft ? 8 : 20;
  const g0: Record<string, unknown> = {};
  const model = chainLoras(g0, [draft ? 'lora' : 'u', 0], p.loras);
  let cond: [string, number] = ['pos', 0];
  (p.refImages ?? []).forEach((image, i) => {
    Object.assign(g0, {
      [`ri${i}`]: { class_type: 'LoadImage', inputs: { image } },
      [`rs${i}`]: { class_type: 'ImageScaleToTotalPixels', inputs: { image: [`ri${i}`, 0], upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 16 } },
      [`re${i}`]: { class_type: 'VAEEncode', inputs: { pixels: [`rs${i}`, 0], vae: ['v', 0] } },
      [`rl${i}`]: { class_type: 'ReferenceLatent', inputs: { conditioning: cond, latent: [`re${i}`, 0] } },
    });
    cond = [`rl${i}`, 0];
  });
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('flux2.model'), weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('flux2.textEncoder'), type: 'flux2', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: slotFile('flux2.vae') } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['c', 0], text: p.prompt } },
    fg: { class_type: 'FluxGuidance', inputs: { conditioning: cond, guidance: 4 } },
    guider: { class_type: 'BasicGuider', inputs: { model, conditioning: ['fg', 0] } },
    sched: { class_type: 'Flux2Scheduler', inputs: { steps, width: p.width, height: p.height } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    lat: { class_type: 'EmptyFlux2LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    sca: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sched', 0], latent_image: ['lat', 0] },
    },
    d: { class_type: 'VAEDecode', inputs: { samples: ['sca', 0], vae: ['v', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['d', 0], filename_prefix: 'OpenField_still' } },
  };
  if (draft) {
    g.lora = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['u', 0], lora_name: slotFile('flux2.turbo'), strength_model: 1.0 },
    };
  }
  return { ...g, ...g0 };
}

export function buildStillsGraph(p: StillsParams): Record<string, unknown> {
  return p.model === 'flux2' ? flux2Graph(p) : qwenGraph(p);
}
