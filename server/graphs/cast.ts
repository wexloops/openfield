/**
 * Cast graphs: the reference sheet and the LTX-2.5 Ingredients video built on it.
 *
 * A reference sheet is one image that inventories who and what is in a shot:
 * a panel per reference picture on a black canvas, no text. It is composed
 * inside the graph (EmptyImage, then ImageScale crop or ResizeAndPadImage per
 * panel, then ImageCompositeMasked), so
 * the workflow that opens in ComfyUI rebuilds the sheet from the same pictures.
 *
 * The video follows Lightricks' LTX-2.5 Ingredients example workflow
 * (ComfyUI-LTXVideo example_workflows/2.5/LTX-2.5_ICLoRA_Ingredients_Single_Stage_Distilled.json):
 *   sheet -> RepeatImageBatch (held on every frame) -> LTXAddVideoICLoRAGuide
 *   (latent_downscale_factor from the IC-LoRA loader) -> one distilled pass,
 *   CFGGuider cfg 1, euler_ancestral_cfg_pp, the 8-step base sigmas ->
 *   LTXVCropGuides -> decode. The sheet steers the whole clip and is never the
 *   first frame. The LoRA was trained at 768x448, 121 frames, 24 fps, with a
 *   "Reference sheet: ... / Generated video: ..." prompt.
 */
import type { SheetLayout, SheetMember } from '../../src/castSheet.js';
export { sheetLayout, type SheetLayout, type SheetMember, type SheetTile } from '../../src/castSheet.js';
import {
  LTX25_FPS, NEGATIVE, snap64, snapFrames,
} from './ltx25.js';
import { ltx25Files } from './ltxfiles.js';

export const INGREDIENTS_LORA = 'ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors';
/** The example workflow's strength. The 2.3 card says 1.4, the 2.5 table 1.0. */
export const INGREDIENTS_STRENGTH = 1.3;
/** The trained bucket (768x448) lives in src/castSheet.ts. Other sizes run, but drift from what the LoRA learned. */
export { INGREDIENTS_SIZE } from '../../src/castSheet.js';
export const INGREDIENTS_MIN_FRAMES = 121;

const SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';

/** Add the nodes that compose a sheet. Returns the output holding the sheet image. */
export function addSheetNodes(g: Record<string, unknown>, layout: SheetLayout, prefix = 'sheet'): [string, number] {
  g[`${prefix}Canvas`] = { class_type: 'EmptyImage', inputs: { width: layout.width, height: layout.height, batch_size: 1, color: 0 } };
  let canvas: [string, number] = [`${prefix}Canvas`, 0];
  layout.tiles.forEach((t, i) => {
    const k = `${prefix}${i + 1}`;
    g[`${k}Load`] = { class_type: 'LoadImage', inputs: { image: t.image } };
    g[`${k}Fit`] = t.fit === 'cover'
      ? { class_type: 'ImageScale', inputs: { image: [`${k}Load`, 0], upscale_method: 'lanczos', width: t.w, height: t.h, crop: 'center' } }
      : { class_type: 'ResizeAndPadImage', inputs: { image: [`${k}Load`, 0], target_width: t.w, target_height: t.h, padding_color: 'black', interpolation: 'lanczos' } };
    g[`${k}Place`] = {
      class_type: 'ImageCompositeMasked',
      inputs: { destination: canvas, source: [`${k}Fit`, 0], x: t.x, y: t.y, resize_source: false },
    };
    canvas = [`${k}Place`, 0];
  });
  return canvas;
}

/** The sheet on its own, saved as a still: what the Cast page previews. */
export function buildCastSheetGraph(layout: SheetLayout, filenamePrefix = 'OpenField_cast_sheet'): Record<string, unknown> {
  const g: Record<string, unknown> = {};
  const sheet = addSheetNodes(g, layout);
  g.save = { class_type: 'SaveImage', inputs: { images: sheet, filename_prefix: filenamePrefix } };
  return g;
}

/** The two-part prompt the LoRA was trained on. */
export function ingredientsPrompt(members: SheetMember[], layout: SheetLayout, shot: string): string {
  const kindWord = { character: 'Character', prop: 'Prop', place: 'Setting' } as const;
  const panels = members
    .map((m, i) => {
      if (!layout.where[i]) return '';
      const views = m.kind === 'character' ? ' Shown in reference views of the same person.' : '';
      const n = m.notes.trim().replace(/[.\s]+$/, '');
      const notes = n ? ` ${n.charAt(0).toUpperCase()}${n.slice(1)}.` : '';
      return `${layout.where[i]} (${kindWord[m.kind]}): ${m.name}.${notes}${views}`;
    })
    .filter(Boolean)
    .join(' ');
  return `Reference sheet: ${panels}\n\nGenerated video: ${shot.trim()}`;
}

export interface CastVideoParams {
  prompt: string;              // already in "Reference sheet: / Generated video:" form
  negative?: string;
  layout: SheetLayout;         // the sheet is the output size (downscale factor 1)
  seconds: number;
  seed: number;
  strength?: number;
  withAudio?: boolean;
  filenamePrefix?: string;
  /** Your own LTX LoRAs, chained after the Ingredients IC-LoRA. */
  loras?: { name: string; strength: number }[];
}

export function buildCastVideoGraph(p: CastVideoParams): Record<string, unknown> {
  const fps = LTX25_FPS;
  const frames = Math.max(INGREDIENTS_MIN_FRAMES, snapFrames(p.seconds, fps));
  // IC-LoRA guides need a 64-aligned frame (even latent grid).
  const W = snap64(p.layout.width);
  const H = snap64(p.layout.height);
  const layout = W === p.layout.width && H === p.layout.height ? p.layout : { ...p.layout, width: W, height: H };

  const g: Record<string, unknown> = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: ltx25Files().transformer, weight_dtype: 'default' } },
    icl: { class_type: 'LTXICLoRALoaderModelOnly', inputs: { model: ['unet', 0], lora_name: INGREDIENTS_LORA, strength_model: p.strength ?? INGREDIENTS_STRENGTH } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: ltx25Files().textEncoder, type: 'ltxv', device: 'default' } },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: ltx25Files().videoVae } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: ltx25Files().audioVae } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.negative ?? `${NEGATIVE}, worst quality, inconsistent motion, blurry, jittery, distorted` } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: fps } },
  };
  const sheet = addSheetNodes(g, layout);
  let userModel: [string, number] = ['icl', 0];
  (p.loras ?? []).forEach((l, i) => {
    g[`ulora${i}`] = { class_type: 'LoraLoaderModelOnly', inputs: { model: userModel, lora_name: l.name, strength_model: l.strength } };
    userModel = [`ulora${i}`, 0];
  });
  Object.assign(g, {
    // The still sheet held on every frame: the "static video" the LoRA reads.
    hold: { class_type: 'RepeatImageBatch', inputs: { image: sheet, amount: frames } },
    latV: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: W, height: H, length: frames, batch_size: 1 } },
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: ['avae', 0] } },
    guide: {
      class_type: 'LTXAddVideoICLoRAGuide',
      inputs: {
        positive: ['cond', 0], negative: ['cond', 1], vae: ['vvae', 0], latent: ['latV', 0], image: ['hold', 0],
        frame_idx: 0, strength: 1, latent_downscale_factor: ['icl', 1],
        crop: 'disabled', use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
      },
    },
    cat: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['guide', 2], audio_latent: ['latA', 0] } },
    guider: { class_type: 'CFGGuider', inputs: { model: userModel, positive: ['guide', 0], negative: ['guide', 1], cfg: 1 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral_cfg_pp' } },
    sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    s1: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['cat', 0] },
    },
    sep: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['s1', 0] } },
    crop: { class_type: 'LTXVCropGuides', inputs: { positive: ['guide', 0], negative: ['guide', 1], latent: ['sep', 0] } },
    dv: {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['crop', 2], vae: ['vvae', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
    },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dv', 0], fps } },
    save: {
      class_type: 'SaveVideo',
      inputs: { video: ['vid', 0], filename_prefix: p.filenamePrefix ?? 'video/OpenField_cast', format: 'auto', codec: 'auto' },
    },
  });
  if (p.withAudio) {
    g.da = { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['sep', 1], audio_vae: ['avae', 0] } };
    (g.vid as { inputs: Record<string, unknown> }).inputs.audio = ['da', 0];
  }
  return g;
}
