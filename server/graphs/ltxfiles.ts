/**
 * The four LTX-2.5 weight files every LTX-2.5 graph loads, in one place.
 *
 * The defaults are the stock Lightricks files (the ltx25 bundle in
 * server/models.ts). Each one can be swapped for another file through the
 * environment (or .env), for a fine-tune or a different quantization of the
 * same model:
 *
 *   OPENFIELD_LTX25_TRANSFORMER    UNETLoader      models/diffusion_models/
 *   OPENFIELD_LTX25_TEXT_ENCODER   CLIPLoader      models/text_encoders/
 *   OPENFIELD_LTX25_VIDEO_VAE      VAELoader       models/vae/
 *   OPENFIELD_LTX25_AUDIO_VAE      VAELoader       models/vae/
 *
 * A value is the name exactly as ComfyUI lists it in that loader, so a file in
 * a subfolder keeps its folder prefix (ComfyUI on Windows writes it with a
 * backslash: ltx25\my-transformer.safetensors).
 *
 * The values are read when a graph is built, not when this module loads, so a
 * test or a script can set or clear them at run time.
 */

export type Ltx25Slot = 'transformer' | 'textEncoder' | 'videoVae' | 'audioVae';

/** The stock Lightricks files, as the ltx25 bundle downloads them. */
export const LTX25_STOCK: Readonly<Record<Ltx25Slot, string>> = {
  transformer: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
  textEncoder: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
  videoVae: 'ltx-2.5-video-vae-bf16.safetensors',
  audioVae: 'ltx-2.5-audio-vae-bf16.safetensors',
};

/** The environment variable that overrides each slot. */
export const LTX25_ENV: Readonly<Record<Ltx25Slot, string>> = {
  transformer: 'OPENFIELD_LTX25_TRANSFORMER',
  textEncoder: 'OPENFIELD_LTX25_TEXT_ENCODER',
  videoVae: 'OPENFIELD_LTX25_VIDEO_VAE',
  audioVae: 'OPENFIELD_LTX25_AUDIO_VAE',
};

const SLOTS = Object.keys(LTX25_STOCK) as Ltx25Slot[];

/** Only the slots that are overridden, with their configured file names. */
export function ltx25Overrides(env: NodeJS.ProcessEnv = process.env): Partial<Record<Ltx25Slot, string>> {
  const out: Partial<Record<Ltx25Slot, string>> = {};
  for (const s of SLOTS) {
    const v = (env[LTX25_ENV[s]] ?? '').trim();
    if (v) out[s] = v;
  }
  return out;
}

/** The file each slot loads: the override when one is set, otherwise the stock file. */
export function ltx25Files(env: NodeJS.ProcessEnv = process.env): Record<Ltx25Slot, string> {
  return { ...LTX25_STOCK, ...ltx25Overrides(env) };
}

/**
 * Drop the overrides from this process, so every graph built afterwards uses
 * the stock files. `npm run workflows` calls this: the exported workflows are
 * the shared examples in the repo and must not pick up one machine's .env.
 */
export function clearLtx25Overrides(env: NodeJS.ProcessEnv = process.env): void {
  for (const s of SLOTS) delete env[LTX25_ENV[s]];
}
