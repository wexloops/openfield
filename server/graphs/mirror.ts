/**
 * Mirror: motion transfer. A source clip (a phone take) is turned into a
 * control track (pose, depth or edges), and LTX-2.5 with the IC-LoRA Union
 * Control re-renders it as a new character / world from the prompt and an
 * optional first frame.
 *
 * Port of a graph proven 2026-09-03 (13s in 170s at 896x512 on a 5090).
 * Single stage at full resolution, distilled sigmas, CFG 1.
 *
 * Key behavior: the first frame (when given) must share the source clip's
 * framing, or the guide fights it and the shot dissolves.
 */
import { snapFrames } from './ltx25.js';
import { slotFile } from './slots.js';

export type MirrorControl = 'pose' | 'depth' | 'edges';

export interface MirrorParams {
  prompt: string;
  negative?: string;
  sourceVideo: string;     // asset token for VHS_LoadVideo
  firstFrame?: string;     // asset token for LoadImage
  width: number;
  height: number;
  seconds: number;
  seed: number;
  control: MirrorControl;
  guideStrength?: number;  // 0..1, how hard the control track pulls
  withAudio?: boolean;
  filenamePrefix?: string;
}

const SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
const NEGATIVE = 'stick figure, skeleton, colored lines, wireframe, blurry, low quality, text, watermark';
const FPS = 24;

/** The IC-LoRA guide runs at half resolution, so the latent grid (1/32) must be even: 64-aligned pixels. */
const snap64 = (n: number) => Math.max(128, Math.round(n / 64) * 64);

export function buildMirrorGraph(p: MirrorParams): Record<string, unknown> {
  const W = snap64(p.width);
  const H = snap64(p.height);
  const frames = snapFrames(p.seconds, FPS);

  const g: Record<string, any> = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('ltx25.transformer'), weight_dtype: 'default' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: slotFile('ltx25-loras.mirror'), strength_model: 1.0 } },
    icp: { class_type: 'GetICLoRAParameters', inputs: { iclora_model: ['lora', 0] } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('ltx25.textEncoder'), type: 'ltxv' } },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.videoVae') } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.audioVae') } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.negative ?? NEGATIVE } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: FPS } },

    src: {
      class_type: 'VHS_LoadVideo',
      inputs: {
        video: p.sourceVideo, force_rate: FPS, custom_width: W, custom_height: H,
        frame_load_cap: frames, skip_first_frames: 0, select_every_nth: 1,
      },
    },
    ctrlFit: { class_type: 'ImageScale', inputs: { image: ['ctrl', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },

    lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: W, height: H, length: frames, batch_size: 1 } },
    guide: {
      class_type: 'LTXVAddGuide',
      inputs: {
        positive: ['cond', 0], negative: ['cond', 1], vae: ['vvae', 0],
        latent: p.firstFrame ? ['ff', 0] : ['lat', 0],
        image: ['ctrlFit', 0], frame_idx: 0, strength: p.guideStrength ?? 1.0, iclora_parameters: ['icp', 0],
      },
    },
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: FPS, batch_size: 1, audio_vae: ['avae', 0] } },
    av: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['guide', 2], audio_latent: ['latA', 0] } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['lora', 0], positive: ['guide', 0], negative: ['guide', 1], cfg: 1.0 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    sample: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['av', 0] },
    },
    split: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } },
    crop: { class_type: 'LTXVCropGuides', inputs: { positive: ['guide', 0], negative: ['guide', 1], latent: ['split', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['crop', 2], vae: ['vvae', 0] } },
    video: { class_type: 'CreateVideo', inputs: { images: ['decode', 0], fps: FPS } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: p.filenamePrefix ?? 'openfield/mirror', format: 'auto', codec: 'auto' } },
  };

  if (p.withAudio) {
    g.adec = { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['split', 1], audio_vae: ['avae', 0] } };
    g.video.inputs.audio = ['adec', 0];
  }

  if (p.firstFrame) {
    g.ffLoad = { class_type: 'LoadImage', inputs: { image: p.firstFrame } };
    g.ffFit = { class_type: 'ImageScale', inputs: { image: ['ffLoad', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } };
    g.ff = { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['vvae', 0], image: ['ffFit', 0], latent: ['lat', 0], strength: 1.0, bypass: false } };
  }

  if (p.control === 'pose') {
    g.ctrl = {
      class_type: 'DWPreprocessor',
      inputs: {
        image: ['src', 0], detect_hand: 'enable', detect_body: 'enable', detect_face: 'enable', resolution: 512,
        bbox_detector: 'yolox_l.onnx', pose_estimator: 'dw-ll_ucoco_384_bs5.torchscript.pt', scale_stick_for_xinsr_cn: 'disable',
      },
    };
  } else if (p.control === 'depth') {
    g.ctrl = { class_type: 'DepthAnythingV2Preprocessor', inputs: { image: ['src', 0], ckpt_name: 'depth_anything_v2_vits.pth', resolution: 512 } };
  } else {
    g.ctrl = { class_type: 'CannyEdgePreprocessor', inputs: { image: ['src', 0], low_threshold: 92, high_threshold: 200, resolution: 512 } };
  }
  return g;
}
