/** Doctrine encoded: iterate cheap, spend full-res only on locked heroes. */

export const RES_PRESETS = [
  { key: 'iterate', label: '0.4MP · ~3min/5s', w: 864, h: 480 },
  { key: 'mid', label: '0.6MP · ~8min/5s', w: 1056, h: 608 },
  { key: 'hero', label: '1MP MAX · slow', w: 1344, h: 768 },
] as const;

export const STILL_SIZES = [
  { key: '16:9', w: 1664, h: 928 },
  { key: '9:16', w: 928, h: 1664 },
  { key: '1:1', w: 1328, h: 1328 },
] as const;

/**
 * Style preambles are user data, not constants — they live in the database and
 * are edited in the UI (Setup panel -> Style preamble -> EDIT). See
 * server/jobs.ts for the starters seeded into a fresh install.
 */

/** H3 frame grid: 17k+5. Returns nearest legal frame count for a seconds value. */
export function secondsToFrames(seconds: number): number {
  const target = Math.round(seconds * 24);
  const k = Math.round((target - 5) / 17);
  return Math.max(5, Math.min(362, 17 * Math.max(0, k) + 5));
}

/**
 * H3 step-distill (turbo) options. Mirrors H3_TURBO_PRESETS in
 * server/graphs/h3.ts — ids must stay in sync; the server is the authority on
 * which LoRA file and sigma shift each id actually applies.
 *
 * Reference mode has only the v0.1 ref2v distill, so every id collapses to that
 * one there (4 steps regardless of the label).
 */
export const H3_TURBO = [
  { key: 'fasth3-6', label: '6-STEP · FASTH3', steps: 6,
    note: 'FastVideo DMD2 distill. ~23% faster than the 4-step lightx2v at hero res and follows the prompt harder.' },
  { key: 'v11-4', label: '4-STEP · v1.1', steps: 4,
    note: 'Newest (8/20). Delta vs v1.0 undocumented upstream — A/B it.' },
  { key: 'v10-4', label: '4-STEP · v1.0', steps: 4,
    note: 'The known-quantity 4-step distill.' },
  { key: 'v10-8', label: '8-STEP · v1.0', steps: 8,
    note: 'Closer to base quality, still ~2.5x faster than full.' },
] as const;

/** LoRA filenames the turbo presets need present in ComfyUI's lora folder. */
export const H3_TURBO_FILES: Record<string, string> = {
  'fasth3-6': 'minimax_h3_fasth3_4step_dense_comfy.safetensors',
  'v11-4': 'minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors',
  'v10-4': 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
  'v10-8': 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
};
/** The turbo presets whose LoRA ComfyUI lists, under exactly the name the graph asks for. */
export const availableH3Turbo = (loras: readonly string[]) => {
  const have = new Set(loras);
  return H3_TURBO.filter((t) => have.has(H3_TURBO_FILES[t.key]));
};

export const H3_REF_TURBO_FILE =
  'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors';
