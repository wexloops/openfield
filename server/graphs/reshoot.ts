/**
 * Reshoot: re-render an existing clip from a new camera angle.
 *
 * Pipeline (all local):
 *   source clip -> Run MoGe Inference (MoGe-2 metric geometry, core ComfyUI)
 *               -> CrossView Warp (cseti007/ComfyUI-CrossViewWarp): the clip
 *                  reprojected into the target camera, magenta where the source
 *                  camera never saw anything
 *   LTX-2.5 distilled + Cseti's CrossView-Warp v2 IC-LoRA (trained on LTX-2.3,
 *   loads on the 2.5 transformer the same way the Union Control LoRA does in
 *   ./mirror.ts) re-renders the shot from two IC-LoRA reference guides:
 *     guide 1 = the warp   (geometry: where things should land)
 *     guide 2 = the source (identity: what things look like)
 *
 * Settings taken from the LoRA card / node README, not guessed:
 *   - guide order [warp, source], matching the training references.
 *   - latent_downscale_factor = 1 on BOTH guides. A mismatch breaks the result
 *     silently; nothing downstream catches it.
 *   - the prompt is the trigger word "crossview". Extra text is only useful to
 *     describe content a wider / moved frame newly reveals.
 *   - pose: azimuth +-45 / elevation -20..+30 is the reliable range. Near-zero
 *     angles misbehave (warp almost identical to the source). `distance` is not
 *     followed reliably by v2, so it is pinned to 1.0 here.
 *
 * Single stage at the requested size, distilled sigmas, CFG 1 (same sampler
 * recipe as Mirror). The author's reference graph uses LTX-2.3 dev + distill
 * LoRA 0.6 and a 2x upscale pass; we skip both for speed.
 */
import { snapFrames } from './ltx25.js';
import { slotFile } from './slots.js';

export interface ReshootKeyframe {
  /** Frame number, 1-based (the CrossView Warp node's convention). */
  f: number;
  az: number;
  el: number;
}

export interface ReshootParams {
  prompt: string;
  sourceVideo: string;          // asset token for VHS_LoadVideo
  width: number;
  height: number;
  seconds: number;
  seed: number;
  azimuth: number;              // deg, + orbits right
  elevation: number;            // deg, + rises above the subject
  /** Optional camera move. >= 2 keyframes switch the warp to a per-frame path;
   *  before the first / after the last keyframe the pose holds. */
  keyframes?: ReshootKeyframe[];
  withAudio?: boolean;
  filenamePrefix?: string;
  /** IC-LoRA strength. Card: 1.3 for people, 1.0-1.15 for cars / strong priors. */
  loraStrength?: number;
  /** Assumed source lens, horizontal FOV in degrees. 0 = read it from MoGe. */
  hfov?: number;
  /** Orbit pivot depth in metres (MoGe depth is metric), on the source
   *  camera's optical axis. Should sit on the subject: ~0.5 for a phone
   *  selfie, ~1 for a mid shot, 3+ for a wide room. Default 1.05 (the node's
   *  own default). Too deep and the camera swings metres sideways and throws
   *  a near subject out of frame. Tune it against the warp preview. */
  pivotDepth?: number;
}

export const MOGE_MODEL = 'moge_2_vitl_normal_fp16.safetensors';
const SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
const NEGATIVE = 'magenta, pink holes, smeared, warped, distorted face, blurry, low quality, text, watermark';
const TRIGGER = 'crossview.';
const FPS = 24;

const snap32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);

/**
 * Nodes shared by both builders: load + fit the source, MoGe geometry, warp.
 * Output ids: `srcFit` (IMAGE, W x H), `warp` (0 = warp video, 1 = orbit view).
 */
function warpNodes(p: Pick<ReshootParams, 'sourceVideo' | 'width' | 'height' | 'seconds' | 'azimuth' | 'elevation' | 'keyframes' | 'hfov' | 'pivotDepth'>) {
  const W = snap32(p.width);
  const H = snap32(p.height);
  const frames = snapFrames(p.seconds, FPS);

  // Keyframe path in the node's JSON format. dist pinned to 1 (see header).
  // Clamped to the clip: a keyframe past the last frame is an error in the node.
  const kfs = (p.keyframes ?? [])
    .map((k) => ({ f: Math.min(frames, Math.max(1, Math.round(k.f))), az: k.az, el: k.el, dist: 1.0 }))
    .sort((a, b) => a.f - b.f);
  const moving = kfs.length >= 2;

  const g: Record<string, any> = {
    src: {
      class_type: 'VHS_LoadVideo',
      inputs: {
        video: p.sourceVideo, force_rate: FPS, custom_width: W, custom_height: H,
        frame_load_cap: frames, skip_first_frames: 0, select_every_nth: 1,
      },
    },
    // VHS keeps aspect when it resizes; force the exact latent size here so the
    // warp, the source guide and the latent all agree pixel for pixel.
    srcFit: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },

    mogeModel: { class_type: 'LoadMoGeModel', inputs: { model_name: MOGE_MODEL } },
    // resolution_level 2 is what the author's v2 graph runs; it is plenty for a
    // warp that the LoRA only treats as a suggestion, and much faster than 9.
    // apply_mask turns sky / invalid pixels into holes instead of a far plane.
    moge: {
      class_type: 'MoGeInference',
      inputs: {
        moge_model: ['mogeModel', 0], image: ['srcFit', 0], resolution_level: 2,
        fov_x_degrees: 0, batch_size: 4, force_projection: true, apply_mask: true, refine_steps: 0,
      },
    },
    warp: {
      class_type: 'CrossViewWarp',
      inputs: {
        frames: ['srcFit', 0], moge_geometry: ['moge', 0],
        azimuth: p.azimuth, elevation: p.elevation, distance: 1.0,
        hfov: p.hfov ?? 0, vertical_shift: 0, depth_ratio: 6.0,
        // depth_ratio / smooth_depth / invert_depth are ignored on the metric
        // MoGe path; they are required inputs so they still have to be sent.
        smooth_depth: false, invert_depth: false, roll_lock: false,
        // Explicit pivot, never the node's auto pivot. Auto = median 3D point
        // of the central region of frame 0, which on an off-centre subject is
        // the back wall: measured on a selfie clip it put the pivot ~3 m deep,
        // the 30 deg orbit moved the camera ~1.5 m and the face left the frame.
        // The orbit radius is distance * |pivot|, so the pivot sets how far
        // the camera actually travels.
        pivot_override: true, pivot_x: 0, pivot_y: 0, pivot_z: p.pivotDepth ?? 1.05,
        use_keyframes: moving, frame_count: 0,
        keyframes: moving ? JSON.stringify(kfs) : '',
        interp_motion: 'ease_in_out', interpolation: 'linear',
        // Keep the source camera's aim: what the training data does, and it
        // measured closer to the training warps (author: 28.9 vs 42.3).
        keep_source_aim: true,
        preview_size: 384, frame_index: 1,
      },
    },
  };
  return { g, W, H, frames };
}

export function buildReshootGraph(p: ReshootParams): Record<string, unknown> {
  const { g: w, W, H, frames } = warpNodes(p);
  const text = p.prompt.trim() ? `${TRIGGER} ${p.prompt.trim()}` : TRIGGER;

  const g: Record<string, any> = {
    ...w,
    unet: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('ltx25.transformer'), weight_dtype: 'default' } },
    // LTXICLoRALoaderModelOnly = LoraLoaderModelOnly that also reads the
    // LoRA's trained reference downscale. We still hard-set 1 on the guides,
    // which is what this LoRA was trained with.
    lora: { class_type: 'LTXICLoRALoaderModelOnly', inputs: { model: ['unet', 0], lora_name: slotFile('ltx25-loras.reshoot'), strength_model: p.loraStrength ?? 1.3 } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('ltx25.textEncoder'), type: 'ltxv' } },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.videoVae') } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.audioVae') } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: NEGATIVE } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: FPS } },

    lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: W, height: H, length: frames, batch_size: 1 } },
    // Guide 1: the warp (geometry). frame_idx 0 = aligned with the generated clip.
    gWarp: {
      class_type: 'LTXAddVideoICLoRAGuide',
      inputs: {
        positive: ['cond', 0], negative: ['cond', 1], vae: ['vvae', 0], latent: ['lat', 0],
        image: ['warp', 0], frame_idx: 0, strength: 1.0, latent_downscale_factor: 1,
        crop: 'disabled', use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
      },
    },
    // Guide 2: the untouched source (identity), chained onto guide 1.
    gSrc: {
      class_type: 'LTXAddVideoICLoRAGuide',
      inputs: {
        positive: ['gWarp', 0], negative: ['gWarp', 1], vae: ['vvae', 0], latent: ['gWarp', 2],
        image: ['srcFit', 0], frame_idx: 0, strength: 1.0, latent_downscale_factor: 1,
        crop: 'disabled', use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
      },
    },
    // The model is natively audio-video; the sampler expects the AV latent even
    // when the audio is thrown away.
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: FPS, batch_size: 1, audio_vae: ['avae', 0] } },
    av: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['gSrc', 2], audio_latent: ['latA', 0] } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['lora', 0], positive: ['gSrc', 0], negative: ['gSrc', 1], cfg: 1.0 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    sample: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['av', 0] },
    },
    split: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } },
    // Strips both reference guides' frames back off the latent before decode.
    crop: { class_type: 'LTXVCropGuides', inputs: { positive: ['gSrc', 0], negative: ['gSrc', 1], latent: ['split', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['crop', 2], vae: ['vvae', 0] } },
    video: { class_type: 'CreateVideo', inputs: { images: ['decode', 0], fps: FPS } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: p.filenamePrefix ?? 'openfield/reshoot', format: 'auto', codec: 'auto' } },
  };

  if (p.withAudio) {
    g.adec = { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['split', 1], audio_vae: ['avae', 0] } };
    g.video.inputs.audio = ['adec', 0];
  }
  return g;
}

/**
 * Cheap preview: MoGe + warp only, no diffusion. Saves the magenta-hole warp
 * video (what the LoRA will be steered by) and the orbit-sphere still that
 * documents the requested pose. Seconds of GPU, not minutes.
 */
export function buildReshootWarpPreviewGraph(
  p: Omit<ReshootParams, 'prompt' | 'seed' | 'withAudio' | 'loraStrength'>
): Record<string, unknown> {
  const { g } = warpNodes(p);
  const prefix = p.filenamePrefix ?? 'openfield/reshoot-warp';
  return {
    ...g,
    video: { class_type: 'CreateVideo', inputs: { images: ['warp', 0], fps: FPS } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } },
    saveOrbit: { class_type: 'SaveImage', inputs: { images: ['warp', 1], filename_prefix: `${prefix}-orbit` } },
  };
}
