/**
 * The model manifest — OpenField's single source of truth for what has to be on
 * disk before a given feature can run.
 *
 * Three things read this file and must never disagree:
 *   1. server/preflight.ts  — blocks a render with a readable error instead of
 *                             letting ComfyUI throw a stack trace at the user.
 *   2. scripts/fetch-models.ts — downloads and places the weights.
 *   3. docs/MODELS.md       — generated from here (`npm run docs:models`).
 *
 * Filenames must match what the graph builders in server/graphs/* ask for
 * verbatim; ComfyUI resolves models by filename, so a rename breaks a render.
 * Repo paths and gating were verified against HuggingFace on 2026-08-21: every
 * URL below answers 200 unauthenticated except the LTX-2.5 repo, which is
 * gated and answers 401 until you accept its license and set HF_TOKEN.
 * The Upscale bundles (upres, seedvr2) were checked the same way on 2026-10-17,
 * with sizes matching the files on a working install. So was trellis2 on
 * 2026-10-17: every file resolves unauthenticated and its HF x-linked-size
 * matches the file on disk byte for byte.
 */

import { configuredSlots, modelSlot, slotOrigin, type SlotId } from './graphs/slots.js';

export interface ModelFile {
  /** Filename ComfyUI must see. Referenced verbatim by a graph builder. */
  file: string;
  /** Subfolder under ComfyUI/models/ this belongs in. */
  dir:
    | 'diffusion_models'
    | 'text_encoders'
    | 'vae'
    | 'loras'
    | 'checkpoints'
    | 'upscale_models'
    | 'latent_upscale_models'
    | 'geometry_estimation'
    /** Image encoders for CLIPVisionLoader (TRELLIS.2 reads DINOv3 from here). */
    | 'clip_vision'
    /** Background removal models (LoadBackgroundRemovalModel, BiRefNet). */
    | 'background_removal'
    /** Saved conditionings (LTXVLoadConditioning reads this folder). */
    | 'embeddings'
    /** Core RemoveBackground models (ComfyUI >= 0.38). */
    | 'background_removal'
    /** ComfyUI-SeedVR2_VideoUpscaler's own folder (models/SEEDVR2/). */
    | 'SEEDVR2'
    /** Model patches such as the Z-Image Fun ControlNet (ModelPatchLoader reads this folder). */
    | 'model_patches';
  /** HuggingFace repo id. */
  repo: string;
  /** Path within that repo. */
  path: string;
  gb: number;
  /** Repo requires accepting a license on the model page before download. */
  gated?: boolean;
  /**
   * Set when a model slot loads another file than the stock one (see
   * server/graphs/slots.ts): the slot's id, and where the file came from as
   * the messages show it (slotOrigin). `file` is then that file, which the
   * installer never downloads.
   */
  slot?: { id: SlotId; origin: string };
}

export interface Bundle {
  id: string;
  label: string;
  /** What you lose if it's absent. */
  purpose: string;
  license: string;
  /** Surfaced in the UI and the installer — read before you ship anything. */
  licenseWarning?: string;
  /** Not needed for a working install; the installer skips these by default. */
  optional?: boolean;
  /** ComfyUI node classes this bundle needs, if any are from custom nodes. */
  nodes?: { class: string; pack: string; url: string }[];
  files: ModelFile[];
}

const HF = (repo: string, path: string, gb: number, gated = false) => ({ repo, path, gb, gated });
/** A model slot's stock file in the slot's folder (server/graphs/slots.ts), at `folder` + its name in the repo. */
const fromSlot = (id: SlotId, repo: string, folder: string, gb: number, gated = false): ModelFile => {
  const s = modelSlot(id);
  return { file: s.stock, dir: s.dir, ...HF(repo, `${folder}${s.stock}`, gb, gated) };
};

export const BUNDLES: Bundle[] = [
  {
    id: 'ltx25',
    label: 'LTX-2.5 video',
    purpose: 'Video + Loop modes on the LTX-2.5 engine. The recommended starting point: it is the only video engine here whose license permits commercial delivery, and its first/last-frame mode closes seamless loops without a post dissolve.',
    license: 'LTX-2.x Community License Agreement (Aug 11, 2026). Free for any use, commercial included, if you (and your affiliates) earn under $10M a year; at $10M or more a paid Commercial Use Agreement is required for anything beyond non-commercial use. Acceptable-use restrictions apply. The Gemma 4 based text encoder ships in this repo under the same license.',
    files: [
      fromSlot('ltx25.transformer', 'Lightricks/LTX-2.5', 'diffusion_models/', 21.5, true),
      fromSlot('ltx25.textEncoder', 'Lightricks/LTX-2.5', 'text_encoders/', 15.4, true),
      fromSlot('ltx25.videoVae', 'Lightricks/LTX-2.5', 'vae/', 1.5, true),
      fromSlot('ltx25.audioVae', 'Lightricks/LTX-2.5', 'vae/', 0.4, true),
      fromSlot('ltx25.upscaler', 'Lightricks/LTX-2.5', 'latent_upscale_models/', 1.0, true),
    ],
  },
  {
    id: 'qwen',
    label: 'Qwen-Image stills',
    purpose: 'Still mode. Also the cheapest way to make a start frame for a video, which is how most shots here begin.',
    license: 'Apache 2.0 (Qwen-Image, the Qwen2.5-VL text encoder, and the Lightning LoRA).',
    files: [
      fromSlot('qwen.model', 'Comfy-Org/Qwen-Image_ComfyUI', 'split_files/diffusion_models/', 20.4),
      fromSlot('qwen.textEncoder', 'Comfy-Org/Qwen-Image_ComfyUI', 'split_files/text_encoders/', 9.4),
      fromSlot('qwen.vae', 'Comfy-Org/Qwen-Image_ComfyUI', 'split_files/vae/', 0.3),
      fromSlot('qwen.lightning', 'lightx2v/Qwen-Image-Lightning', '', 1.7),
    ],
  },
  {
    id: 'edit',
    label: 'Qwen-Image-Edit stills',
    purpose: 'The Edit app and its one-click image apps (New angle, Coverage, Push in, Next beat, Relight, Expand), plus Edit / Relight / Expand on any still. Instruction editing with up to three input images. Shares the text encoder, VAE and Lightning LoRA with the qwen bundle.',
    license: 'Apache 2.0 (Qwen-Image-Edit 2509, the Qwen2.5-VL text encoder, and the Lightning LoRA).',
    optional: true,
    files: [
      fromSlot('qwen.editModel', 'Comfy-Org/Qwen-Image-Edit_ComfyUI', 'split_files/diffusion_models/', 20.4),
      fromSlot('qwen.textEncoder', 'Comfy-Org/Qwen-Image_ComfyUI', 'split_files/text_encoders/', 9.4),
      fromSlot('qwen.vae', 'Comfy-Org/Qwen-Image_ComfyUI', 'split_files/vae/', 0.3),
      fromSlot('qwen.lightning', 'lightx2v/Qwen-Image-Lightning', '', 1.7),
    ],
  },
  {
    id: 'h3',
    label: 'MiniMax H3 video',
    purpose: 'Video / Loop / Refs modes on the H3 engine. The only engine here with reference-image mode and generated dialogue. Best at held stillness and at taking direction.',
    license: 'MiniMax H3 Community License Agreement. Licensed only outside the Excluded Territories; products over $20M yearly revenue need written authorization; commercial products must display "MiniMax H3" in their UI.',
    licenseWarning:
      'The H3 license EXCLUDES the United States, the European Union, the United Kingdom and South Korea, and forbids using H3 or its outputs there. OpenField does not check where you are.',
    // Opt-in rather than part of the core install: a default that quietly hands
    // a new user a model their country is excluded from is not a good default.
    optional: true,
    files: [
      fromSlot('h3.model', 'Comfy-Org/MiniMax-H3', 'diffusion_models/', 21.0),
      fromSlot('h3.textEncoder', 'Comfy-Org/MiniMax-H3', 'text_encoders/', 15.7),
      fromSlot('h3.videoVae', 'Comfy-Org/MiniMax-H3', 'vae/', 5.2),
      fromSlot('h3.audioVae', 'Comfy-Org/MiniMax-H3', 'vae/', 0.6),
    ],
  },
  {
    id: 'h3-refs',
    label: 'MiniMax H3 — Refs mode',
    purpose: 'Adds the Refs mode checkpoint: build a shot from up to 4 reference images (a character sheet, a location plate) instead of a single start frame.',
    license: 'MiniMax H3 Community License Agreement. Same territory exclusions as the H3 bundle (US, EU, UK, South Korea).',
    optional: true,
    files: [
      fromSlot('h3.refsModel', 'Comfy-Org/MiniMax-H3', 'diffusion_models/', 21.0),
    ],
  },
  {
    id: 'h3-turbo',
    label: 'MiniMax H3 — turbo distills',
    purpose: 'Step-distill LoRAs that drop H3 sampling from 20 steps to 4-8. OpenField only offers a turbo preset whose file is actually present, so missing ones just do not appear.',
    license: 'The lightx2v repo labels these LoRAs Apache 2.0, but the H3 license treats distills and other Model Derivatives as H3 works, so assume the full H3 terms (territory exclusions included) apply.',
    optional: true,
    files: [
      { file: 'minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors', dir: 'loras',
        ...HF('lightx2v/Minimax-h3-Turbo', 'minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors', 2.0) },
      { file: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors', dir: 'loras',
        ...HF('lightx2v/Minimax-h3-Turbo', 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors', 2.0) },
      { file: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', dir: 'loras',
        ...HF('lightx2v/Minimax-h3-Turbo', 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 2.0) },
      { file: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', dir: 'loras',
        ...HF('lightx2v/Minimax-h3-Turbo', 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', 2.0) },
    ],
  },
  {
    id: 'flux2',
    label: 'FLUX.2-dev stills',
    purpose: 'Adds FLUX.2 as a second stills model — the photorealism lead where Qwen is the text and layout specialist.',
    license: 'FLUX Non-Commercial License (Black Forest Labs). The Turbo LoRA is a FLUX.2-dev derivative under the same terms; the Mistral text encoder is redistributed here under it too.',
    licenseWarning: 'FLUX.2-dev is NON-COMMERCIAL. You may only run it for non-commercial purposes; any paid or revenue-generating use needs a commercial license from Black Forest Labs (bfl.ai/licensing).',
    optional: true,
    files: [
      fromSlot('flux2.model', 'Comfy-Org/flux2-dev', 'split_files/diffusion_models/', 35.5),
      fromSlot('flux2.textEncoder', 'Comfy-Org/flux2-dev', 'split_files/text_encoders/', 12.3),
      fromSlot('flux2.vae', 'Comfy-Org/flux2-dev', 'split_files/vae/', 0.3),
      fromSlot('flux2.turbo', 'Comfy-Org/flux2-dev', 'split_files/loras/', 2.8),
    ],
  },
  {
    id: 'upres',
    label: 'Upscale: Sharpen',
    purpose: 'Sharpen mode of the Upscale app: a 4x ESRGAN pass downsampled to a clean 2x, optional RIFE frame doubling, original audio kept. The default model is RealESRGAN x4plus. Needs two custom node packs as well as the weights.',
    license: 'RealESRGAN x4plus (the default): BSD-3-Clause, Xintao Wang et al. (github.com/xinntao/Real-ESRGAN); the file fetched here is byte-identical to the v0.1.0 GitHub release (sha256 4fa0d389...682f1). RIFE 4.7 (rife47.pth, fetched by Frame-Interpolation on first use): MIT. Node packs: VideoHelperSuite GPL-3.0, Frame-Interpolation MIT.',
    optional: true,
    nodes: [
      { class: 'VHS_LoadVideo', pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
      { class: 'RIFE VFI', pack: 'ComfyUI-Frame-Interpolation', url: 'https://github.com/Fannovel16/ComfyUI-Frame-Interpolation' },
    ],
    files: [
      { file: 'RealESRGAN_x4plus.pth', dir: 'upscale_models', ...HF('lllyasviel/Annotators', 'RealESRGAN_x4plus.pth', 0.07) },
    ],
  },
  {
    id: 'upres-ultrasharp',
    label: 'Upscale: Sharpen with 4x-UltraSharp',
    purpose: 'The 4x-UltraSharp option in Sharpen mode: crisper edges than RealESRGAN on clean renders. Needs the upres bundle.',
    license: '4x-UltraSharp: CC BY-NC-SA 4.0, Kim2091.',
    licenseWarning: '4x-UltraSharp is NON-COMMERCIAL (CC BY-NC-SA 4.0). Use the default RealESRGAN model for paid work.',
    optional: true,
    files: [
      { file: '4x-UltraSharp.pth', dir: 'upscale_models', ...HF('Kim2091/UltraSharp', '4x-UltraSharp.pth', 0.07) },
    ],
  },
  {
    id: 'seedvr2',
    label: 'Upscale: Redraw (SeedVR2)',
    purpose: 'Redraw mode of the Upscale app: SeedVR2 one-step diffusion restoration rebuilds real detail at a 1080 or 1440 short edge, on video or stills. 3B is the fast default, 7B adds detail. Needs the SeedVR2 custom node pack, which also reads its weights from models/SEEDVR2/.',
    license: 'SeedVR2 weights: Apache 2.0, ByteDance Seed (huggingface.co/ByteDance-Seed/SeedVR2-3B and -7B, github.com/ByteDance-Seed/SeedVR); the fp16 repackage fetched here (numz/SeedVR2_comfyUI) is Apache 2.0 too. Node pack ComfyUI-SeedVR2_VideoUpscaler (numz): Apache 2.0. VideoHelperSuite: GPL-3.0.',
    optional: true,
    nodes: [
      { class: 'SeedVR2VideoUpscaler', pack: 'ComfyUI-SeedVR2_VideoUpscaler', url: 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler' },
      { class: 'VHS_LoadVideo', pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
    ],
    files: [
      { file: 'seedvr2_ema_3b_fp16.safetensors', dir: 'SEEDVR2', ...HF('numz/SeedVR2_comfyUI', 'seedvr2_ema_3b_fp16.safetensors', 6.8) },
      { file: 'seedvr2_ema_7b_fp16.safetensors', dir: 'SEEDVR2', ...HF('numz/SeedVR2_comfyUI', 'seedvr2_ema_7b_fp16.safetensors', 16.5) },
      { file: 'ema_vae_fp16.safetensors', dir: 'SEEDVR2', ...HF('numz/SeedVR2_comfyUI', 'ema_vae_fp16.safetensors', 0.5) },
    ],
  },
  {
    id: 'dream',
    label: 'Upscale: Dream',
    purpose: 'Dream mode of the Upscale app: LTX-2.5 encodes the clip, its latent upsampler doubles it, and the distilled model re-imagines the detail from a prompt. Uses the ltx25 weights; only needs VideoHelperSuite on top.',
    license: 'LTX-2.x Community License Agreement (the ltx25 bundle): free for any use, commercial included, under $10M yearly revenue. VideoHelperSuite: GPL-3.0.',
    optional: true,
    nodes: [
      { class: 'VHS_LoadVideo', pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
    ],
    files: [],
  },
  {
    id: 'mirror',
    label: 'Mirror (motion transfer)',
    purpose: 'Mirror mode: a source clip becomes a pose, depth or edge control track (comfyui_controlnet_aux preprocessors, which fetch their own small detector weights on first use) and the LTX IC-LoRA Union Control re-renders it on LTX-2.5. Needs the ltx25 bundle.',
    license: 'IC-LoRA Union Control: LTX-2 Community License Agreement (same $10M revenue threshold as LTX-2.5). Pose: DWPose + YOLOX weights, Apache 2.0. Depth: Depth Anything V2 Small (depth_anything_v2_vits.pth), Apache 2.0, fetched by controlnet_aux on first use. Edges: Canny, no weights. Node packs: comfyui_controlnet_aux Apache 2.0, VideoHelperSuite GPL-3.0.',
    optional: true,
    nodes: [
      { class: 'DWPreprocessor', pack: 'comfyui_controlnet_aux', url: 'https://github.com/Fannovel16/comfyui_controlnet_aux' },
      { class: 'VHS_LoadVideo', pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
    ],
    files: [
      fromSlot('ltx25-loras.mirror', 'Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control', '', 0.65),
    ],
  },
  {
    id: 'reshoot',
    label: 'Reshoot (new camera angle)',
    purpose: 'Reshoot mode: re-render a clip from a new azimuth / elevation. MoGe-2 estimates metric geometry, the CrossView Warp node reprojects the clip into the new camera, and the CrossView-Warp v2 IC-LoRA re-renders it on LTX-2.5. Needs the ltx25 bundle and three custom node packs.',
    license: 'CrossView-Warp v2 LoRA: labelled Apache 2.0 by its author (training renders used CC-BY / CC0 assets, see its ATTRIBUTION.md), but it is an LTX-2.3 adapter and the LTX license requires derivatives to be distributed under LTX terms, so treat it as LTX-2 Community License. MoGe-2 weights: MIT. Node packs: ComfyUI-CrossViewWarp Apache 2.0, ComfyUI-LTXVideo LTX-2 Community License, VideoHelperSuite GPL-3.0.',
    optional: true,
    nodes: [
      { class: 'CrossViewWarp', pack: 'ComfyUI-CrossViewWarp', url: 'https://github.com/cseti007/ComfyUI-CrossViewWarp' },
      { class: 'LTXICLoRALoaderModelOnly', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
      { class: 'VHS_LoadVideo', pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
    ],
    files: [
      fromSlot('ltx25-loras.reshoot', 'Cseti/LTX2.3-22B_IC-LoRA-CrossView-Warp_v2', '', 0.33),
      { file: 'moge_2_vitl_normal_fp16.safetensors', dir: 'geometry_estimation',
        ...HF('Comfy-Org/MoGe', 'geometry_estimation/moge_2_vitl_normal_fp16.safetensors', 0.66) },
    ],
  },
  {
    id: 'effects',
    label: 'Effects (Lightricks LoRAs)',
    purpose: 'The Effects app, Lightricks set: Cutout (alpha matte), Flood (add water), Nightfall (day to night), Empty the scene (clean plate) and Living photo (cinemagraph). The first four are IC-LoRAs that re-render a source clip frame-locked on LTX-2.5. Each effect only needs its own file, so a partial download still runs the ones that are there. Needs the ltx25 bundle. Every repo is gated: accept each license on its Hugging Face page first.',
    license: 'LTX-2.x Community License Agreement (Aug 11, 2026), the same terms as LTX-2.5: free for any use, commercial included, under $10M yearly revenue. Node packs: ComfyUI-LTXVideo LTX-2 Community License, VideoHelperSuite GPL-3.0.',
    optional: true,
    nodes: [
      { class: 'LTXICLoRALoaderModelOnly', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
      { class: 'VHS_LoadVideo', pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
    ],
    files: [
      { file: 'ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors', dir: 'loras',
        ...HF('Lightricks/LTX-2.5-22b-IC-LoRA-Alpha-Gen', 'ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors', 1.31, true) },
      { file: 'ltx-2.5-22b-ic-lora-water-simulation-0.9.safetensors', dir: 'loras',
        ...HF('Lightricks/LTX-2.5-22b-IC-LoRA-Water-Simulation', 'ltx-2.5-22b-ic-lora-water-simulation-0.9.safetensors', 0.91, true) },
      { file: 'ltx-2.5-22b-ic-lora-day-to-night-0.9.safetensors', dir: 'loras',
        ...HF('Lightricks/LTX-2.5-22b-IC-LoRA-Day-To-Night', 'ltx-2.5-22b-ic-lora-day-to-night-0.9.safetensors', 0.33, true) },
      { file: 'ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors', dir: 'loras',
        ...HF('Lightricks/LTX-2.5-22b-IC-LoRA-Clean-Plate', 'ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors', 0.33, true) },
      { file: 'ltx-2.5-22b-lora-cinemagraph-0.9.safetensors', dir: 'loras',
        ...HF('Lightricks/LTX-2.5-22b-LoRA-Cinemagraph', 'ltx-2.5-22b-lora-cinemagraph-0.9.safetensors', 0.2, true) },
    ],
  },
  {
    id: 'cast',
    label: 'Cast in video (Ingredients IC-LoRA)',
    purpose: 'Cast members in Video and Director shots: their pictures are laid out on a reference sheet that LTX-2.5 holds on every frame through the Ingredients IC-LoRA, so faces, costumes, props and places stay the same across shots. Without it, Cast falls back to a hero frame from the edit bundle. Needs the ltx25 bundle. The repo is gated: accept its license on Hugging Face first.',
    license: 'LTX-2.x Community License Agreement (Aug 11, 2026), the same terms as LTX-2.5: free for any use, commercial included, under $10M yearly revenue.',
    optional: true,
    nodes: [
      { class: 'LTXICLoRALoaderModelOnly', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
      { class: 'LTXAddVideoICLoRAGuide', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
    ],
    files: [
      fromSlot('ltx25-loras.cast', 'Lightricks/LTX-2.5-22b-IC-LoRA-Ingredients', '', 1.31, true),
    ],
  },
  {
    id: 'effects-community',
    label: 'Effects (community LoRAs)',
    purpose: 'The Effects app, community set by kabachuha: Pop, Inflate, Cake, Squish, Unzip and Gulp, each a plain LoRA on LTX-2.5 image-to-video. Pop was trained on LTX-2.3, the rest on LTX-2 (19B); they load on 2.5 with matching keys. Each effect only needs its own file. Needs the ltx25 bundle.',
    license: 'Each repo states the LTX-2 Community License Agreement (LTX derivatives): free for any use, commercial included, under $10M yearly revenue. kabachuha/ltx2-hydraulic-press states no license and is deliberately not included.',
    optional: true,
    files: [
      { file: 'ltx23-pop.safetensors', dir: 'loras', ...HF('kabachuha/ltx23-pop', 'ltx23-pop.safetensors', 0.65) },
      { file: 'ltx2-inflate.safetensors', dir: 'loras', ...HF('kabachuha/ltx2-inflate-it', 'ltx2-inflate.safetensors', 1.11) },
      { file: 'ltx2-cakeify-v2.safetensors', dir: 'loras', ...HF('kabachuha/ltx2-cakeify', 'ltx2-cakeify-v2.safetensors', 0.83) },
      { file: 'ltx2-handsquish.safetensors', dir: 'loras', ...HF('kabachuha/ltx2-squish-one-hand', 'ltx2-handsquish.safetensors', 1.11) },
      { file: 'ltx2-disguise-drop.safetensors', dir: 'loras', ...HF('kabachuha/ltx2-disguise-drop', 'ltx2-disguise-drop.safetensors', 0.83) },
      { file: 'ltx2-eat-v2.safetensors', dir: 'loras', ...HF('kabachuha/ltx2-eat', 'ltx2-eat-v2.safetensors', 1.11) },
    ],
  },
  {
    id: 'ltx-tools',
    label: 'Extend, Transition, Add sound',
    purpose: 'The take tools that read an existing clip: Extend (forward and backward), Transition and Add sound. They run on the ltx25 weights and need no more downloads, only custom node packs: VideoHelperSuite loads the clip, KJNodes reverses it for a backward extend, ComfyUI-LTXVideo masks which audio and video spans are kept. Speak needs only the ltx25 bundle.',
    license: 'No model files of its own; the output falls under the LTX-2.x Community License Agreement of the ltx25 bundle: free for any use, commercial included, under $10M yearly revenue. Node packs: VideoHelperSuite GPL-3.0, KJNodes GPL-3.0, ComfyUI-LTXVideo LTX-2 Community License.',
    optional: true,
    nodes: [
      { class: 'VHS_LoadVideo', pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
      { class: 'ReverseImageBatch', pack: 'ComfyUI-KJNodes', url: 'https://github.com/kijai/ComfyUI-KJNodes' },
      { class: 'LTXVSetAudioVideoMaskByTime', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
    ],
    files: [],
  },
  {
    id: 'hdr',
    label: 'Finish in HDR',
    purpose: 'Finish in HDR: the LTX-2.5 SDR-to-HDR IC-LoRA re-renders any video take as scene-linear HDR, written as a 16-bit ACEScg EXR sequence and an HLG BT.2020 10-bit master. It reads fixed scene embeddings instead of a prompt, so the scene embedding file goes in models/embeddings/, not loras/. Needs the ltx25 bundle and ComfyUI-LTXVideo.',
    license: 'LTX-2.x Community License Agreement (Aug 11, 2026), the same terms as LTX-2.5: free for any use, commercial included, under $10M yearly revenue. Node pack: ComfyUI-LTXVideo, LTX-2 Community License.',
    optional: true,
    nodes: [
      { class: 'LTXVSDRToHDRWorkingSpace', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
      { class: 'LTXVHDRDecodePostprocess', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
      { class: 'LTXVSaveHLG', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
    ],
    files: [
      fromSlot('ltx25-loras.hdr', 'Lightricks/LTX-2.5-22b-IC-LoRA-SDR-To-HDR', '', 1.31, true),
      { file: 'ltx-2.5-22b-ic-lora-sdr-to-hdr-scene-emb.safetensors', dir: 'embeddings',
        ...HF('Lightricks/LTX-2.5-22b-IC-LoRA-SDR-To-HDR', 'ltx-2.5-22b-ic-lora-sdr-to-hdr-scene-emb.safetensors', 0.013, true) },
    ],
  },
  {
    id: 'cutout',
    label: 'Cut out (background removal)',
    purpose: 'Remove background on stills and clips: BiRefNet pulls a soft foreground matte (hair included) on every frame. Stills come out as a transparent PNG or over a color, a blur or a new picture; clips as ProRes 4444 with alpha. Runs on core ComfyUI nodes (0.38 or newer), no video model. The steady and tracked clip modes add the sam3 bundle.',
    license: 'BiRefNet: MIT.',
    optional: true,
    files: [
      { file: 'birefnet.safetensors', dir: 'background_removal',
        ...HF('Comfy-Org/BiRefNet', 'background_removal/birefnet.safetensors', 0.44) },
    ],
  },
  {
    id: 'sam3',
    label: 'SAM 3.1 (find and track objects)',
    purpose: 'Finds a subject or an object from a word or a click and follows it through a clip (SAM3_VideoTrack). Keeps the clip cut out to the named subject (steady and tracked modes) and draws the mask for Object swap. Core ComfyUI nodes (0.38 or newer).',
    license: 'Meta SAM License: royalty-free, commercial use allowed; excludes military / ITAR uses and reverse engineering; publications must acknowledge SAM.',
    optional: true,
    files: [
      { file: 'sam3.1_multiplex_fp16.safetensors', dir: 'checkpoints',
        ...HF('Comfy-Org/sam3.1', 'checkpoints/sam3.1_multiplex_fp16.safetensors', 1.75) },
    ],
  },
  {
    id: 'swap',
    label: 'Object swap (video inpaint)',
    purpose: 'Object swap in Mirror: SAM 3.1 tracks the object, Qwen-Image-Edit replaces it in the first frame, and the LTX in/outpainting IC-LoRA redraws it through the clip while everything outside the mask stays as filmed. Needs the ltx25, edit and sam3 bundles.',
    license: 'In/outpainting IC-LoRA: LTX-2 Community License Agreement (free under $10M yearly revenue). Node packs: ComfyUI-LTXVideo LTX-2 Community License, VideoHelperSuite GPL-3.0, KJNodes GPL-3.0.',
    optional: true,
    nodes: [
      { class: 'LTXVInpaintPreprocess', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
      { class: 'ImageCropByMaskAndResize', pack: 'ComfyUI-KJNodes', url: 'https://github.com/kijai/ComfyUI-KJNodes' },
      { class: 'VHS_LoadVideo', pack: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
    ],
    files: [
      fromSlot('ltx25-loras.swap', 'Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting', '', 1.31, true),
    ],
  },
  {
    id: 'stage',
    label: 'Stage (Layout to Render)',
    purpose: 'Stage: a shot blocked in the browser (primitives, a camera path, a lens) renders as a finished shot. The grey clay clip holds the camera move and where everything stands; a look frame sets palette, light and materials. Runs the LTX-2.5 Layout-to-Render IC-LoRA in its official two-stage distilled graph. Needs the ltx25 bundle and ComfyUI-LTXVideo. The repo is gated: accept its license on Hugging Face first.',
    license: 'LTX-2.x Community License Agreement (repo card `ltx-2.x-community-license`), the same terms as LTX-2.5: free for any use, commercial included, under $10M yearly revenue. Node pack: ComfyUI-LTXVideo, LTX-2 Community License.',
    optional: true,
    nodes: [
      { class: 'LTXICLoRALoaderModelOnly', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
      { class: 'LTXAddVideoICLoRAGuide', pack: 'ComfyUI-LTXVideo', url: 'https://github.com/Lightricks/ComfyUI-LTXVideo' },
    ],
    files: [
      fromSlot('ltx25-loras.stage', 'Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render', '', 1.31, true),
    ],
  },
  {
    id: 'stage-look',
    label: 'Stage look frames (Z-Image Turbo + depth)',
    purpose: 'The look frame for a Stage shot: Z-Image Turbo with the Fun ControlNet Union reads an exact depth pass of the blocking, so the art-direction frame keeps the set where it was blocked. Without it, Stage falls back to Qwen-Image-Edit on the clay frame (the edit bundle), which holds layout less tightly. A look frame of your own can always be dropped in instead.',
    license: 'Apache 2.0 (Z-Image Turbo and its Qwen3 4B text encoder, Tongyi-MAI, repackaged by Comfy Org; the Z-Image-Turbo-Fun-Controlnet-Union patch, Alibaba PAI). The VAE is the FLUX.1 autoencoder (ae.safetensors), Apache 2.0.',
    optional: true,
    files: [
      fromSlot('zimage.model', 'Comfy-Org/z_image_turbo', 'split_files/diffusion_models/', 12.31),
      fromSlot('zimage.textEncoder', 'Comfy-Org/z_image_turbo', 'split_files/text_encoders/', 8.05),
      fromSlot('zimage.vae', 'Comfy-Org/z_image_turbo', 'split_files/vae/', 0.34),
      fromSlot('zimage.control', 'alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union', '', 3.1),
    ],
  },
  {
    id: 'trellis2',
    label: 'Object (image to 3D, TRELLIS.2)',
    purpose: 'The Object app and Make 3D on any still: TRELLIS.2 builds a textured mesh (GLB, PBR base color, metallic, roughness; High adds a baked normal map and AO) from one picture, through ComfyUI 0.38 built-in nodes. BiRefNet cuts the subject out first. bf16 weights, about 14 GB.',
    license: 'TRELLIS.2 (microsoft/TRELLIS.2-4B, repackaged by Comfy-Org/TRELLIS.2): MIT, the DiT and both VAEs. BiRefNet (ZhengPeng7/BiRefNet, repackaged by Comfy-Org/BiRefNet): MIT. The DINOv3 ViT-L image encoder (facebook/dinov3, repackaged in Comfy-Org/TRELLIS.2) is under the Meta DINOv3 License: royalty-free, commercial use allowed, with acceptable-use exclusions (military and ITAR uses, reverse engineering); the Comfy repo tags it MIT, but the upstream weights carry the DINOv3 License (and Meta gates its own repo behind a manual approval).',
    optional: true,
    files: [
      { file: 'trellis_2_bf16.safetensors', dir: 'diffusion_models', ...HF('Comfy-Org/TRELLIS.2', 'diffusion_models/trellis_2_bf16.safetensors', 10.34) },
      { file: 'trellis_2_shape_vae_bf16.safetensors', dir: 'vae', ...HF('Comfy-Org/TRELLIS.2', 'vae/trellis_2_shape_vae_bf16.safetensors', 1.10) },
      { file: 'trellis_2_texture_vae_bf16.safetensors', dir: 'vae', ...HF('Comfy-Org/TRELLIS.2', 'vae/trellis_2_texture_vae_bf16.safetensors', 0.95) },
      { file: 'dino_v3_vit_l.safetensors', dir: 'clip_vision', ...HF('Comfy-Org/TRELLIS.2', 'clip_vision/dino_v3_vit_l.safetensors', 1.21) },
      { file: 'birefnet.safetensors', dir: 'background_removal', ...HF('Comfy-Org/BiRefNet', 'background_removal/birefnet.safetensors', 0.44) },
    ],
  },
  {
    id: 'ltx23',
    label: 'LTX-2.3 video (legacy)',
    purpose: 'The older LTX engine, kept because it is the playground for community fine-tunes and LoRAs. Superseded by LTX-2.5 for ordinary work — install it only if you want to run third-party LTX checkpoints.',
    license: 'LTX-2 Community License Agreement (Jan 5, 2026; same $10M revenue threshold). The Gemma 3 12B text encoder is under the Gemma Terms of Use. Third-party fine-tunes carry their own terms, check each one.',
    optional: true,
    files: [
      { file: 'ltx-2.3-22b-dev-fp8.safetensors', dir: 'checkpoints',
        ...HF('Lightricks/LTX-2.3-fp8', 'ltx-2.3-22b-dev-fp8.safetensors', 29.2) },
      { file: 'gemma_3_12B_it_fp4_mixed.safetensors', dir: 'text_encoders',
        ...HF('Comfy-Org/ltx-2', 'split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors', 8.0) },
      { file: 'ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors', dir: 'loras',
        ...HF('Comfy-Org/ltx-2.3', 'split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors', 2.7) },
      { file: 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors', dir: 'latent_upscale_models',
        ...HF('Lightricks/LTX-2.3', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors', 1.0) },
    ],
  },
];

export const bundle = (id: string): Bundle | undefined => BUNDLES.find((b) => b.id === id);

export const bundleGb = (b: Bundle): number =>
  Math.round(b.files.reduce((n, f) => n + f.gb, 0) * 10) / 10;

/**
 * The bundles as this install runs them: a stock file whose model slot loads
 * another file (set by the slot's variable in .env, see
 * server/graphs/slots.ts) is swapped for that file, so preflight checks for
 * the file the graphs actually load and the installer does not fetch the
 * stock one in its place. Without such variables this returns BUNDLES
 * unchanged. BUNDLES itself always holds the stock files: docs/MODELS.md is
 * generated from it.
 */
export function activeBundles(env: NodeJS.ProcessEnv = process.env): Bundle[] {
  const swaps = new Map(configuredSlots(env).map((c) => [c.slot.stock, c]));
  if (!swaps.size) return BUNDLES;
  return BUNDLES.map((b) => {
    if (!b.files.some((f) => swaps.has(f.file))) return b;
    return {
      ...b,
      files: b.files.map((f) => {
        const c = swaps.get(f.file);
        // Never downloaded, so it adds nothing to the bundle's download size.
        return c ? { ...f, file: c.file, slot: { id: c.slot.id, origin: slotOrigin(c.slot.id) }, gb: 0 } : f;
      }),
    };
  });
}

/**
 * What `npm run models` does with files that are not installed: it fetches
 * the stock ones and only reports the files a model slot loads in their place,
 * which have no download source.
 */
export function downloadPlan(absent: ModelFile[]): { fetch: ModelFile[]; configured: SlotFile[] } {
  return { fetch: absent.filter((f) => !isSlotFile(f)), configured: absent.filter(isSlotFile) };
}

/** A file a model slot loads in place of its stock one. */
export type SlotFile = ModelFile & { slot: NonNullable<ModelFile['slot']> };
export const isSlotFile = (f: ModelFile): f is SlotFile => !!f.slot;

/**
 * Which bundles a given render needs. Keys match what the UI sends to
 * /api/generate, so preflight can answer before a graph is ever built.
 */
export function bundlesFor(req: {
  kind?: string;
  videoModel?: string;
  mode?: string;
  model?: string;
  quality?: string;
  castEngine?: string;
  /** Stage look frame engine ('depth' or 'edit'). */
  engine?: string;
  /** Stage shot: its look frame is given, or one is made first with lookEngine. */
  lookImage?: string;
  lookEngine?: string;
}): string[] {
  // Cast: the engine a mention resolved to (see castEngineFor in server/index.ts).
  if (req.castEngine === 'compose' || req.castEngine === 'frame') return req.kind === 'still' ? ['edit'] : ['edit', ...bundlesFor({ ...req, castEngine: undefined })];
  if (req.castEngine === 'sheet') return ['ltx25', 'cast'];
  if (req.castEngine === 'flux2ref') return ['flux2'];
  // Upscale app: mode picks the engine, model the weights within it.
  if (req.kind === 'upscale') {
    if (req.mode === 'redraw') return ['seedvr2'];
    if (req.mode === 'dream') return ['ltx25', 'dream'];
    return req.model === 'ultrasharp' ? ['upres', 'upres-ultrasharp'] : ['upres'];
  }
  if (req.kind === 'still') return [req.model === 'flux2' ? 'flux2' : 'qwen'];
  if (req.kind === 'edit') return ['edit'];
  if (req.kind === 'upres') return ['upres'];
  if (req.kind === 'mirror') return ['ltx25', 'mirror'];
  if (req.kind === 'cutout') return req.mode === 'track' ? ['sam3'] : req.mode === 'hybrid' ? ['cutout', 'sam3'] : ['cutout'];
  if (req.kind === 'restyle') return ['ltx25', 'mirror', 'edit'];
  if (req.kind === 'swap') return ['ltx25', 'edit', 'sam3', 'swap'];
  if (req.kind === 'reshoot' || req.kind === 'reshoot-preview') return ['ltx25', 'reshoot'];
  // Effects check their own single LoRA file on top of this (preflight.effectBlockingReason),
  // so one missing effect does not block the others.
  if (req.kind === 'effect') return ['ltx25'];
  if (req.kind === 'speak') return ['ltx25'];
  if (req.kind === 'extend' || req.kind === 'transition' || req.kind === 'sound') return ['ltx25', 'ltx-tools'];
  // Seam Doctor: a trim only loads and saves frames; a bridge renders on LTX-2.5.
  if (req.kind === 'seam') return req.mode === 'trim' ? ['ltx-tools'] : ['ltx25', 'ltx-tools'];
  if (req.kind === 'hdr') return ['ltx25', 'hdr'];
  // Stage: the shot needs the Layout-to-Render LoRA; a missing look frame is made first.
  if (req.kind === 'stage-look') return req.engine === 'edit' ? ['edit'] : ['stage-look'];
  if (req.kind === 'stage') return ['ltx25', 'stage', ...(req.lookImage ? [] : bundlesFor({ kind: 'stage-look', engine: req.lookEngine }))];
  if (req.kind === 'object') return ['trellis2'];
  if (req.videoModel === 'ltx25') return ['ltx25'];
  if (req.videoModel === 'ltx') return ['ltx23'];
  return req.mode === 'reference' ? ['h3', 'h3-refs'] : ['h3'];
}
