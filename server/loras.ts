/**
 * Your own LoRAs: any LoRA file the engine can see that OpenField does not
 * already load for one of its apps, offered in Image (Qwen-Image, FLUX.2) and
 * Video (LTX-2.5, cast sheets included).
 *
 * Each file's family comes from its tensor keys, not its name: a LoRA loaded
 * onto the wrong model does nothing (ComfyUI only logs "lora key not loaded"),
 * so the menus only offer a file where it can work and the server refuses a
 * mismatch with a readable error. Headers are read straight off disk through
 * the engine's own LoRA folder list (/internal/folder_paths), which is cheap:
 * 8 bytes plus a JSON header, no tensor data.
 *
 * Only names from the engine's LoraLoaderModelOnly list are ever accepted, so a
 * request can never name a path.
 */
import { existsSync } from 'fs';
import { open, stat } from 'fs/promises';
import { join } from 'path';
import { config } from './config.js';
import { comboOptions } from './comfy.js';
import { BUNDLES } from './models.js';
import { configuredSlots } from './graphs/slots.js';

export type LoraFamily = 'ltx' | 'qwen' | 'flux2' | 'flux' | 'wan' | 'other';

export interface UserLora {
  name: string;
  /** null when the file could not be read from here (still offered everywhere). */
  family: LoraFamily | null;
  /** First trigger-like tag from the trainer's metadata, when it wrote one. */
  trigger?: string;
}

export interface LoraPick { name: string; strength: number }

export const MAX_USER_LORAS = 4;

/** Files OpenField loads itself (effects, IC-LoRAs, distills): never offered as yours. */
const BUILT_IN = new Set(BUNDLES.flatMap((b) => b.files.filter((f) => f.dir === 'loras' || f.dir === 'embeddings').map((f) => f.file)));

/**
 * Task LoRAs that only work inside a particular recipe, so stacking one on a
 * plain render does nothing useful or breaks sampling: in-context (IC) LoRAs
 * need their guide, step distills need their own sigmas, Marigold reads depth,
 * Multiple-angles is Edit's camera instruction set.
 */
const TASK_LORA = /ic-lora|lightning|turbo|lightx2v|distill|fasth3|marigold|multiple-angles/i;

/** The model each app's own LoRAs must match. */
export const FAMILY_LABEL: Record<LoraFamily, string> = {
  ltx: 'LTX', qwen: 'Qwen-Image', flux2: 'FLUX.2', flux: 'FLUX.1', wan: 'Wan', other: 'another model',
};

/** Family from the tensor key names of a LoRA's safetensors header. */
export function familyOf(keys: string[]): LoraFamily | 'not-lora' {
  const lora = keys.some((k) => /\.(lora_[AB]|lora_up|lora_down|lora\.(up|down))(\.[a-z]+)?\.weight$/.test(k) || /\.alpha$/.test(k));
  if (!lora) return 'not-lora';
  const has = (re: RegExp) => keys.some((k) => re.test(k));
  // [._] between tokens: diffusers keys use dots, kohya keys (lora_unet_transformer_blocks_0_...) use underscores.
  if (has(/(double|single)_stream_modulation/)) return 'flux2';
  if (has(/double_blocks[._]\d+[._]/)) return 'flux';
  if (has(/transformer_blocks[._]\d+[._](attn[._]add_[qkv]_proj|img_mlp|txt_mlp|img_mod)/)) return 'qwen';
  if (has(/transformer_blocks[._]\d+[._](attn1|attn2|audio_attn|ff)[._]/)) return 'ltx';
  if (has(/(^|[._])blocks[._]\d+[._](cross_attn|self_attn)[._]/)) return 'wan';
  return 'other';
}

/** A folder path as ComfyUI reports it, made readable from this process (WSL sees D:\ as /mnt/d). */
function localPath(dir: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
  if (m && process.platform !== 'win32') return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  return dir;
}

let dirsCache: { at: number; dirs: string[] } | null = null;
async function loraDirs(): Promise<string[]> {
  if (dirsCache && Date.now() - dirsCache.at < 60_000) return dirsCache.dirs;
  let dirs: string[] = [];
  try {
    const r = await fetch(`${config.comfyUrl}/internal/folder_paths`, { signal: AbortSignal.timeout(4000) });
    const d = (await r.json()) as Record<string, [string[], unknown] | string[]>;
    const entry = d.loras;
    const list = Array.isArray(entry?.[0]) ? (entry[0] as string[]) : (entry as string[] | undefined) ?? [];
    dirs = list.map(localPath);
  } catch { /* engine down or an older build without the route */ }
  if (config.comfyModelsDir) dirs.push(join(config.comfyModelsDir, 'loras'));
  dirs = [...new Set(dirs)].filter((d) => existsSync(d));
  dirsCache = { at: Date.now(), dirs };
  return dirs;
}

const headerCache = new Map<string, { mtime: number; family: LoraFamily | 'not-lora'; trigger?: string }>();

async function readHeader(path: string): Promise<{ keys: string[]; meta: Record<string, string> }> {
  const fh = await open(path, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    await fh.read(lenBuf, 0, 8, 0);
    const len = Number(lenBuf.readBigUInt64LE(0));
    if (len <= 0 || len > 100 * 1024 * 1024) throw new Error('bad header');
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 8);
    const h = JSON.parse(buf.toString()) as Record<string, unknown>;
    const meta = (h.__metadata__ ?? {}) as Record<string, string>;
    delete h.__metadata__;
    return { keys: Object.keys(h), meta };
  } finally {
    await fh.close();
  }
}

/** The most frequent caption tag a kohya-style trainer recorded, if any. */
function triggerFrom(meta: Record<string, string>): string | undefined {
  try {
    const freq = JSON.parse(meta.ss_tag_frequency ?? '{}') as Record<string, Record<string, number>>;
    const tags = Object.values(freq).flatMap((t) => Object.entries(t));
    tags.sort((a, b) => b[1] - a[1]);
    const t = tags[0]?.[0]?.trim();
    return t && t.length <= 40 ? t : undefined;
  } catch {
    return undefined;
  }
}

async function classify(name: string, dirs: string[]): Promise<{ family: LoraFamily | 'not-lora' | null; trigger?: string }> {
  for (const d of dirs) {
    const path = join(d, name);
    let st;
    try { st = await stat(path); } catch { continue; }
    const hit = headerCache.get(path);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    try {
      const { keys, meta } = await readHeader(path);
      const v = { mtime: st.mtimeMs, family: familyOf(keys), trigger: triggerFrom(meta) };
      headerCache.set(path, v);
      return v;
    } catch {
      return { family: null };
    }
  }
  return { family: null };
}

/** A LoRA name as ComfyUI lists it is yours: not one OpenField loads itself, nor a task LoRA. */
export function isUserLora(name: string): boolean {
  const base = name.split(/[\\/]/).pop()!;
  // A file set for a LoRA slot in .env is OpenField's own as well.
  const slotted = configuredSlots().some((c) => c.slot.dir === 'loras' && c.file === name);
  return !BUILT_IN.has(base) && !slotted && !TASK_LORA.test(base);
}

/** Every LoRA the engine sees that is yours to add, with its family. */
export async function listUserLoras(): Promise<UserLora[]> {
  const names = (await comboOptions('LoraLoaderModelOnly', 'lora_name')).filter(isUserLora);
  const dirs = await loraDirs();
  const out: UserLora[] = [];
  for (const name of names) {
    if (!/\.(safetensors|ckpt|pt|pth|bin)$/i.test(name)) continue;
    const c = name.endsWith('.safetensors') ? await classify(name, dirs) : { family: null };
    if (c.family === 'not-lora') continue;
    out.push({ name, family: c.family, ...(c.trigger ? { trigger: c.trigger } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validate the LoRAs a request asks for against what the engine has and the
 * model the app runs. Returns them in graph-ready form; throws a readable error
 * on a missing file or a LoRA made for another model.
 */
export async function pickLoras(raw: unknown, family: LoraFamily, appLabel: string): Promise<LoraPick[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('loras must be a list of { name, strength }');
  const asked = raw
    .filter((l): l is { name: string; strength?: unknown } => !!l && typeof (l as any).name === 'string' && (l as any).name)
    .slice(0, MAX_USER_LORAS + 1);
  if (!asked.length) return [];
  if (asked.length > MAX_USER_LORAS) throw new Error(`Up to ${MAX_USER_LORAS} of your own LoRAs per take`);
  const list = await listUserLoras();
  const byName = new Map(list.map((l) => [l.name, l]));
  return asked.map((l) => {
    const known = byName.get(l.name);
    if (!known) throw new Error(`The engine has no LoRA named ${l.name}. Put it in ComfyUI's models/loras folder; it shows up without a restart.`);
    if (known.family && known.family !== family) {
      throw new Error(`${l.name} is made for ${FAMILY_LABEL[known.family]}. ${appLabel} runs ${FAMILY_LABEL[family]}, so it would do nothing there.`);
    }
    const s = Number(l.strength);
    return { name: l.name, strength: Number.isFinite(s) ? Math.max(-2, Math.min(2, s)) : 1 };
  });
}
