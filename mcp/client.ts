/**
 * Thin HTTP client for the OpenField server (:3161), plus the local-file side
 * of uploads: read a path, measure it, POST it to /api/upload as a data URL.
 * No generation logic lives here; the server owns all of it.
 */
import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, extname, join, resolve } from 'path';
import type { ClipMeta, Dims } from './bodies.ts';

export const BASE = (process.env.OPENFIELD_URL || 'http://127.0.0.1:3161').replace(/\/+$/, '');
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

/** /api/upload takes a base64 data URL and the server's body limit is 64 MB. */
const MAX_UPLOAD = 45 * 1024 * 1024;

export interface Take {
  id: number;
  created_at: string;
  project_id: number | null;
  kind: string;
  shot_name: string;
  prompt_id: string | null;
  status: string; // queued | rendering | done | failed | stopped
  settings: string;
  output_path: string | null;
  render_seconds: number | null;
  transcript: string | null;
  starred: number;
  error: string | null;
  parent_take_id?: number | null;
}

export class ApiError extends Error {}

export interface CastMember { id: number; name: string; kind: 'character' | 'prop' | 'place'; notes: string; refs: { token: string; file: string; w: number; h: number; url: string }[] }

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  // Same rule as src/api.ts: only claim JSON when a body exists, or Fastify 400s.
  const headers = init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers;
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, init && { ...init, headers });
  } catch (e) {
    throw new ApiError(`OpenField is not answering at ${BASE} (${e instanceof Error ? e.message : e}). Start it with \`npm run dev\`, or set OPENFIELD_URL.`);
  }
  const text = await r.text();
  let d: any;
  try { d = text ? JSON.parse(text) : {}; } catch { d = { error: text.slice(0, 300) }; }
  if (!r.ok) throw new ApiError(`${init?.method || 'GET'} ${path} -> ${r.status}: ${(d && (d.error || d.message)) || text.slice(0, 200)}`);
  return d as T;
}

const post = <T>(path: string, body?: unknown) =>
  j<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  status: () => j<Record<string, any>>('/api/status'),
  /** Machine-wide settings: renderTier.tier is the default render size for every video tool. */
  settings: () => j<{ renderTier: { tier: '480p' | '720p' | '1080p'; source: string; auto: string } }>('/api/settings'),
  preflight: () => j<{ bundles: { id: string; label: string; ready: boolean; optional: boolean; licenseWarning?: string; missingFiles: unknown[]; missingNodes: unknown[] }[] }>('/api/preflight'),
  takes: (project?: number) => j<Take[]>(`/api/takes${project ? `?project=${project}` : ''}`),
  generate: (body: Record<string, unknown>) => post<{ takeId: number; takeIds: number[] }>('/api/generate', body),
  upres: (id: number, opts: { model?: string; rife?: boolean }) => post<{ takeId: number }>(`/api/takes/${id}/upres`, opts),
  cancelTake: (id: number) => post<{ ok: true }>(`/api/takes/${id}/cancel`),
  clearQueue: () => post<{ ok: true }>('/api/queue/clear'),
  upload: (name: string, dataUrl: string) => post<{ name: string }>('/api/upload', { name, dataUrl }),
  cast: () => j<CastMember[]>('/api/cast'),
  loras: () => j<{ loras: { name: string; family: string | null; trigger?: string }[] }>('/api/loras').then((d) => d.loras),
  createCast: (m: { name: string; kind: string; notes: string; refs: { token: string }[] }) => post<CastMember>('/api/cast', m),
  updateCast: (id: number, patch: Record<string, unknown>) => j<CastMember>(`/api/cast/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  directorPlan: (body: { scene: string; shots?: number; planner?: string }) => post<ScenePlan>('/api/director/plan', body),
  directorPlanStatus: (id: string) => j<ScenePlan>(`/api/director/plan/${id}`),
  directorScene: (body: Record<string, unknown>) => post<{ cutId: number; take: Take }>('/api/director/scene', body),
  seam: (id: number) => j<Record<string, any>>(`/api/takes/${id}/seam`),
  fixSeam: (id: number, body: Record<string, unknown>) =>
    post<{ fix: string | null; before: Record<string, any>; takeIds: number[] }>(`/api/takes/${id}/fix-seam`, body),
};

export interface ScenePlan {
  id: string;
  status: 'running' | 'done' | 'failed';
  shots?: { framing: string; move: string; action: string; seconds: number }[];
  planner?: 'engine' | 'llm' | 'ollama' | 'split';
  notes: string[];
  seconds?: number;
  error?: string;
}

/** An HDR finish's download URL: exr (zip), hlg (.mov), prores (.mov). */
export const finishFileUrl = (id: number, which: 'exr' | 'hlg' | 'prores') => `${BASE}/api/takes/${id}/file/${which}`;

export async function getTake(id: number): Promise<Take> {
  const t = (await api.takes()).find((x) => x.id === id);
  if (!t) throw new ApiError(`No take ${id}. list_takes shows the recent ones.`);
  return t;
}

export function settingsOf(t: Take): Record<string, any> {
  try { return JSON.parse(t.settings); } catch { return {}; }
}

export const mediaUrl = (id: number) => `${BASE}/api/media/${id}`;

async function fetchBytes(path: string): Promise<{ data: Buffer; mime: string }> {
  const r = await fetch(`${BASE}${path}`).catch((e) => { throw new ApiError(`OpenField is not answering at ${BASE}: ${e}`); });
  if (!r.ok) throw new ApiError(`GET ${path} -> ${r.status}`);
  return { data: Buffer.from(await r.arrayBuffer()), mime: (r.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
}

// ---------- local files ----------

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
};

/** Accept ~, relative paths, and Windows paths (C:\...) when running under WSL. */
export function localPath(p: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '');
  if (s.startsWith('~')) s = join(homedir(), s.slice(1));
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(s);
  if (win && process.platform === 'linux') s = `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  return resolve(s);
}

/** Width/height from a PNG, JPEG or WebP header. */
export function imageDims(b: Buffer): Dims | undefined {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const c = b.toString('ascii', 12, 16);
    if (c === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (c === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (c === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
  }
  return undefined;
}

/** Duration and frame size via ffprobe. Falls back to the pages' onerror default (5s, size unknown). */
export function videoMeta(path: string): Promise<ClipMeta> {
  return new Promise((res) => {
    execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path], (err, out) => {
      if (err) return res({ seconds: 5, w: 0, h: 0 });
      try {
        const d = JSON.parse(out);
        res({ seconds: Number(d.format?.duration) || 5, w: d.streams?.[0]?.width || 0, h: d.streams?.[0]?.height || 0 });
      } catch { res({ seconds: 5, w: 0, h: 0 }); }
    });
  });
}

export interface Asset {
  token: string;
  dims?: Dims;
  clip?: ClipMeta;
  source: string;
  /** What the pages show for a source: the take label or the file name without extension. */
  name: string;
  takeId?: number;
  /** The take's own prompt (Extend falls back to it). */
  prompt?: string;
}

/**
 * Turn an input reference into an upload token, the way the UI does:
 * - a local file path is read and POSTed to /api/upload (uploadFile in src/api.ts)
 * - `take:<id>` re-uploads a finished take's media (takeAsInput in src/api.ts)
 */
export async function resolveInput(ref: string, want: 'image' | 'video' | 'audio'): Promise<Asset> {
  const m = /^take:(\d+)$/i.exec(ref.trim());
  if (m) {
    const t = await getTake(Number(m[1]));
    if (t.status !== 'done') throw new ApiError(`take ${t.id} is ${t.status}, not done`);
    const isStill = t.kind === 'still';
    if (want === 'image' && !isStill) throw new ApiError(`take ${t.id} is ${t.kind === 'object' ? 'a 3D model' : 'a video'}; this input needs an image`);
    if (want !== 'image' && isStill) throw new ApiError(`take ${t.id} is a still; this input needs a ${want === 'audio' ? 'sound file or a clip with sound' : 'video clip'}`);
    const { data, mime } = await fetchBytes(`/api/media/${t.id}`);
    const name = isStill ? `take_${t.id}.png` : `take_${t.id}.mp4`;
    const token = (await api.upload(name, `data:${mime};base64,${data.toString('base64')}`)).name;
    const s = settingsOf(t);
    const meta = { source: ref, name: `take ${t.id}`, takeId: t.id, prompt: s.userPrompt || s.prompt };
    if (isStill) return { token, dims: imageDims(data) ?? (s.width ? { w: s.width, h: s.height } : undefined), ...meta };
    const clip = await withTemp(data, '.mp4', videoMeta);
    return { token, clip, ...meta };
  }

  const path = localPath(ref);
  if (!existsSync(path)) throw new ApiError(`No such file: ${path}`);
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new ApiError(`Unsupported file type ${extname(path) || '(none)'}. Use ${Object.keys(MIME).join(' ')}`);
  // A sound input also takes a clip with an audio track.
  const fits = mime.startsWith(`${want}/`) || (want === 'audio' && mime.startsWith('video/'));
  if (!fits) throw new ApiError(`${basename(path)} is not ${want === 'image' ? 'an image' : want === 'audio' ? 'a sound file' : 'a video'}`);
  const data = await readFile(path);
  if (data.length > MAX_UPLOAD) throw new ApiError(`${basename(path)} is ${(data.length / 1e6).toFixed(0)} MB; the upload limit is ${MAX_UPLOAD / 1024 / 1024} MB. Trim or re-encode it.`);
  const token = (await api.upload(basename(path), `data:${mime};base64,${data.toString('base64')}`)).name;
  const name = basename(path).replace(/\.[^.]+$/, '');
  if (want === 'image') return { token, dims: imageDims(data), source: path, name };
  return { token, clip: await videoMeta(path), source: path, name };
}

async function withTemp<T>(data: Buffer, ext: string, fn: (p: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'openfield-mcp-'));
  const p = join(dir, `clip${ext}`);
  try {
    await writeFile(p, data);
    return await fn(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- previews ----------

/** Poster frame for a take as MCP image content: stills are downscaled to keep it small. */
export async function posterImage(id: number): Promise<{ data: string; mimeType: string } | null> {
  let img: { data: Buffer; mime: string };
  try { img = await fetchBytes(`/api/poster/${id}`); } catch { return null; }
  if (img.data.length > 600_000) {
    const small = await shrink(img.data).catch(() => null);
    if (small) img = { data: small, mime: 'image/jpeg' };
    else if (img.data.length > 4_000_000) return null;
  }
  return { data: img.data.toString('base64'), mimeType: img.mime };
}

function shrink(input: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=768:-2', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1']);
    const out: Buffer[] = [];
    p.stdout.on('data', (c) => out.push(c));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 && out.length ? res(Buffer.concat(out)) : rej(new Error(`ffmpeg exit ${code}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}
