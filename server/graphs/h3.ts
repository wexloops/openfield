/**
 * MiniMax H3 graph builders — API-format ComfyUI graphs, derived from the
 * bench graphs validated 2026-08-04 (soundbath / EXO dialogue / corridor
 * action). One builder covers i2v, first+last-frame (loops), and
 * reference mode; the mode is inferred from which images are present.
 */

export interface H3Params {
  prompt: string;
  width: number;   // multiple of 32
  height: number;  // multiple of 32
  lengthFrames: number; // snapped to 17k+5 grid by snapH3Length
  seed: number;
  steps: number;
  startImage?: string; // ComfyUI input-folder filename
  endImage?: string;
  refImages?: string[]; // reference mode (ref2va checkpoint)
  /** Optional checkpoint override (must belong to the right family). */
  checkpoint?: string;
  /** Optional LoRA (e.g. the lightx2v fl2v turbo step-distills). */
  extraLora?: string;
  extraLoraStrength?: number;
  /** Turbo preset id from H3_TURBO_PRESETS; '' / undefined = full sampling. */
  turbo?: string;
  /**
   * Mux the generated audio into the file. OFF by default: H3 is natively
   * audio-video and will invent room tone and mumbled voices under any prompt,
   * which is noise on a visual loop. The audio latent is still sampled either
   * way, because the sampler expects the concatenated AV latent, so this
   * changes the delivered file and not the picture.
   * Turn it on for dialogue work, where the voice is the point.
   */
  withAudio?: boolean;
}

/**
 * lightx2v step-distill LoRAs (Apache-2.0). These cut sampling from 20 steps to
 * 4-8, guidance-free, using video/audio sigma shift 6/3 and strength 1.0.
 *
 * NOTE: the distills are family-specific — an fl2v LoRA cannot drive the ref2va
 * checkpoint. Reference mode has only the v0.1 4-step distill, so any turbo
 * preset collapses to that one there (see resolveTurbo).
 *
 * The base MiniMax-H3 license still excludes the US; turbo changes speed, not
 * licensing. Local H3 output stays out of paid deliverables until licensed.
 *
 * MEASURED 8/20 — turbo did NOT pay off at small sizes, and the reason is memory,
 * not sampling. The 5090 sits at ~1.5GB free VRAM with the 20GB UNET + 15GB text
 * encoder resident (~35GB against 31.8GB), so it is already offload-bound before
 * a 1.9GB LoRA is added. At 640x384/56f the numbers were dominated by weight
 * movement and refused to stabilise:
 *   full  20-step : 40.0s, 89.4s                      (2.2x spread)
 *   turbo  4-step : 344.8, 309.1, 221.8, 191.0, 62.4s (5.5x spread, trending
 *                   down over consecutive runs as memory settled)
 * Turbo's best was still slower than full's best. Do not assume the ~5x the step
 * count implies — on this card it is not there at this size.
 *
 * Where turbo should actually win: hero sizes where sampling takes tens of
 * minutes and the one-off load amortises to noise (the logged 1344x768/362f run
 * was 78min at 20 steps). UNBENCHED there — verify before trusting it.
 *
 * Either way, switching turbo on/off re-patches the UNET, so batch shots at one
 * setting rather than alternating shot-to-shot.
 */
export interface H3TurboPreset {
  id: string;
  label: string;
  steps: number;
  /** Omit both to skip MiniMaxH3SigmaShift entirely. The lightx2v step-distills
   *  are trained against a shifted schedule and need it; the FastVideo DMD2
   *  distill is not and renders correctly without it. */
  shiftVideo?: number;
  shiftAudio?: number;
  fl2vaLora: string;
  note: string;
}

export const H3_REF_TURBO_LORA =
  'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors';
export const H3_REF_TURBO_STEPS = 4;

export const H3_TURBO_PRESETS: H3TurboPreset[] = [
  {
    id: 'fasth3-6',
    label: '6-STEP · FASTH3',
    steps: 6,
    // No sigma shift: this is a DMD2 distill, not a lightx2v step-distill.
    fl2vaLora: 'minimax_h3_fasth3_4step_dense_comfy.safetensors',
    note: 'FastVideo DMD2 distill. Measured 2.09 s/frame at HERO vs 2.71 for the 4-step lightx2v — about 23% faster, and follows the prompt harder.',
  },
  {
    id: 'v11-4',
    label: '4-STEP · v1.1',
    steps: 4,
    shiftVideo: 6,
    shiftAudio: 3,
    fl2vaLora: 'minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors',
    note: 'Newest (8/20). Delta vs v1.0 is undocumented upstream — A/B it.',
  },
  {
    id: 'v10-4',
    label: '4-STEP · v1.0',
    steps: 4,
    shiftVideo: 6,
    shiftAudio: 3,
    fl2vaLora: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
    note: 'The known-quantity 4-step distill.',
  },
  {
    id: 'v10-8',
    label: '8-STEP · v1.0',
    steps: 8,
    shiftVideo: 6,
    shiftAudio: 3,
    fl2vaLora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
    note: 'Twice the steps — closer to base quality, still ~2.5x faster.',
  },
];

/** Resolve a preset id + mode into the LoRA/steps/shift actually applied. */
export function resolveTurbo(
  turboId: string | undefined,
  useRef: boolean,
): { lora: string; steps: number; shiftVideo?: number; shiftAudio?: number } | null {
  if (!turboId) return null;
  const preset = H3_TURBO_PRESETS.find((p) => p.id === turboId);
  if (!preset) return null;
  if (useRef) {
    // Only one ref2v distill exists; every preset maps to it at its own 4 steps.
    return {
      lora: H3_REF_TURBO_LORA,
      steps: H3_REF_TURBO_STEPS,
      shiftVideo: preset.shiftVideo,
      shiftAudio: preset.shiftAudio,
    };
  }
  return {
    lora: preset.fl2vaLora,
    steps: preset.steps,
    shiftVideo: preset.shiftVideo,
    shiftAudio: preset.shiftAudio,
  };
}

export const H3_MODELS = {
  fl2va: 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
  ref2va: 'minimax_h3_ref2va_pruned_fp8_scaled.safetensors',
  clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
};

/** Why a turbo preset cannot run with the LoRAs ComfyUI lists (`have`), or null when it can. */
export function turboProblem(turbo: string, useRef: boolean, have: ReadonlySet<string>): string | null {
  const t = resolveTurbo(turbo, useRef);
  if (!t) return `Unknown H3 turbo preset "${turbo}". Use one of: ${H3_TURBO_PRESETS.map((p) => p.id).join(', ')}.`;
  if (have.has(t.lora)) return null;
  return `The H3 turbo preset "${turbo}" needs ${t.lora} in models/loras/. "npm run models -- --only h3-turbo" fetches the lightx2v distills.`;
}

/** Frame counts must sit on the model's 17k+5 grid (5, 22, ..., 124, ..., 362). */
export function snapH3Length(frames: number): number {
  const k = Math.round((frames - 5) / 17);
  return Math.max(5, Math.min(362, 17 * Math.max(0, k) + 5));
}

/** Which node the scheduler and guider should read the model from. */
function useShiftSrc(
  turbo: { shiftVideo?: number; shiftAudio?: number } | null,
  useLora: boolean,
): string {
  if (turbo && turbo.shiftVideo !== undefined && turbo.shiftAudio !== undefined) return 'shift';
  return useLora ? 'lora' : 'u';
}

export function buildH3Graph(p: H3Params): Record<string, unknown> {
  const useRef = !!p.refImages?.length;
  const family = useRef ? 'ref2va' : 'fl2va';
  // Checkpoint override is honored only within the correct model family —
  // an fl2va file can't drive the ref graph and vice versa.
  const unetName =
    p.checkpoint && p.checkpoint.includes(`minimax_h3_${family}`)
      ? p.checkpoint
      : H3_MODELS[family];
  // Turbo wins over a hand-picked extraLora: the distill and its sigma shift are
  // a matched pair, and stacking a second LoRA on top muddies both.
  const turbo = resolveTurbo(p.turbo, useRef);
  const loraName = turbo ? turbo.lora : p.extraLora;
  const steps = turbo ? turbo.steps : p.steps;
  // A LoRA is spliced between the UNET and its two consumers (scheduler +
  // guider); both must read the patched model or the distill only half-applies.
  // No CLIP side: H3 runs CFG 1 with no negative conditioning.
  const useLora = typeof loraName === 'string' && loraName.length > 0;
  // Sigma shift sits AFTER the LoRA so the shifted sigmas apply to the patched
  // model. Only turbo sets it — full sampling keeps the model's own schedule.
  const modelSrc = useShiftSrc(turbo, useLora);
  const g: Record<string, unknown> = {
    u: { class_type: 'UNETLoader', inputs: { unet_name: unetName, weight_dtype: 'default' } },
    c: { class_type: 'CLIPLoader', inputs: { clip_name: H3_MODELS.clip, type: 'minimax', device: 'default' } },
    vv: { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.videoVae } },
    va: { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.audioVae } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    sched: { class_type: 'BasicScheduler', inputs: { model: [modelSrc, 0], scheduler: 'simple', steps, denoise: 1.0 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    guider: { class_type: 'BasicGuider', inputs: { model: [modelSrc, 0], conditioning: ['gen', 0] } },
    sca: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sched', 0], latent_image: ['gen', 1] },
    },
    dv: { class_type: 'VAEDecode', inputs: { samples: ['sca', 0], vae: ['vv', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dv', 0], fps: 24 } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: 'video/OpenField', format: 'auto', codec: 'auto' } },
  };

  // Decode and mux the audio track only when it is actually wanted. The audio
  // VAE is loaded regardless above; leaving it unconsumed is harmless.
  if (p.withAudio) {
    g.da = { class_type: 'VAEDecodeAudio', inputs: { samples: ['sca', 0], vae: ['va', 0] } };
    (g.vid as { inputs: Record<string, unknown> }).inputs.audio = ['da', 0];
  }

  if (useLora) {
    g.lora = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['u', 0],
        lora_name: loraName,
        // Distills are trained for strength 1.0; only a manual LoRA is dialable.
        strength_model: turbo
          ? 1.0
          : Number.isFinite(p.extraLoraStrength)
            ? p.extraLoraStrength
            : 1.0,
      },
    };
  }

  const useShift = !!turbo && turbo.shiftVideo !== undefined && turbo.shiftAudio !== undefined;
  if (useShift) {
    g.shift = {
      class_type: 'MiniMaxH3SigmaShift',
      inputs: {
        model: [useLora ? 'lora' : 'u', 0],
        shift_video: turbo!.shiftVideo,
        shift_audio: turbo!.shiftAudio,
      },
    };
  }

  const genInputs: Record<string, unknown> = {
    clip: ['c', 0],
    vae: ['vv', 0],
    prompt: p.prompt,
    width: p.width,
    height: p.height,
    length: snapH3Length(p.lengthFrames),
  };

  if (useRef) {
    // Reference mode: each ref is its own dynamic dotted input slot
    // (ref_images.ref_image_N), per the official r2v template wiring.
    const refs = (p.refImages || []).slice(0, 4);
    refs.forEach((name, i) => {
      g[`ref${i}`] = { class_type: 'LoadImage', inputs: { image: name } };
      genInputs[`ref_images.ref_image_${i}`] = [`ref${i}`, 0];
    });
    genInputs.audio_vae = ['va', 0];
    // 'match' scales refs to the generation's pixel area (fast);
    // 'max' = 2048px identity-fidelity mode but several times slower.
    genInputs.ref_image_size = 'match';
    g.gen = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: genInputs };
  } else {
    if (p.startImage) {
      g.ls = { class_type: 'LoadImage', inputs: { image: p.startImage } };
      g.ss = {
        class_type: 'ImageScaleToTotalPixels',
        inputs: { image: ['ls', 0], upscale_method: 'lanczos', megapixels: (p.width * p.height) / 1e6, resolution_steps: 32 },
      };
      genInputs.first_frame = ['ss', 0];
    }
    if (p.endImage) {
      g.le = { class_type: 'LoadImage', inputs: { image: p.endImage } };
      g.se = {
        class_type: 'ImageScaleToTotalPixels',
        inputs: { image: ['le', 0], upscale_method: 'lanczos', megapixels: (p.width * p.height) / 1e6, resolution_steps: 32 },
      };
      genInputs.last_frame = ['se', 0];
    }
    g.gen = { class_type: 'MiniMaxH3ImageToVideo', inputs: genInputs };
  }

  return g;
}
