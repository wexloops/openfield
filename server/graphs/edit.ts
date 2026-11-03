/**
 * Image edit graph: Qwen-Image-Edit 2509 through TextEncodeQwenImageEditPlus.
 *
 * One builder serves every Edit app mode. The modes differ only in the
 * instruction they compile (src/catalog.ts editVariants) and, for Expand, in a
 * padded canvas plus a noise mask.
 *
 *   image1 (the picture being edited) -> scale to the output size -> VAE encode
 *     -> the latent the sampler starts from (denoise 1: the edit model rebuilds
 *        the frame from noise, steered by the reference latents below)
 *   image1..3 + instruction -> TextEncodeQwenImageEditPlus (the VL encoder sees
 *     the images; with a VAE wired in it also attaches each image as a
 *     reference latent) -> positive. Same images + empty text -> negative.
 *   ModelSamplingAuraFlow shift 3 + CFGNorm 1: the official ComfyUI template's
 *   settings for this model.
 *
 * A mask (white = change, black = keep) goes through SetLatentNoiseMask, so the
 * kept pixels are re-imposed every step and come back unchanged.
 *
 * Draft runs a Lightning 8-step LoRA at CFG 1 (the negative is then ignored):
 * the one distilled for Qwen-Image-Edit 2509 when ComfyUI lists it, else the
 * base Qwen-Image one, which still steers the edit model well. New angle and
 * Push in add the Multiple-angles LoRA when present; it was trained on Chinese
 * camera commands, which the recipes in src/catalog.ts include.
 */
import { resolveSlot, slotFile } from './slots.js';

export interface EditParams {
  /** 1 to 3 loader filenames or asset tokens. images[0] is the one edited. */
  images: string[];
  instruction: string;
  /** Output size. images[0] is scaled (stretched, so pass its aspect) to this. */
  width: number;
  height: number;
  seed: number;
  quality: 'draft' | 'quality';
  /** Override the step count (quality default 20, draft 8). */
  steps?: number;
  /** Draft only: the Lightning LoRA to use (default: the qwen.lightning slot). */
  lightning?: string;
  /** Extra LoRAs stacked on the model, e.g. the Multiple-angles LoRA. */
  loras?: { name: string; strength: number }[];
  /** Optional mask image: white = may change, black = keep. */
  mask?: string;
  /**
   * Expand: pad images[0] by these pixels (in output-size pixels, after
   * scaling the source to `inner`) and outpaint only the padding.
   */
  pad?: { left: number; top: number; right: number; bottom: number; inner: { width: number; height: number } };
  /**
   * Compose: every image is a reference (Cast pictures) and the frame is built
   * from an empty latent at width x height. Nothing is edited in place, so no
   * image is stretched to the output size. Ignores pad and mask.
   */
  compose?: boolean;
}

/** Optional upgrades, used when ComfyUI lists them. */
export const EDIT_LIGHTNING_2509 = 'Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors';
export const EDIT_ANGLES_LORA = 'Qwen-Edit-2509-Multiple-angles.safetensors';

/**
 * The draft Lightning LoRA for an edit. A file set for the qwen.lightning
 * slot always wins; on the stock file, the one distilled for
 * Qwen-Image-Edit 2509 is preferred when ComfyUI lists it (have).
 */
export function editLightning(have: Set<string>): string {
  const r = resolveSlot('qwen.lightning');
  return r.source === 'stock' && have.has(EDIT_LIGHTNING_2509) ? EDIT_LIGHTNING_2509 : r.file;
}

export function buildEditGraph(p: EditParams): Record<string, unknown> {
  if (!p.images.length || p.images.length > 3) throw new Error('Edit takes 1 to 3 images');
  const draft = p.quality === 'draft';
  const steps = p.steps ?? (draft ? 8 : 20);
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('qwen.editModel'), weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('qwen.textEncoder'), type: 'qwen_image', device: 'default' } },
    v: { class_type: 'VAELoader', inputs: { vae_name: slotFile('qwen.vae') } },
    norm: { class_type: 'CFGNorm', inputs: { model: ['ms', 0], strength: 1 } },
  };
  // LoRA chain: extras first, then Lightning for draft.
  let model: [string, number] = ['u', 0];
  (p.loras ?? []).forEach((l, i) => {
    g[`lora${i + 1}`] = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: l.name, strength_model: l.strength } };
    model = [`lora${i + 1}`, 0];
  });
  if (draft) {
    g.lora = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: p.lightning ?? slotFile('qwen.lightning'), strength_model: 1 } };
    model = ['lora', 0];
  }
  g.ms = { class_type: 'ModelSamplingAuraFlow', inputs: { model, shift: 3 } };

  if (p.compose) return composeTail(g, p, steps, draft);

  // The edited image, at the output size. Expand scales it to the inner box
  // first, then pads out to the full canvas and records which pixels are new.
  g.img1 = { class_type: 'LoadImage', inputs: { image: p.images[0] } };
  let base: [string, number] = ['s1', 0];
  let mask: [string, number] | null = null;
  if (p.pad) {
    g.s1 = { class_type: 'ImageScale', inputs: { image: ['img1', 0], upscale_method: 'lanczos', width: p.pad.inner.width, height: p.pad.inner.height, crop: 'disabled' } };
    g.pad = {
      class_type: 'ImagePadForOutpaint',
      inputs: { image: ['s1', 0], left: p.pad.left, top: p.pad.top, right: p.pad.right, bottom: p.pad.bottom, feathering: 64 },
    };
    base = ['pad', 0];
    mask = ['pad', 1];
  } else {
    g.s1 = { class_type: 'ImageScale', inputs: { image: ['img1', 0], upscale_method: 'lanczos', width: p.width, height: p.height, crop: 'disabled' } };
  }
  if (p.mask) {
    g.mask = { class_type: 'LoadImageMask', inputs: { image: p.mask, channel: 'red' } };
    mask = ['mask', 0];
  }

  // Reference images for the encoder. For Expand the reference is the picture
  // without its padding: shown the padded canvas, the model faithfully copies
  // the flat border too. The padded canvas is only the sampler's start, where
  // the noise mask pins the original pixels in place.
  const refs: Record<string, [string, number]> = { image1: p.pad ? ['s1', 0] : base };
  p.images.slice(1).forEach((name, i) => {
    g[`img${i + 2}`] = { class_type: 'LoadImage', inputs: { image: name } };
    refs[`image${i + 2}`] = [`img${i + 2}`, 0];
  });
  g.pos = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['c', 0], vae: ['v', 0], prompt: p.instruction, ...refs } };
  g.neg = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['c', 0], vae: ['v', 0], prompt: '', ...refs } };

  g.enc = { class_type: 'VAEEncode', inputs: { pixels: base, vae: ['v', 0] } };
  let latent: [string, number] = ['enc', 0];
  if (mask) {
    g.nm = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['enc', 0], mask } };
    latent = ['nm', 0];
  }
  g.k = {
    class_type: 'KSampler',
    inputs: {
      model: ['norm', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: latent,
      seed: p.seed, steps, cfg: draft ? 1 : 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    },
  };
  g.d = { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } };
  g.save = { class_type: 'SaveImage', inputs: { images: ['d', 0], filename_prefix: 'OpenField_edit' } };
  return g;
}

/**
 * Compose mode: the references go to the encoder as they are (it sizes each one
 * itself), and the sampler starts from an empty latent of the output size.
 */
function composeTail(g: Record<string, unknown>, p: EditParams, steps: number, draft: boolean): Record<string, unknown> {
  const refs: Record<string, [string, number]> = {};
  p.images.forEach((name, i) => {
    g[`img${i + 1}`] = { class_type: 'LoadImage', inputs: { image: name } };
    refs[`image${i + 1}`] = [`img${i + 1}`, 0];
  });
  g.pos = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['c', 0], vae: ['v', 0], prompt: p.instruction, ...refs } };
  g.neg = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['c', 0], vae: ['v', 0], prompt: '', ...refs } };
  g.lat = { class_type: 'EmptySD3LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } };
  g.k = {
    class_type: 'KSampler',
    inputs: {
      model: ['norm', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0],
      seed: p.seed, steps, cfg: draft ? 1 : 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    },
  };
  g.d = { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } };
  g.save = { class_type: 'SaveImage', inputs: { images: ['d', 0], filename_prefix: 'OpenField_cast' } };
  return g;
}

/** Output size for an edit: the source aspect at `mp` megapixels, snapped to 16. */
export function editSize(srcW: number, srcH: number, mp = 1): { width: number; height: number } {
  const ratio = srcW / srcH;
  const h = Math.sqrt((mp * 1e6) / ratio);
  const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return { width: snap(h * ratio), height: snap(h) };
}

/**
 * Expand: fit the source inside a canvas of the target aspect at `mp`, scaled
 * by `zoom` (1 = touch the canvas edges on the tight axis, 0.7 = leave 30% new
 * picture on that axis too), centered. Pads are multiples of 8 (the pad node's
 * step).
 */
export function expandLayout(srcW: number, srcH: number, aspect: number, zoom: number, mp = 1) {
  const H = Math.sqrt((mp * 1e6) / aspect);
  const snap16 = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  const width = snap16(H * aspect);
  const height = snap16(H);
  const fit = Math.min(width / srcW, height / srcH) * Math.min(1, Math.max(0.3, zoom));
  const snap8 = (n: number) => Math.max(64, Math.floor(n / 8) * 8);
  const iw = Math.min(width, snap8(srcW * fit));
  const ih = Math.min(height, snap8(srcH * fit));
  const left = Math.floor((width - iw) / 16) * 8;
  const top = Math.floor((height - ih) / 16) * 8;
  return {
    width, height,
    pad: { left, top, right: width - iw - left, bottom: height - ih - top, inner: { width: iw, height: ih } },
  };
}
