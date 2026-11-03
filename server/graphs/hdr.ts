/**
 * Finish in HDR: LTX-2.5 SDR-to-HDR IC-LoRA. A port of Lightricks' flattened
 * SDR-to-HDR template (ComfyUI-LTXVideo, verified here 10/3 on the int8
 * transformer), driven by OpenField's own params.
 *
 *   SDR clip -> ACEScct working space -> 32-aligned -> IC-LoRA guide at frame 0
 *   -> one distilled pass from fixed scene embeddings (no text encoder)
 *   -> float32 VAE decode -> LTXVHDRDecodePostprocess:
 *        ACEScg scene-linear half-float EXR sequence + a tonemapped SDR preview
 *   -> LTXVSaveHLG: BT.2020 / HLG 10-bit HEVC master.
 *
 * The video VAE wants 8k + 1 frames; anything else and the tail drifts off the
 * source. A clip of another length is padded up to the next 8k + 1 (a loop
 * with its own first frames, so the motion carries on; anything else by
 * holding its last frame) and the decode is cut back to the source length
 * before anything is written, so every output frame lines up with its source
 * frame.
 *
 * The EXRs and the HLG file are written by their nodes into ComfyUI's output
 * folder under `openfield/hdr/<tag>_*`; the server collects them from there.
 * The template's bypassed LTXVImgToVideoInplace (a no-op) is left out.
 */
import { slotFile } from './slots.js';

export const HDR_SCENE_EMB = 'ltx-2.5-22b-ic-lora-sdr-to-hdr-scene-emb.safetensors';
const SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';

/** Next n with n % 8 === 1, at or above `frames`. */
export const next8k1 = (frames: number) => Math.max(9, Math.ceil((frames - 1) / 8) * 8 + 1);

export interface HdrParams {
  /** Input-folder filename or asset token of the SDR clip. */
  video: string;
  /** Frames in the source clip. */
  frames: number;
  /** Pad with the clip's own first frames (a loop) instead of holding the last. */
  loop?: boolean;
  /** Mux the source's sound into the HLG master and the preview. */
  withAudio?: boolean;
  seed: number;
  /** Folder names under ComfyUI's output: `openfield/hdr/<tag>_exr` etc. */
  tag: string;
}

export const hdrPaths = (tag: string) => ({
  exrDir: `openfield/hdr/${tag}_exr`,
  exrPrefix: 'frame',
  hlgPrefix: `openfield/hdr/${tag}_hlg`,
  previewPrefix: `openfield/hdr/${tag}_preview`,
});

export function buildHdrGraph(p: HdrParams): Record<string, unknown> {
  const paths = hdrPaths(p.tag);
  const target = next8k1(p.frames);
  const pad = target - p.frames;
  const audio = p.withAudio ? { audio: ['parts', 1] } : {};
  const g: Record<string, unknown> = {
    load: { class_type: 'LoadVideo', inputs: { file: p.video } },
    parts: { class_type: 'GetVideoComponents', inputs: { video: ['load', 0] } },
  };
  let frames: [string, number] = ['parts', 0];
  if (pad > 0) {
    Object.assign(g, p.loop
      ? { pad: { class_type: 'ImageFromBatch', inputs: { image: ['parts', 0], batch_index: 0, length: pad } } }
      : {
          last: { class_type: 'ImageFromBatch', inputs: { image: ['parts', 0], batch_index: p.frames - 1, length: 1 } },
          pad: { class_type: 'RepeatImageBatch', inputs: { image: ['last', 0], amount: pad } },
        });
    g.padded = { class_type: 'BatchImagesNode', inputs: { 'images.image0': ['parts', 0], 'images.image1': ['pad', 0] } };
    frames = ['padded', 0];
  }
  Object.assign(g, {
    // ---- the SDR source in the LoRA's working space, 32-aligned ----
    ws: { class_type: 'LTXVSDRToHDRWorkingSpace', inputs: { image: frames, color_space: 'srgb_gamma' } },
    fit: {
      class_type: 'ResizeImageMaskNode',
      inputs: { input: ['ws', 0], resize_type: 'scale to multiple', 'resize_type.multiple': 32, scale_method: 'lanczos' },
    },
    size: { class_type: 'GetImageSize', inputs: { image: ['fit', 0] } },
    rate: { class_type: 'ComfyMathExpression', inputs: { expression: 'a if a <= 30 else 30', 'values.a': ['parts', 2] } },

    // ---- loaders ----
    avae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.audioVae') } },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.videoVae') } },
    vae32: { class_type: 'LTXVVAEForceFloat32', inputs: { vae: ['vvae', 0] } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('ltx25.transformer'), weight_dtype: 'default' } },
    icl: { class_type: 'LTXICLoRALoaderModelOnly', inputs: { model: ['unet', 0], lora_name: slotFile('ltx25-loras.hdr'), strength_model: 1 } },

    // ---- conditioning: fixed scene embeddings, no prompt ----
    emb: { class_type: 'LTXVLoadConditioning', inputs: { file_name: HDR_SCENE_EMB, device: 'cpu' } },
    cond0: { class_type: 'LTXVConditioning', inputs: { positive: ['emb', 0], negative: ['emb', 0], frame_rate: ['rate', 0] } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['cond0', 0], negative: ['cond0', 1], frame_rate: ['rate', 0] } },

    // ---- latents + the source as an IC-LoRA guide ----
    latV: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: ['size', 0], height: ['size', 1], length: ['size', 2], batch_size: 1 } },
    guide: {
      class_type: 'LTXAddVideoICLoRAGuide',
      inputs: {
        positive: ['cond', 0], negative: ['cond', 1], vae: ['vae32', 0], latent: ['latV', 0], image: ['fit', 0],
        frame_idx: 0, strength: 1, latent_downscale_factor: ['icl', 1], crop: 'disabled',
        use_tiled_encode: false, tile_size: 256, tile_overlap: 64, use_streaming: false, tile_frames: 97,
      },
    },
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: ['size', 2], frame_rate: ['parts', 2], batch_size: 1, audio_vae: ['avae', 0] } },
    cat: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['guide', 2], audio_latent: ['latA', 0] } },

    // ---- one distilled pass ----
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['icl', 0], positive: ['guide', 0], negative: ['guide', 1], cfg: 1 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    sig: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS } },
    s: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sig', 0], latent_image: ['cat', 0] } },
    sep: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['s', 0] } },
    crop: { class_type: 'LTXVCropGuides', inputs: { positive: ['guide', 0], negative: ['guide', 1], latent: ['sep', 0] } },
    dv: {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['crop', 2], vae: ['vae32', 0], tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 },
    },
  });
  let decoded: [string, number] = ['dv', 0];
  if (pad > 0) {
    // Back to the source length before anything is written.
    g.keep = { class_type: 'ImageFromBatch', inputs: { image: ['dv', 0], batch_index: 0, length: p.frames } };
    decoded = ['keep', 0];
  }
  Object.assign(g, {
    post: {
      class_type: 'LTXVHDRDecodePostprocess',
      inputs: {
        image: decoded, transfer: 'acescct', exposure: 0, save_exr: true, exr_color_space: 'acescg',
        output_dir: paths.exrDir, filename_prefix: paths.exrPrefix, half_precision: true,
      },
    },
    hlg: {
      class_type: 'LTXVSaveHLG',
      inputs: { hdr_linear: ['post', 1], frame_rate: ['parts', 2], filename_prefix: paths.hlgPrefix, linear_primaries: 'acescg', ...audio },
    },
    vid: { class_type: 'CreateVideo', inputs: { images: ['post', 0], fps: ['parts', 2], bit_depth: 'auto', color_space: 'sRGB', codec: 'none', ...audio } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: paths.previewPrefix, format: 'auto', codec: 'auto' } },
  });
  return g;
}
