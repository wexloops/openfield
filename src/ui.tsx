/** Shared UI kit: icons, chips with menus, media cards, GPU chip, logo. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, posterUrl, mediaUrl, turntableUrl, type Take } from './api';
import { isActive, isImage, isModel, refreshStatus, settingsOf, toast, useStore } from './store';
import { APP_MAX_TIER, RENDER_TIERS, appTier, tierCapNote, tierDef, tiersUpTo, type RenderTier, type TierApp } from './renderTier';
import { takeDragProps } from './drop';
import { VIDEO_DECODES, type VideoDecode } from './videoDecode';

// ---------- icons (1.6px stroke, 16px box) ----------
const P: Record<string, ReactNode> = {
  image: <><rect x="2.5" y="3" width="11" height="10" rx="2" /><circle cx="6" cy="6.5" r="1.2" /><path d="M3 11.5l3.2-3 2.3 2 2-1.6 2.5 2.4" /></>,
  video: <><rect x="2" y="3.5" width="9" height="9" rx="2" /><path d="M11 7l3-2v6l-3-2" /></>,
  audio: <><path d="M6 11.5V4l6-1.5V10" /><circle cx="4.5" cy="11.5" r="1.5" /><circle cx="10.5" cy="10" r="1.5" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  aspect: <><rect x="2.5" y="4" width="11" height="8" rx="1.5" /></>,
  res: <><path d="M8 2.5l5 3v5l-5 3-5-3v-5z" /></>,
  sparkle: <><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M12 4l-1.8 1.8M5.8 10.2L4 12" /></>,
  plus: <><path d="M8 3v10M3 8h10" /></>,
  minus: <><path d="M3 8h10" /></>,
  x: <><path d="M4 4l8 8M12 4l-8 8" /></>,
  chev: <><path d="M6 4l4 4-4 4" /></>,
  down: <><path d="M4 6l4 4 4-4" /></>,
  heart: <><path d="M8 13s-5-3-5-6.5A2.5 2.5 0 018 5a2.5 2.5 0 015 1.5C13 10 8 13 8 13z" /></>,
  download: <><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" /></>,
  redo: <><path d="M12.5 6.5A5 5 0 103 9" /><path d="M12.5 3v3.5H9" /></>,
  wand: <><path d="M3 13l7-7M9 3l.5 1.5L11 5l-1.5.5L9 7l-.5-1.5L7 5l1.5-.5zM12.5 8l.3.9.9.3-.9.3-.3.9-.3-.9-.9-.3.9-.3z" /></>,
  ref: <><rect x="2.5" y="2.5" width="7" height="7" rx="1.5" /><path d="M6.5 13.5h7v-7" /></>,
  up: <><path d="M3 10l5-5 5 5" /></>,
  loop: <><path d="M3 8a4 4 0 017-2.6M13 8a4 4 0 01-7 2.6" /><path d="M10 2.5v3h-3M6 13.5v-3h3" /></>,
  phone: <><rect x="4.5" y="1.5" width="7" height="13" rx="1.8" /><path d="M7 12.5h2" /></>,
  camera: <><rect x="2" y="4.5" width="12" height="8.5" rx="2" /><circle cx="8" cy="8.7" r="2.3" /><path d="M5.5 4.5l1-2h3l1 2" /></>,
  film: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M5 2.5v11M11 2.5v11M2.5 6h2.5M2.5 10h2.5M11 6h2.5M11 10h2.5" /></>,
  light: <><circle cx="8" cy="7" r="3" /><path d="M6.5 11.5h3M7 13.5h2M8 1.5v1M2.5 7h1M12.5 7h1M4 3l.7.7M12 3l-.7.7" /></>,
  palette: <><path d="M8 2.5a5.5 5.5 0 100 11c1 0 1.2-.8.8-1.5-.5-.8 0-1.8 1-1.8h1.4a2.3 2.3 0 002.3-2.4A5.5 5.5 0 008 2.5z" /><circle cx="5.3" cy="7" r=".7" /><circle cx="7.5" cy="5" r=".7" /><circle cx="10.4" cy="5.7" r=".7" /></>,
  person: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" /></>,
  grid: <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3 3" /></>,
  bolt: <><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" /></>,
  mirror: <><path d="M8 2v12" /><path d="M5.5 4.5L2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5" /></>,
  orbit: <><ellipse cx="8" cy="8" rx="6" ry="3" /><circle cx="8" cy="8" r="1.5" /></>,
  stop: <><rect x="4" y="4" width="8" height="8" rx="1.5" /></>,
  nodes: <><rect x="1.5" y="3" width="4.5" height="4" rx="1" /><rect x="10" y="9" width="4.5" height="4" rx="1" /><path d="M6 5h4.75a1.5 1.5 0 011.5 1.5V9" /></>,
  cutout: <><circle cx="4.5" cy="11.5" r="2" /><circle cx="11.5" cy="11.5" r="2" /><path d="M5.9 10L11 2.5M10.1 10L5 2.5" /></>,
  cube: <><path d="M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9z" /><path d="M2.5 4.9L8 8l5.5-3.1M8 8v6.2" /></>,
  cpu: <><rect x="4" y="4" width="8" height="8" rx="1.5" /><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" /></>,
};

export function Icon({ name, size = 16 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {P[name] ?? P.sparkle}
    </svg>
  );
}

export function Logo({ size = 26 }: { size?: number }) {
  // A field of points; one is lit.
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-label="OpenField">
      <rect width="26" height="26" rx="7" fill="#1a1917" />
      {[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => (
        <circle key={`${r}${c}`} cx={7 + c * 6} cy={7 + r * 6} r={r === 0 && c === 2 ? 2.6 : 1.5}
          fill={r === 0 && c === 2 ? '#ffb547' : 'rgba(239,234,224,.5)'}
          style={r === 0 && c === 2 ? { filter: 'drop-shadow(0 0 3px rgba(255,181,71,.9))' } : undefined} />
      )))}
    </svg>
  );
}

// ---------- media that lights the room ----------
/** Blurred, saturated copy of a piece of media, placed behind a panel so the work tints the chrome around it. */
export function Spill({ src, video }: { src: string; video?: boolean }) {
  return (
    <div className="spill" aria-hidden>
      {video ? <video src={src} muted loop autoPlay playsInline preload="metadata" /> : <img src={src} alt="" />}
    </div>
  );
}

/** A motion preset's rendered clip (public/presets/<id>.mp4). */
export const presetClip = (id: string) => `/presets/${id}.mp4`;

export function Clip({ src, className = 'art' }: { src: string; className?: string }) {
  return <video className={className} src={src} muted loop autoPlay playsInline preload="metadata" />;
}

// ---------- popover menus ----------
export function useClickAway(ref: React.RefObject<HTMLElement | null>, onAway: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onAway(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onAway(); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [ref, onAway, active]);
}

export interface Opt<T extends string | number> { value: T; label: string; note?: string; disabled?: boolean }

/** Icon + value chip that opens a menu of options. */
export function ChipMenu<T extends string | number>(props: {
  icon?: string; label?: string; value: T; options: Opt<T>[]; onChange: (v: T) => void; dir?: 'up' | 'down'; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false), open);
  const cur = props.options.find((o) => o.value === props.value);
  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="chip" onClick={() => setOpen(!open)} title={props.title}>
        {props.icon && <Icon name={props.icon} size={14} />}
        {props.label && <span className="dim">{props.label}</span>}
        <span>{cur?.label ?? String(props.value)}</span>
      </button>
      {open && (
        <div className={`popover ${props.dir ?? 'up'}`} style={props.dir === 'down' ? undefined : { left: 0 }}>
          {props.title && <div className="pop-title label">{props.title}</div>}
          {props.options.map((o) => (
            <button key={String(o.value)} type="button" disabled={o.disabled}
              className={`pop-item ${o.value === props.value ? 'on' : ''}`}
              onClick={() => { props.onChange(o.value); setOpen(false); }}>
              <span>{o.label}</span>{o.note && <small>{o.note}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Stepper({ value, min, max, onChange, fmt }: { value: number; min: number; max: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <div className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label="fewer"><Icon name="minus" size={13} /></button>
      <span>{fmt ? fmt(value) : value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label="more"><Icon name="plus" size={13} /></button>
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Toast() {
  const t = useStore((s) => s.toast);
  if (!t) return null;
  return <div className={`toast ${t.err ? 'err' : ''}`}>{t.text}</div>;
}

// ---------- render size ----------
/** The machine-wide render size (Setup, or the GPU chip). 720p until the server answers. */
export function useRenderTier(): RenderTier {
  return useStore((s) => s.status?.renderTier?.tier) ?? '720p';
}

/**
 * A page's size chip: it follows the machine-wide render size until a size is
 * picked on the page, and stays at or under the app's largest safe size.
 */
export function useTierChoice(app: TierApp): [RenderTier, (t: RenderTier) => void] {
  const global = useRenderTier();
  const [own, setOwn] = useState<RenderTier | null>(null);
  return [appTier(app, own ?? global), setOwn];
}

/** The size chip itself. Apps that stop below 1080p say so, and point at Upscale. */
export function TierChip({ app, value, onChange }: { app: TierApp; value: RenderTier; onChange: (t: RenderTier) => void }) {
  // The judge preview stops every app at 720p.
  const judge = useStore((s) => !!s.status?.judge);
  const max = judge && APP_MAX_TIER[app] === '1080p' ? '720p' : APP_MAX_TIER[app];
  return (
    <ChipMenu icon="res" value={value} onChange={onChange}
      title={tierCapNote(app) ?? 'Render size'}
      options={tiersUpTo(max).map((t) => ({ value: t.id, label: t.id, note: t.short }))} />
  );
}

/** The machine-wide render size, as Setup and the GPU chip show it. Shared by every browser and the MCP server. */
export function RenderTierPicker({ compact }: { compact?: boolean }) {
  const st = useStore((s) => s.status?.renderTier);
  const judge = useStore((s) => !!s.status?.judge);
  const [busy, setBusy] = useState(false);
  async function pick(t: RenderTier | null) {
    setBusy(true);
    try {
      await api.setRenderTier(t);
      await refreshStatus();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the render size', true);
    } finally {
      setBusy(false);
    }
  }
  const cur = st?.tier ?? '720p';
  const why = !st ? '' : st.source === 'env' ? 'Set by OPENFIELD_RENDER_TIER.' : st.source === 'gpu' ? 'Picked for this card.' : `Your pick. This card's default is ${st.auto}.`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div className="seg">
        {RENDER_TIERS.map((t) => (
          <button key={t.id} type="button" className={cur === t.id ? 'on' : ''} disabled={busy || judge} title={t.note} onClick={() => void pick(t.id)}>
            {compact ? t.id : t.label}
          </button>
        ))}
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        {judge ? 'Fixed in the judge preview.' : <>{tierDef(cur).note} {why}</>}
        {!judge && st?.source === 'user' && <> <button type="button" className="linkish" disabled={busy} onClick={() => void pick(null)}>Use the default</button></>}
      </div>
    </div>
  );
}

/** The machine-wide video decode, as Setup shows it: whole clip or in chunks. */
export function VideoDecodePicker() {
  const st = useStore((s) => s.status?.videoDecode);
  const judge = useStore((s) => !!s.status?.judge);
  const [busy, setBusy] = useState(false);
  async function pick(m: VideoDecode | null) {
    setBusy(true);
    try {
      await api.setVideoDecode(m);
      await refreshStatus();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the video decode', true);
    } finally {
      setBusy(false);
    }
  }
  const cur = st?.mode ?? 'whole';
  const def = VIDEO_DECODES.find((d) => d.id === cur) ?? VIDEO_DECODES[0];
  const autoLabel = VIDEO_DECODES.find((d) => d.id === st?.auto)?.label.toLowerCase() ?? '';
  const why = !st ? '' : st.source === 'env' ? 'Set by OPENFIELD_VIDEO_DECODE.' : st.source === 'gpu' ? 'Picked for this GPU.' : `Your pick. This GPU's default is ${autoLabel}.`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div className="seg">
        {VIDEO_DECODES.map((d) => (
          <button key={d.id} type="button" className={cur === d.id ? 'on' : ''} disabled={busy || judge} title={d.note} onClick={() => void pick(d.id)}>
            {d.label}
          </button>
        ))}
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        {judge ? 'Fixed in the judge preview.' : <>{def.note} {why}</>}
        {!judge && st?.source === 'user' && <> <button type="button" className="linkish" disabled={busy} onClick={() => void pick(null)}>Use the default</button></>}
      </div>
    </div>
  );
}

// ---------- GPU chip (replaces a credits counter) ----------
export function GpuChip() {
  const st = useStore((s) => s.status);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false), open);
  // The badge is this app's takes; the engine's own queue can include other clients' jobs.
  const active = st?.active?.length ?? 0;
  const onEngine = st?.queueRemaining ?? 0;
  const used = st?.vramTotalGb && st.vramFreeGb !== undefined ? st.vramTotalGb - st.vramFreeGb : undefined;
  const pct = used !== undefined && st?.vramTotalGb ? Math.min(100, (used / st.vramTotalGb) * 100) : 0;
  const state = !st ? '' : !st.up ? 'down' : active ? 'busy' : 'up';
  const gpu = st?.target === 'cloud' ? 'Comfy Cloud' : st?.gpu?.replace(/^NVIDIA\s+(GeForce\s+)?/, '') ?? 'GPU';
  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="gpu-chip" onClick={() => setOpen(!open)}>
        <span className={`dot ${state}`} />
        <span className="mono">{st?.up ? gpu : 'Engine off'}</span>
        {st?.up && st.target !== 'cloud' && <span className="vram" title="VRAM in use"><i style={{ width: `${pct}%` }} /></span>}
        {active > 0 && <span className="badge">{active} in queue</span>}
      </button>
      {open && (
        <div className="popover down" style={{ width: 300, padding: 12 }}>
          <div className="label" style={{ marginBottom: 8 }}>Engine</div>
          <dl className="kv">
            <dt>Target</dt><dd>{st?.target === 'cloud' ? 'Comfy Cloud' : 'Local ComfyUI'}</dd>
            <dt>ComfyUI</dt><dd>{st?.up ? `v${st.version ?? '?'}` : 'not answering'}</dd>
            <dt>Comfy API v2</dt><dd>{st?.api ? 'up' : 'down'}</dd>
            {used !== undefined && <><dt>VRAM</dt><dd>{used.toFixed(1)} / {st!.vramTotalGb!.toFixed(1)} GB</dd></>}
            <dt>Jobs</dt><dd>{active ? `${active} active` : 'idle'}</dd>
            {onEngine > active && <><dt className="dim">Engine queue</dt><dd className="dim">{onEngine} on the engine</dd></>}
          </dl>
          <div className="label" style={{ margin: '12px 0 6px' }}>Render size</div>
          <RenderTierPicker compact />
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            {!st?.up && st?.canLaunch && (
              <button type="button" className="btn sm accent" onClick={() => { toast('Starting the engine...'); void api.startEngine(); }}>Start engine</button>
            )}
            {st?.up && <button type="button" className="btn sm" onClick={() => void api.free().then(() => toast('VRAM freed'))}>Free VRAM</button>}
            {active > 0 && <button type="button" className="btn sm danger" onClick={() => void api.clearQueue()}>Stop all</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- media card ----------
export function aspectOf(t: Take): string {
  const s = settingsOf(t);
  return s.width && s.height ? `${s.width} / ${s.height}` : '16 / 9';
}

export function MediaCard({ take, onOpen, actions, pendingLabel, tag }: { take: Take; onOpen?: () => void; actions?: ReactNode; pendingLabel?: string; tag?: string }) {
  const progress = useStore((s) => (take.prompt_id ? s.progress[take.prompt_id] : undefined));
  const started = useStore((st) => !!take.prompt_id && !!st.started[take.prompt_id]);
  const preview = useStore((s) => s.preview);
  const status = useStore((s) => s.status);
  const vref = useRef<HTMLVideoElement>(null);
  const s = settingsOf(take);
  const style = { ['--ar' as any]: aspectOf(take) };

  if (isActive(take)) {
    // running once the engine says so (or its steps arrive); a first-in-line take only counts as
    // running when nothing else is ahead of it in the engine's queue (another app may be using it)
    const first = status?.active?.[0]?.id === take.id;
    const foreign = (status?.queueRemaining ?? 0) > (status?.active?.length ?? 0);
    const running = started || !!progress || (first && !foreign);
    const pct = progress ? Math.round((progress.value / Math.max(1, progress.max)) * 100) : 0;
    return (
      <div className="card pending" style={style}>
        {running && preview && preview.promptId === take.prompt_id && <img src={preview.url} alt="" style={{ opacity: 0.85, filter: 'saturate(.9)' }} />}
        <div className="status">
          <div>
            <div className="label" style={{ color: 'var(--accent)' }}>{running ? (progress?.max && progress.max !== 100 ? `Step ${progress.value}/${progress.max}` : 'Rendering') : first ? 'Waiting for the engine' : pendingLabel ?? 'Queued'}</div>
          </div>
        </div>
        <div className="progress"><i style={{ width: `${running ? pct : 0}%` }} /></div>
      </div>
    );
  }
  if (take.status !== 'done' || !take.output_path) {
    return (
      <div className="card failed" style={style} title={take.error ?? ''}>
        <div className="status"><div><div className="label">{take.status}</div><div style={{ marginTop: 6, fontSize: 12 }}>{(take.error ?? '').slice(0, 110)}</div></div></div>
        <div className="quick" style={{ opacity: 1 }}>{actions}</div>
      </div>
    );
  }
  const image = isImage(take);
  const model = isModel(take);
  return (
    <div className={`card ${image && s.app === 'cutout' && s.background === 'transparent' ? 'checker' : ''}`} style={style} onClick={onOpen}
      {...takeDragProps(take.id, (take.output_path ?? `take_${take.id}`).split(/[\\/]/).pop()!, image ? 'image/png' : model ? 'model/gltf-binary' : 'video/mp4')}
      onMouseEnter={() => { const v = vref.current; if (v) { v.muted = true; void v.play().catch(() => {}); } }}
      onMouseLeave={() => { const v = vref.current; if (v) { v.pause(); v.currentTime = 0; } }}>
      <img src={posterUrl(take.id)} alt="" loading="lazy" />
      {!image && <video ref={vref} src={model ? turntableUrl(take.id) : mediaUrl(take.id)} muted loop playsInline preload="none" />}
      <div className="kind">
        {tag && <span className="badge" style={{ marginRight: 4 }}>{tag}</span>}
        {model && <span className="badge cool">3D</span>}
        {!image && !model && <span className="badge cool">{s.outSeconds ?? s.seconds ? `${s.outSeconds ?? s.seconds}s` : 'video'}</span>}
        {s.cut && <span className="badge cool" style={{ marginLeft: 4 }}>{(s.shots ?? []).length} shots</span>}
        {!image && s.seam && <span className={`badge seam ${s.seam.verdict === 'seamless' ? 'ok' : 'bad'}`} title={`Loop point: ${s.seam.ratio}x a frame step`}>{s.seam.verdict === 'seamless' ? 'Seamless' : 'Visible seam'}</span>}
        {!image && s.app === 'hdr' && <span className="badge">HDR</span>}
      </div>
      <div className="quick" onClick={(e) => e.stopPropagation()}>{actions}</div>
      <div className="scrim" />
      <div className="meta"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.userPrompt || s.prompt}</span></div>
    </div>
  );
}

export function fmtSeconds(sec: number | null | undefined): string {
  if (!sec) return '';
  if (sec < 90) return `~${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)} min`;
}

/** Live render-time estimate for the current settings. */
export function useEstimate(q: Record<string, string | number> | null): number | null {
  const [sec, setSec] = useState<number | null>(null);
  const key = q ? JSON.stringify(q) : '';
  useEffect(() => {
    if (!q) return;
    let dead = false;
    const t = setTimeout(() => api.estimate(q).then((r) => !dead && setSec(r.seconds)).catch(() => {}), 250);
    return () => { dead = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return sec;
}

// ---------- judge preview ----------
/** A slim strip under the top bar when the server runs as the judge preview. */
export function JudgeBanner() {
  const j = useStore((s) => s.status?.judge);
  if (!j) return null;
  return (
    <div className="judge-banner" role="note">
      <b>Judge preview.</b> This runs on a rented GPU with draft limits: up to {j.maxSeconds} seconds, 720p and one take per render.
      {' '}Setup is read-only, and phone capture, project folders and deleting are off.
      {' '}<span className="mono">{j.left} of {j.cap}</span> renders left today.
    </div>
  );
}
