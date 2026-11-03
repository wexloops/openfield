/**
 * Model slots: every weight file a graph builder loads for a model family, in
 * one place, so another file (a fine-tune, another quantization) can take a
 * slot without a code change.
 *
 * Each slot has a stock file (the one its bundle in server/models.ts
 * downloads), the ComfyUI models folder its loader lists, and an environment
 * variable. The file a slot loads is the variable's value from the environment
 * or .env when it is set, else the stock file.
 *
 * A value is the name exactly as ComfyUI lists it in that loader, so a file in
 * a subfolder keeps its folder prefix (ComfyUI on Windows writes it with a
 * backslash: ltx25\my-transformer.safetensors).
 *
 * Builders call slotFile() while they build a graph, not when a module loads,
 * so a test or a script can set or clear the variables at run time.
 */

export type SlotDir =
  | 'diffusion_models'
  | 'text_encoders'
  | 'vae'
  | 'loras'
  | 'latent_upscale_models'
  | 'model_patches';

export const SLOT_FAMILIES = [
  { id: 'ltx25', label: 'LTX-2.5 video', note: 'Every LTX-2.5 app: Video, Director, Extend, Transition, Add sound, Speak, Effects, Restyle, Mirror, Reshoot, Cast, Stage, HDR, Seam Doctor and Upscale Dream.' },
  { id: 'ltx25-loras', label: 'LTX-2.5 app LoRAs', note: 'The IC-LoRA each app loads on top of the LTX-2.5 transformer.' },
  { id: 'qwen', label: 'Qwen-Image stills and edits', note: 'Image (Qwen-Image), Edit and its one-click apps. The text encoder, VAE and Lightning LoRA are shared by both.' },
  { id: 'flux2', label: 'FLUX.2 stills', note: 'Image with the FLUX.2 model, and Cast stills on FLUX.2.' },
  { id: 'zimage', label: 'Stage look frames (Z-Image Turbo)', note: 'The look frame of a Stage shot, drawn on the depth pass of the blocking.' },
  { id: 'h3', label: 'MiniMax H3 video', note: 'Video and Loop on the H3 engine, and Refs mode.' },
] as const;

export type SlotFamilyId = (typeof SLOT_FAMILIES)[number]['id'];

export interface SlotFamily {
  id: SlotFamilyId;
  label: string;
  /** Where the family's files are used. */
  note: string;
}

const slot = <F extends SlotFamilyId, K extends string>(family: F, key: K, label: string, dir: SlotDir, env: string, stock: string) =>
  ({ id: `${family}.${key}` as `${F}.${K}`, family, label, dir, env, stock });

const SLOTS = [
  slot('ltx25', 'transformer', 'Transformer', 'diffusion_models', 'OPENFIELD_LTX25_TRANSFORMER', 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'),
  slot('ltx25', 'textEncoder', 'Text encoder', 'text_encoders', 'OPENFIELD_LTX25_TEXT_ENCODER', 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors'),
  slot('ltx25', 'videoVae', 'Video VAE', 'vae', 'OPENFIELD_LTX25_VIDEO_VAE', 'ltx-2.5-video-vae-bf16.safetensors'),
  slot('ltx25', 'audioVae', 'Audio VAE', 'vae', 'OPENFIELD_LTX25_AUDIO_VAE', 'ltx-2.5-audio-vae-bf16.safetensors'),
  slot('ltx25', 'upscaler', 'Latent upscaler', 'latent_upscale_models', 'OPENFIELD_LTX25_UPSCALER', 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'),

  slot('ltx25-loras', 'cast', 'Cast (Ingredients)', 'loras', 'OPENFIELD_LTX25_CAST_LORA', 'ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors'),
  slot('ltx25-loras', 'stage', 'Stage (Layout to Render)', 'loras', 'OPENFIELD_LTX25_STAGE_LORA', 'ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors'),
  slot('ltx25-loras', 'hdr', 'Finish in HDR (SDR to HDR)', 'loras', 'OPENFIELD_LTX25_HDR_LORA', 'ltx-2.5-22b-ic-lora-sdr-to-hdr-1.0.safetensors'),
  slot('ltx25-loras', 'mirror', 'Mirror and Restyle (Union Control)', 'loras', 'OPENFIELD_LTX25_MIRROR_LORA', 'ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors'),
  slot('ltx25-loras', 'reshoot', 'Reshoot (CrossView-Warp)', 'loras', 'OPENFIELD_LTX25_RESHOOT_LORA', 'LTX2.3-22B_IC-LoRA-CrossView-Warp_v2_6000.safetensors'),
  slot('ltx25-loras', 'swap', 'Object swap (In/outpainting)', 'loras', 'OPENFIELD_LTX25_SWAP_LORA', 'ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors'),

  slot('qwen', 'model', 'Qwen-Image model', 'diffusion_models', 'OPENFIELD_QWEN_MODEL', 'qwen_image_fp8_e4m3fn.safetensors'),
  slot('qwen', 'editModel', 'Qwen-Image-Edit model', 'diffusion_models', 'OPENFIELD_QWEN_EDIT_MODEL', 'qwen_image_edit_2509_fp8_e4m3fn.safetensors'),
  slot('qwen', 'textEncoder', 'Text encoder', 'text_encoders', 'OPENFIELD_QWEN_TEXT_ENCODER', 'qwen_2.5_vl_7b_fp8_scaled.safetensors'),
  slot('qwen', 'vae', 'VAE', 'vae', 'OPENFIELD_QWEN_VAE', 'qwen_image_vae.safetensors'),
  slot('qwen', 'lightning', 'Draft LoRA (Lightning)', 'loras', 'OPENFIELD_QWEN_LIGHTNING_LORA', 'Qwen-Image-Lightning-8steps-V1.0.safetensors'),

  slot('flux2', 'model', 'Model', 'diffusion_models', 'OPENFIELD_FLUX2_MODEL', 'flux2_dev_fp8mixed.safetensors'),
  slot('flux2', 'textEncoder', 'Text encoder', 'text_encoders', 'OPENFIELD_FLUX2_TEXT_ENCODER', 'mistral_3_small_flux2_fp4_mixed.safetensors'),
  slot('flux2', 'vae', 'VAE', 'vae', 'OPENFIELD_FLUX2_VAE', 'flux2-vae.safetensors'),
  slot('flux2', 'turbo', 'Draft LoRA (Turbo)', 'loras', 'OPENFIELD_FLUX2_TURBO_LORA', 'Flux2TurboComfyv2.safetensors'),

  slot('zimage', 'model', 'Model', 'diffusion_models', 'OPENFIELD_ZIMAGE_MODEL', 'z_image_turbo_bf16.safetensors'),
  slot('zimage', 'textEncoder', 'Text encoder', 'text_encoders', 'OPENFIELD_ZIMAGE_TEXT_ENCODER', 'qwen_3_4b.safetensors'),
  slot('zimage', 'vae', 'VAE', 'vae', 'OPENFIELD_ZIMAGE_VAE', 'ae.safetensors'),
  slot('zimage', 'control', 'Depth control (Fun ControlNet Union)', 'model_patches', 'OPENFIELD_ZIMAGE_CONTROL', 'Z-Image-Turbo-Fun-Controlnet-Union.safetensors'),

  slot('h3', 'model', 'Model (Video, Loop)', 'diffusion_models', 'OPENFIELD_H3_MODEL', 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors'),
  slot('h3', 'refsModel', 'Model (Refs mode)', 'diffusion_models', 'OPENFIELD_H3_REFS_MODEL', 'minimax_h3_ref2va_pruned_fp8_scaled.safetensors'),
  slot('h3', 'textEncoder', 'Text encoder', 'text_encoders', 'OPENFIELD_H3_TEXT_ENCODER', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'),
  slot('h3', 'videoVae', 'Video VAE', 'vae', 'OPENFIELD_H3_VIDEO_VAE', 'minimax_h3_video_vae_fp16.safetensors'),
  slot('h3', 'audioVae', 'Audio VAE', 'vae', 'OPENFIELD_H3_AUDIO_VAE', 'minimax_h3_audio_vae_fp32.safetensors'),
] as const;

/** A slot id such as 'ltx25.transformer'; a misspelt one does not compile. */
export type SlotId = (typeof SLOTS)[number]['id'];

export interface ModelSlot {
  id: SlotId;
  family: SlotFamilyId;
  label: string;
  stock: string;
  dir: SlotDir;
  env: string;
}

export const MODEL_SLOTS: readonly ModelSlot[] = SLOTS;

const BY_ID = new Map<string, ModelSlot>(MODEL_SLOTS.map((s) => [s.id, s]));
const FAMILY = new Map<string, SlotFamily>(SLOT_FAMILIES.map((f) => [f.id, f]));

export function modelSlot(id: SlotId): ModelSlot {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`unknown model slot: ${id}`);
  return s;
}

export type SlotSource = 'env' | 'stock';

/**
 * The file a slot loads and where that name came from. A variable that names
 * the stock file counts as stock: it changes nothing.
 */
export function resolveSlot(id: SlotId, env: NodeJS.ProcessEnv = process.env): { file: string; source: SlotSource } {
  const s = modelSlot(id);
  const fromEnv = (env[s.env] ?? '').trim();
  if (fromEnv && fromEnv !== s.stock) return { file: fromEnv, source: 'env' };
  return { file: s.stock, source: 'stock' };
}

/** The file a slot loads. What the graph builders call. */
export const slotFile = (id: SlotId, env: NodeJS.ProcessEnv = process.env): string => resolveSlot(id, env).file;

export interface ConfiguredSlot {
  slot: ModelSlot;
  file: string;
}

/** The slots that load another file than their stock one, with that file. */
export function configuredSlots(env: NodeJS.ProcessEnv = process.env): ConfiguredSlot[] {
  return MODEL_SLOTS.flatMap((s) => {
    const r = resolveSlot(s.id, env);
    return r.source === 'stock' ? [] : [{ slot: s, file: r.file }];
  });
}

/**
 * A slot and where its file came from, for messages:
 * `slot "LTX-2.5 video: Transformer", set by OPENFIELD_LTX25_TRANSFORMER`.
 */
export function slotOrigin(id: SlotId): string {
  const s = modelSlot(id);
  return `slot "${FAMILY.get(s.family)!.label}: ${s.label}", set by ${s.env}`;
}

type GraphNode = { inputs?: Record<string, unknown> } | undefined;
const inputsOf = (graph: Record<string, unknown>, id: string) => (graph[id] as GraphNode)?.inputs ?? {};

/** A node and every node it takes an input from, directly or further up. */
function upstream(graph: Record<string, unknown>, nodeId: string): string[] {
  const seen = new Set<string>();
  const todo = [nodeId];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id) || !(id in graph)) continue;
    seen.add(id);
    for (const v of Object.values(inputsOf(graph, id))) if (Array.isArray(v)) todo.push(String(v[0]));
  }
  return [...seen];
}

/** The configured slots whose file one of these nodes loads. */
function loadedBy(graph: Record<string, unknown>, nodeIds: string[], configured: ConfiguredSlot[]): ConfiguredSlot[] {
  const values = new Set(nodeIds.flatMap((id) => Object.values(inputsOf(graph, id))));
  return configured.filter((c) => values.has(c.file));
}

const described = (slots: ConfiguredSlot[]) =>
  slots.map((c) => `${c.file} (${slotOrigin(c.slot.id)}; the stock file is ${c.slot.stock})`).join(' and ');

/**
 * For a failed render: the configured slot files it depends on, as a sentence
 * for the error message, or null when it depends on stock files only. When
 * the failed node (nodeId, if the engine names one) loads one itself, only
 * that one is named. A file of the wrong model often loads fine and fails a
 * later node, so otherwise the configured files of the nodes that feed the
 * failed one are named, or those of the whole graph when no node is known.
 * `graph` is the API-format graph the job ran.
 */
export function slotFailureNote(graph: Record<string, unknown>, nodeId: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = configuredSlots(env);
  if (!configured.length) return null;
  const failed = nodeId !== null && nodeId in graph ? nodeId : null;
  const own = failed ? loadedBy(graph, [failed], configured) : [];
  if (own.length) return `The failed node loads ${described(own)}.`;
  const feeding = loadedBy(graph, failed ? upstream(graph, failed) : Object.keys(graph), configured);
  if (!feeding.length) return null;
  const lead = failed ? 'The failed node takes its input from' : 'This render loads';
  return `${lead} ${described(feeding)}; a file that is not made for this model can load fine and make a later node fail.`;
}

/** A failed render's error message, followed by its slotFailureNote when there is one (graph null: none). */
export function withSlotNote(message: string, graph: Record<string, unknown> | null, nodeId: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const note = graph ? slotFailureNote(graph, nodeId, env) : null;
  return note ? `${message} ${note}` : message;
}

/**
 * Drop every slot variable from this process, so the graphs built afterwards
 * use the stock files. `npm run workflows` calls this: the exported workflows
 * are the shared examples in the repo and must not pick up one machine's .env.
 */
export function clearSlotOverrides(env: NodeJS.ProcessEnv = process.env): void {
  for (const s of MODEL_SLOTS) delete env[s.env];
}
