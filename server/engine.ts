/**
 * Job engine: every render OpenField runs goes through the Comfy SDK
 * (@comfyorg/sdk, Comfy API v2). The same code targets a local ComfyUI
 * behind comfy-api-proxy (the default) or Comfy Cloud / a Comfy API
 * deployment; only COMFY_BASE_URL and COMFY_API_KEY change.
 *
 * Emits on `engine`:
 *  'progress' { jobId, value, step, steps }
 *  'preview'  { jobId, data: Buffer }
 *  'status'   { jobId, status, queuePosition }
 *  'finished' { jobId }   (terminal state reached; call result())
 */
import { Comfy, type Job } from '@comfyorg/sdk';
import { EventEmitter } from 'events';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { chunkVideoDecodes, currentVideoDecode } from './videoDecode.js';

// 'expired': the proxy lost the job (e.g. ComfyUI restarted under it).
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'expired']);
const INPUT_CACHE = join(config.dataDir, 'inputs');
const ASSET_TOKEN = /^asset:([0-9a-f-]{36})$/i;

export const engine = new EventEmitter();

let client: Comfy | null = null;
function sdk(): Comfy {
  if (!client) {
    process.env.COMFY_BASE_URL = config.comfyBaseUrl;
    client = new Comfy({
      apiKey: config.comfyApiKey || undefined,
      clientInfo: 'openfield',
    });
  }
  return client;
}

const jobs = new Map<string, Job>();
/** When we first saw each job running; the local proxy does not report started_at. */
const runningSince = new Map<string, number>();

/**
 * Upload an input file as a Comfy asset. Returns an `asset:<id>` token the
 * graph builders drop into a loader's file widget; submit() swaps it for the
 * SDK's asset reference. A local copy is kept for restoring input wells.
 */
export async function uploadInput(name: string, data: Buffer, contentType?: string): Promise<string> {
  const asset = sdk().assets.fromBytes(new Uint8Array(data), { filename: name, contentType });
  const id = await asset.commit();
  await mkdir(INPUT_CACHE, { recursive: true });
  await writeFile(join(INPUT_CACHE, id), data);
  await writeFile(join(INPUT_CACHE, `${id}.name`), name);
  return `asset:${id}`;
}

/** Bytes of an uploaded input, from the local cache. */
export async function readInput(token: string): Promise<{ data: Buffer; name: string } | null> {
  const id = ASSET_TOKEN.exec(token)?.[1];
  if (!id || !existsSync(join(INPUT_CACHE, id))) return null;
  const nameFile = join(INPUT_CACHE, `${id}.name`);
  return {
    data: await readFile(join(INPUT_CACHE, id)),
    name: existsSync(nameFile) ? (await readFile(nameFile, 'utf8')).trim() : id,
  };
}

/** Local path of an uploaded input's bytes (for probing), or null. */
export function inputPath(token: string): string | null {
  const id = ASSET_TOKEN.exec(token)?.[1];
  return id && existsSync(join(INPUT_CACHE, id)) ? join(INPUT_CACHE, id) : null;
}

/** Replace every `asset:<id>` string in a graph with an SDK asset reference. */
function bindAssets(graph: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(graph);
  for (const node of Object.values(out) as any[]) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    for (const [k, v] of Object.entries(inputs)) {
      const m = typeof v === 'string' ? ASSET_TOKEN.exec(v) : null;
      if (m) inputs[k] = { __type: 'core/ASSET', info: { id: m[1] } };
    }
  }
  return out;
}

/**
 * A copy of a graph with every `asset:<id>` token replaced by the name the
 * input was uploaded under. Fallback for when the engine cannot hand back the
 * graph it ran (see executedWorkflow); ComfyUI may have stored the file under
 * a slightly different name.
 */
export async function withInputNames(graph: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = structuredClone(graph);
  for (const node of Object.values(out) as any[]) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    for (const [k, v] of Object.entries(inputs)) {
      if (typeof v !== 'string' || !ASSET_TOKEN.test(v)) continue;
      inputs[k] = (await readInput(v))?.name ?? v;
    }
  }
  return out;
}

/**
 * The API-format graph a job actually ran, from the engine
 * (GET /api/v2/jobs/{id}/workflow). Asset references come back resolved to
 * the filenames in ComfyUI's input folder, so the graph loads in ComfyUI as-is.
 * Null when the engine no longer has it or only has the authoring format.
 */
export async function executedWorkflow(jobId: string): Promise<Record<string, unknown> | null> {
  try {
    const job = jobs.get(jobId) ?? (await sdk().jobs.get(jobId));
    const wf = await job.getWorkflow();
    return wf.format === 'api' ? (wf.workflow as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Submit an API-format graph. Returns the Comfy job id. In chunks mode (Setup
 * > Video decode) its whole-clip video decodes are switched to chunks first,
 * in place, so the copy the caller records is what ran.
 */
export async function submit(graph: Record<string, unknown>): Promise<string> {
  if ((await currentVideoDecode()) === 'chunked') chunkVideoDecodes(graph);
  const wf = sdk().workflows.fromJson(bindAssets(graph));
  const job = await sdk().submit(wf);
  jobs.set(job.id, job);
  void watch(job);
  return job.id;
}

/** Follow a job's event stream until it reaches a terminal state. */
async function watch(job: Job): Promise<void> {
  try {
    for await (const ev of job.events()) {
      if (ev.kind === 'progress') {
        engine.emit('progress', { jobId: job.id, value: ev.value, step: ev.step, steps: ev.steps });
      } else if (ev.kind === 'preview') {
        engine.emit('preview', { jobId: job.id, data: Buffer.from(ev.data) });
      } else if (ev.kind === 'statusChange') {
        if (ev.status === 'running' && !runningSince.has(job.id)) runningSince.set(job.id, Date.now());
        engine.emit('status', { jobId: job.id, status: ev.status, queuePosition: ev.queuePosition });
        if (TERMINAL.has(ev.status)) break;
      }
    }
  } catch (e) {
    console.error(`[openfield] event stream for ${job.id} dropped:`, e instanceof Error ? e.message : e);
  }
  // The stream is a live feed; polling is the source of truth.
  try {
    await job.wait();
  } catch {
    /* result() reports the failure */
  }
  engine.emit('finished', { jobId: job.id });
}

/** Re-attach to a job submitted before a restart. */
export async function reattach(jobId: string): Promise<void> {
  if (jobs.has(jobId)) return;
  const job = await sdk().jobs.get(jobId);
  jobs.set(jobId, job);
  void watch(job);
}

export interface JobResult {
  done: boolean;
  success?: boolean;
  canceled?: boolean;
  error?: string;
  output?: { name: string; contentType: string; data: Buffer };
  /** Side outputs a builder names (an object's 'turntable' and 'subject'), by node id. */
  extras?: { nodeId: string; name: string; contentType: string; data: Buffer }[];
  renderSeconds?: number;
}

/** Node ids whose outputs ride along with the main one (see server/graphs/trellis.ts). */
const EXTRA_NODES = new Set(['turntable', 'subject']);

/**
 * 3D files a job saved, read from ComfyUI's history. SaveGLB reports them under
 * a "3d" key that the v2 API does not list as an output, so locally they are
 * fetched from ComfyUI's /view like any output file.
 */
async function savedModels(promptId: string): Promise<{ nodeId: string; name: string; contentType: string; data: Buffer }[]> {
  try {
    const r = await fetch(`${config.comfyUrl}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(5000) });
    const h = (await r.json()) as Record<string, { outputs?: Record<string, Record<string, unknown>> }>;
    const out = [];
    for (const [nodeId, o] of Object.entries(h[promptId]?.outputs ?? {})) {
      const items = Array.isArray(o['3d']) ? (o['3d'] as { filename: string; subfolder?: string; type?: string }[]) : [];
      for (const it of items) {
        const q = new URLSearchParams({ filename: it.filename, subfolder: it.subfolder ?? '', type: it.type ?? 'output' });
        const f = await fetch(`${config.comfyUrl}/view?${q}`, { signal: AbortSignal.timeout(120_000) });
        if (!f.ok) continue;
        const ext = it.filename.split('.').pop()?.toLowerCase();
        out.push({
          nodeId, name: it.filename, data: Buffer.from(await f.arrayBuffer()),
          contentType: ext === 'glb' ? 'model/gltf-binary' : ext === 'obj' ? 'model/obj' : 'application/octet-stream',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Start and end of a prompt's execution from ComfyUI's history, in ms. */
async function executionWindow(promptId: string): Promise<{ start?: number; end?: number } | null> {
  try {
    const r = await fetch(`${config.comfyUrl}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(3000) });
    const h = (await r.json()) as Record<string, { status?: { messages?: [string, { timestamp?: number }][] } }>;
    const msgs = h[promptId]?.status?.messages ?? [];
    const at = (kind: string) => msgs.find((m) => m[0] === kind)?.[1]?.timestamp;
    const start = at('execution_start');
    const end = at('execution_success') ?? at('execution_error') ?? at('execution_interrupted');
    return start ? { start, end } : null;
  } catch {
    return null;
  }
}

/** Final state of a job plus the bytes of its first output. */
export async function result(jobId: string): Promise<JobResult> {
  const job = jobs.get(jobId) ?? (await sdk().jobs.get(jobId));
  await job.refresh();
  if (!TERMINAL.has(job.status)) return { done: false };
  jobs.delete(jobId);
  // Locally the job id is ComfyUI's prompt id, and ComfyUI's history has exact
  // execution timestamps. The event stream can miss the running event (the proxy
  // caps live streams), so it is only the fallback.
  const exec = isLocal() ? await executionWindow(jobId) : null;
  const started = exec?.start ?? job.startedAt?.getTime() ?? runningSince.get(jobId);
  const ended = exec?.end ?? job.completedAt?.getTime() ?? Date.now();
  runningSince.delete(jobId);
  const renderSeconds = started ? (ended - started) / 1000 : undefined;
  if (job.status !== 'succeeded') {
    const err = job.error as any;
    return {
      done: true,
      success: false,
      canceled: job.status === 'canceled' || job.status === 'cancelled',
      error: String(err?.message ?? err?.detail ?? job.status).slice(0, 500),
      renderSeconds,
    };
  }
  // Prefer the graph's own save node ('save' or 'out' in every OpenField
  // builder): a core LoadVideo also reports its input as a video output, and
  // other nodes (GLSLShader) report preview images. Then the media a user
  // wants (video, then image) over previews/temp.
  const all = job.outputs.filter((o) => !EXTRA_NODES.has(o.nodeId));
  const extras = await Promise.all(job.outputs.filter((o) => EXTRA_NODES.has(o.nodeId))
    .map(async (o) => ({ nodeId: o.nodeId, name: o.name, contentType: o.contentType, data: Buffer.from(await o.toBytes()) })));
  // A 3D save is the take's file when the graph has one.
  const model = isLocal() ? (await savedModels(jobId)).find((m) => m.nodeId === 'save') : undefined;
  if (model) return { done: true, success: true, output: model, extras, renderSeconds };
  const saved = all.filter((o) => o.nodeId === 'save' || o.nodeId === 'out');
  const outs = saved.length ? saved : all;
  const pick =
    outs.find((o) => (o.nodeId === 'save' || o.nodeId === 'out') && o.contentType.startsWith('video/')) ??
    outs.find((o) => (o.nodeId === 'save' || o.nodeId === 'out') && o.contentType.startsWith('image/')) ??
    outs.find((o) => o.contentType.startsWith('video/')) ??
    outs.find((o) => o.contentType.startsWith('image/')) ??
    outs[0];
  if (!pick) return { done: true, success: false, error: 'No output produced', renderSeconds };
  return {
    done: true,
    success: true,
    output: { name: pick.name, contentType: pick.contentType, data: Buffer.from(await pick.toBytes()) },
    extras,
    renderSeconds,
  };
}

/** Cancel one job, queued or running. */
export async function cancel(jobId: string): Promise<void> {
  const job = jobs.get(jobId) ?? (await sdk().jobs.get(jobId));
  await job.cancel();
}

/** Cancel every job this process is tracking. */
export async function cancelAll(): Promise<void> {
  await Promise.allSettled([...jobs.values()].map((j) => j.cancel()));
}

/** Is the v2 API answering? */
export async function apiUp(): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (config.comfyApiKey) headers.Authorization = `Bearer ${config.comfyApiKey}`;
    const r = await fetch(`${config.comfyBaseUrl}/api/v2/jobs?limit=1`, {
      headers,
      signal: AbortSignal.timeout(4000),
    });
    // 501 = Comfy Cloud has no job list yet, but it answered.
    return r.ok || r.status === 501;
  } catch {
    return false;
  }
}

export const isLocal = () => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(config.comfyBaseUrl);

let proxyChild: import('child_process').ChildProcess | null = null;

/**
 * Local mode only: start comfy-api-proxy in front of ComfyUI if the v2 API is
 * not already answering. The proxy keeps job state in <data>/proxy so jobs
 * survive an OpenField restart.
 */
export async function ensureProxy(timeoutMs = 20_000): Promise<boolean> {
  if (!isLocal()) return apiUp();
  if (await apiUp()) return true;
  if (proxyChild && proxyChild.exitCode === null) return waitUp(timeoutMs);
  const { spawn } = await import('child_process');
  const port = new URL(config.comfyBaseUrl).port || '8189';
  const stateDir = join(config.dataDir, 'proxy');
  await mkdir(stateDir, { recursive: true });
  try {
    proxyChild = spawn(
      config.proxyBin,
      ['run', '--comfyui', config.comfyUrl, '--port', port, '--state-dir', stateDir],
      { stdio: 'ignore' },
    );
    proxyChild.on('error', (e) => console.error(`[openfield] could not start ${config.proxyBin}:`, e.message));
  } catch (e) {
    console.error('[openfield] proxy launch failed:', e instanceof Error ? e.message : e);
    return false;
  }
  return waitUp(timeoutMs);
}

async function waitUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await apiUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Stop a proxy this process started. */
export function stopProxy(): void {
  if (proxyChild && proxyChild.exitCode === null) proxyChild.kill();
}
