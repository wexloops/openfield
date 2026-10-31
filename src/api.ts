/** Client-side API + live socket. */
import type { RenderTier, TierState } from './renderTier';

export interface Take {
  id: number;
  created_at: string;
  project_id: number | null;
  kind: string;
  shot_name: string;
  prompt_id: string | null;
  status: string;
  settings: string;
  output_path: string | null;
  render_seconds: number | null;
  transcript: string | null;
  starred: number;
  error: string | null;
}

export interface Project { id: number; name: string; folder: string }

export type CastKind = 'character' | 'prop' | 'place';
export interface CastRef { token: string; file: string; w: number; h: number; url: string }
export interface CastMember { id: number; name: string; kind: CastKind; refs: CastRef[]; notes: string; created_at: string }
/** Where a cast picture comes from: an upload token, a finished still take, or (MCP) a local file. */
export type CastSource = { token: string } | { takeId: number };

export interface Preamble { id: number; name: string; text: string; sort: number }

export interface ModelFileRef { file: string; dir: string; repo: string; path: string; gb: number; gated?: boolean }

export interface BundleStatus {
  id: string;
  label: string;
  purpose: string;
  license: string;
  licenseWarning?: string;
  optional: boolean;
  gb: number;
  ready: boolean;
  missingFiles: ModelFileRef[];
  missingNodes: { class: string; pack: string; url: string }[];
}

export interface Status {
  up: boolean;
  version?: string;
  gpu?: string;
  api?: boolean;
  target?: 'local' | 'cloud';
  vramFreeGb?: number;
  vramTotalGb?: number;
  queueRemaining?: number;
  otherGpuProcess?: boolean;
  /** Whether a COMFY_LAUNCH command is configured, i.e. START ENGINE can work. */
  canLaunch?: boolean;
  comfyUrl?: string;
  /** The machine-wide video render size and where it came from. */
  renderTier?: TierState;
  /** Set when the server runs as the judge preview (server/judge.ts). */
  judge?: { cap: number; used: number; left: number; maxSeconds: number };
  active: Take[];
}

/** A phone hand-off link (server/phone.ts). `url` holds the single-use secret. */
export interface PhoneSession {
  id: string;
  url: string;
  expiresAt: number;
  port: number;
  maxBytes: number;
  network: { wsl: 'none' | 'mirrored' | 'nat'; bindHost: string; urlHost: string; warning: string | null; commands: string[] };
}

/** Live phone state, relayed over /live. `result` arrives with 'received'. */
export interface PhoneEvent {
  type: 'phone';
  id: string;
  state: 'waiting' | 'opened' | 'receiving' | 'received' | 'closed';
  bytes?: number;
  result?: { token: string; name: string; bytes: number };
  reason?: 'received' | 'expired' | 'cancelled' | 'abuse' | 'replaced';
}

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  // Only claim a JSON body when one exists — Fastify 400s an empty body sent
  // with a JSON content-type, which silently broke every body-less POST
  // (STOP, CLEAR QUEUE, cancel, trash) until 2026-08-04.
  const headers = init?.body
    ? { 'Content-Type': 'application/json', ...init.headers }
    : init?.headers;
  const r = await fetch(url, init && { ...init, headers });
  // Judge preview: a lapsed sign-in goes back to the login page.
  if (r.status === 401 && url.startsWith('/api/')) {
    window.location.assign('/login');
    throw new Error('Sign in again');
  }
  const d = await r.json();
  if (!r.ok) {
    const msg = (d && (d.error || d.message)) || `${r.status}`;
    console.error(`[openfield] ${init?.method || 'GET'} ${url} failed:`, msg);
    throw new Error(msg);
  }
  return d as T;
}

export const api = {
  status: () => j<Status>('/api/status'),
  /** Set the machine-wide render size; null goes back to the default (OPENFIELD_RENDER_TIER or the GPU). */
  setRenderTier: (renderTier: RenderTier | null) =>
    j<{ renderTier: TierState }>('/api/settings', { method: 'PUT', body: JSON.stringify({ renderTier }) }),
  takes: (projectId: number | null) => j<Take[]>(`/api/takes${projectId ? `?project=${projectId}` : ''}`),
  projects: () => j<Project[]>('/api/projects'),
  addProject: (name: string, folder: string) =>
    j<{ id: number }>('/api/projects', { method: 'POST', body: JSON.stringify({ name, folder }) }),
  upload: (name: string, dataUrl: string) =>
    j<{ name: string }>('/api/upload', { method: 'POST', body: JSON.stringify({ name, dataUrl }) }),
  generate: (body: Record<string, unknown>) =>
    j<{ takeId: number; takeIds: number[] }>('/api/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  upres: (takeId: number, opts: { model?: string; rife?: boolean }) =>
    j<{ takeId: number }>(`/api/takes/${takeId}/upres`, { method: 'POST', body: JSON.stringify(opts) }),
  stop: () => j<{ ok: true }>('/api/stop', { method: 'POST' }),
  cancelTake: (id: number) => j<{ ok: true }>(`/api/takes/${id}/cancel`, { method: 'POST' }),
  clearQueue: () => j<{ ok: true }>('/api/queue/clear', { method: 'POST' }),
  startEngine: () => j<{ ok: boolean }>('/api/engine/start', { method: 'POST' }),
  models: () => j<{ checkpoints: Record<string, string[]>; card: Record<string, unknown> }>('/api/models'),
  removeQueued: (promptId: string) => j<{ ok: true }>(`/api/queue/${promptId}`, { method: 'DELETE' }),
  star: (id: number, on: boolean) => j<Take>(`/api/takes/${id}/star`, { method: 'POST', body: JSON.stringify({ on }) }),
  trash: (id: number) => j<{ ok: true }>(`/api/takes/${id}`, { method: 'DELETE' }),
  preflight: (refresh = false) =>
    j<{ bundles: BundleStatus[] }>(`/api/preflight${refresh ? '?refresh=1' : ''}`),
  preambles: () => j<Preamble[]>('/api/preambles'),
  addPreamble: (name: string, text: string) =>
    j<{ id: number }>('/api/preambles', { method: 'POST', body: JSON.stringify({ name, text }) }),
  savePreamble: (id: number, name: string, text: string) =>
    j<Preamble>(`/api/preambles/${id}`, { method: 'PUT', body: JSON.stringify({ name, text }) }),
  estimate: (q: Record<string, string | number>) =>
    j<{ seconds: number | null; samples: number }>(`/api/estimate?${new URLSearchParams(q as Record<string, string>)}`),
  free: () => j<{ ok: true }>('/api/free', { method: 'POST' }),
  phoneStart: () => j<PhoneSession>('/api/phone/start', { method: 'POST' }),
  /** Close our session only: a newer one from another window keeps running. */
  phoneStop: (id: string) => j<{ ok: true }>('/api/phone/stop', { method: 'POST', body: JSON.stringify({ id }) }),
  cast: () => j<CastMember[]>('/api/cast'),
  createCast: (m: { name: string; kind: CastKind; notes: string; refs: CastSource[] }) =>
    j<CastMember>('/api/cast', { method: 'POST', body: JSON.stringify(m) }),
  updateCast: (id: number, patch: { name?: string; kind?: CastKind; notes?: string; addRefs?: CastSource[]; removeRefs?: number[] }) =>
    j<CastMember>(`/api/cast/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCast: (id: number) => j<{ ok: true }>(`/api/cast/${id}`, { method: 'DELETE' }),
  castHero: (b: { castIds: number[]; shot: string; width?: number; height?: number }) =>
    j<{ takeId: number }>('/api/cast/hero', { method: 'POST', body: JSON.stringify(b) }),
  deletePreamble: (id: number) => j<{ ok: true }>(`/api/preambles/${id}`, { method: 'DELETE' }),
  /** Director scenes: plan a shot list (poll it), then shoot it into one cut. */
  directorPlan: (body: { scene: string; shots?: number; planner?: string }) =>
    j<ScenePlan>('/api/director/plan', { method: 'POST', body: JSON.stringify(body) }),
  directorPlanStatus: (id: string) => j<ScenePlan>(`/api/director/plan/${id}`),
  directorScene: (body: Record<string, unknown>) =>
    j<{ cutId: number; take: Take }>('/api/director/scene', { method: 'POST', body: JSON.stringify(body) }),
  /** Measure a take as a loop (stored on the take as settings.seam). */
  seam: (id: number) => j<SeamMeasure>(`/api/takes/${id}/seam`),
  /** Collect an HDR finish's EXRs and HLG master from the engine again. */
  collectHdr: (id: number) => j<Record<string, unknown>>(`/api/takes/${id}/collect-hdr`, { method: 'POST' }),
  /** Seam Doctor: auto picks trim, then a re-render across the wrap, then a new seed, by measurement. */
  /** Stage: the blocking frames rendered in WebGL become the clay and depth inputs. */
  stageBlocking: (body: { width: number; height: number; clay: string[]; depth: string[]; clayStill: string; depthStill: string }) =>
    j<StageBlocking>('/api/stage/blocking', { method: 'POST', body: JSON.stringify(body) }),
  fixSeam: (id: number, strategy: 'auto' | 'trim' | 'regen' | 'bridge' | 'reseed' = 'auto') =>
    j<{ fix: string | null; before: SeamMeasure; takeIds: number[] }>(`/api/takes/${id}/fix-seam`, { method: 'POST', body: JSON.stringify({ strategy }) }),
};

/** A blocking turned into engine inputs (server/stage.ts). */
export interface StageBlocking {
  clayVideo: string;
  depthVideo: string;
  depthImage: string;
  clayImage: string;
  width: number;
  height: number;
  frames: number;
  /** Seconds the server spent encoding and uploading. */
  took?: number;
}

/** A shot list being planned on the server (server/scene.ts). */
export interface ScenePlan {
  id: string;
  status: 'running' | 'done' | 'failed';
  scene: string;
  shots?: { framing: string; move: string; action: string; seconds: number }[];
  planner?: 'engine' | 'llm' | 'ollama' | 'split';
  notes: string[];
  seconds?: number;
  error?: string;
}

/** How a loop closes (server/seam.ts). ratio is the wrap as a multiple of an ordinary frame step. */
export interface SeamMeasure {
  n: number;
  fps: number;
  verdict: 'seamless' | 'visible';
  ratio: number;
  texture: { wrap: number; local: number; median: number; ratio: number };
  composition: { wrap: number; local: number; ratio: number };
  splices?: { frame: number; ratio: number }[];
}

export interface LiveEvents {
  onProgress: (v: { promptId: string; value: number; max: number }) => void;
  onStarted?: (promptId: string) => void;
  onPreview: (blobUrl: string, promptId: string | null) => void;
  onTake: (take: Take) => void;
  onQueue: (remaining: number) => void;
  onPhone?: (e: PhoneEvent) => void;
}

/** Connect the live socket; auto-reconnects. Returns a cleanup fn. */
export function connectLive(ev: LiveEvents): () => void {
  let ws: WebSocket | null = null;
  let dead = false;
  let lastPreview: string | null = null;
  let previewJob: string | null = null;

  const open = () => {
    ws = new WebSocket(`ws://${location.host}/live`);
    ws.binaryType = 'blob';
    ws.onmessage = (m) => {
      if (m.data instanceof Blob) {
        if (lastPreview) URL.revokeObjectURL(lastPreview);
        lastPreview = URL.createObjectURL(m.data);
        ev.onPreview(lastPreview, previewJob);
        return;
      }
      try {
        const d = JSON.parse(m.data);
        if (d.type === 'preview') previewJob = d.promptId ?? null;
        if (d.type === 'progress') ev.onProgress(d);
        if (d.type === 'started') ev.onStarted?.(d.promptId);
        if (d.type === 'take') ev.onTake(d.take);
        if (d.type === 'queue') ev.onQueue(d.remaining);
        if (d.type === 'phone') ev.onPhone?.(d);
      } catch { /* ignore */ }
    };
    ws.onclose = () => { if (!dead) setTimeout(open, 2500); };
  };
  open();
  return () => { dead = true; ws?.close(); };
}

export const mediaUrl = (id: number) => `/api/media/${id}`;
export const posterUrl = (id: number) => `/api/poster/${id}`;
export const downloadUrl = (id: number) => `/api/media/${id}?download=1`;
/** An Object take's sidecars: the turntable render and the isolated subject it was built from. */
export const turntableUrl = (id: number) => `/api/takes/${id}/turntable`;
export const subjectUrl = (id: number) => `/api/takes/${id}/subject`;
/** An HDR finish's downloads: the EXR zip, the HLG HEVC .mov, the HLG ProRes .mov. */
export const finishFileUrl = (id: number, which: 'exr' | 'hlg' | 'prores') => `/api/takes/${id}/file/${which}`;
export const inputUrl = (token: string) => `/api/input-image/${encodeURIComponent(token)}`;
/** A take's ComfyUI workflow (API format). The path ends in a .json filename
 *  because ComfyUI names a dropped link after its URL and types it by extension. */
export const workflowUrl = (id: number, download = false) =>
  `/api/takes/${id}/workflow/openfield_take_${id}.json${download ? '?download=1' : ''}`;

/** Read a File as a data URL and upload it; returns the asset token. */
export async function uploadFile(f: File): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
  return (await api.upload(f.name, dataUrl)).name;
}

/** Upload a finished take's media as a new input (Animate, Use as reference). */
export async function takeAsInput(id: number, name = `take_${id}.png`): Promise<string> {
  const blob = await (await fetch(mediaUrl(id))).blob();
  return uploadFile(new File([blob], name, { type: blob.type }));
}
