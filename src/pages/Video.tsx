/** Video create: left control rail + canvas (History / Motion presets / How it works). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, inputUrl, uploadFile } from '../api';
import {
  ASPECTS, PRESETS, PRESET_CATS, VIDEO_MODELS, artFor, compilePrompt, presetById, videoFrame, type AspectId,
} from '../catalog';
import { availableH3Turbo, secondsToFrames } from '../presets';
import { setParams, useRoute } from '../router';
import { isImage, isModel, takeHandoff, toast, useStore, type Ref, inFeed } from '../store';
import { useDropZone, usePageDrop } from '../drop';
import { ChipMenu, Clip, Icon, MediaCard, Spill, Stepper, Switch, TierChip, fmtSeconds, presetClip, useEstimate, useTierChoice } from '../ui';
import Viewer, { animate, recreate, remove } from '../Viewer';
import { MentionBox, useMentioned } from '../Mention';
import { LoraChips, useLoraPicks } from '../Loras';
import { sheetLayout, sheetMembers, sheetSize } from '../castSheet';
import type { CastMember } from '../api';

type Mode = 'create' | 'loop';

export default function VideoPage() {
  const { params } = useRoute();
  const mode: Mode = params.get('mode') === 'loop' ? 'loop' : 'create';
  const modelId = (params.get('model') as any) || 'ltx25';
  const model = VIDEO_MODELS.find((m) => m.id === modelId) ?? VIDEO_MODELS[0];
  const preset = presetById(params.get('preset') || 'free');
  const tab = params.get('select') === 'preset' ? 'presets' : params.get('tab') || 'history';

  const [prompt, setPrompt] = useState(() => params.get('prompt') ?? '');
  const [refs, setRefs] = useState<(Ref & { w?: number; h?: number })[]>([]);
  const [aspect, setAspect] = useState<'auto' | AspectId>('auto');
  const [res, setRes] = useTierChoice('video');
  const [seconds, setSeconds] = useState(5);
  const [count, setCount] = useState(1);
  const [audio, setAudio] = useState(false);
  const [autoFix, setAutoFix] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [castMode, setCastMode] = useState<'sheet' | 'frame'>('sheet');
  const [loras, setLoras] = useLoraPicks('ltx');
  // H3 turbo: '' = full sampling. Offered only for the distills ComfyUI lists.
  const [turbo, setTurbo] = useState('');
  const [turbos, setTurbos] = useState<ReturnType<typeof availableH3Turbo>>([]);
  useEffect(() => {
    if (model.id !== 'h3') return;
    api.models().then((m) => setTurbos(availableH3Turbo(m.checkpoints.loras ?? []))).catch(() => setTurbos([]));
  }, [model.id]);

  // Take refs handed over from another page (Animate, Make a loop, ...).
  // A recipe link carries its prompt once; drop it from the URL after reading.
  useEffect(() => { if (params.get('prompt')) setParams({ prompt: null }); }, []);
  useEffect(() => {
    const h = takeHandoff();
    if (!h) return;
    setRefs(h.refs);
    if (h.prompt) setPrompt(h.prompt);
    if (h.refs.length === 2 && h.refs[0].token === h.refs[1].token) setParams({ mode: 'loop' });
  }, []);

  // Loop mode: one image is both the first and last frame.
  const start = refs.find((r) => r.role === 'start');
  const end = mode === 'loop' ? start : refs.find((r) => r.role === 'end');

  const size = useMemo(() => {
    return videoFrame(aspect, res, start);
  }, [aspect, res, start?.w, start?.h]);

  // Cast: @mentions with pictures, on LTX-2.5 with no frames of your own, bring in the cast engines.
  const castNamed = useMentioned(prompt).filter((m) => m.refs.length);
  const castOn = castNamed.length > 0 && model.id === 'ltx25' && !start && !end;
  const sheetOn = castOn && castMode === 'sheet';
  const shown = sheetOn ? (({ width, height }) => ({ w: width, h: height }))(sheetSize(size.w, size.h)) : size;
  const est = useEstimate({ kind: 'video', model: model.id, w: shown.w, h: shown.h, seconds: sheetOn ? Math.max(5, seconds) : seconds });
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && !isImage(t) && !isModel(t)));
  const compiled = compilePrompt([prompt, preset.text]);
  const needsStart = model.id === 'h3' || mode === 'loop';
  const canGo = !busy && (prompt.trim() || preset.id !== 'free' || start) && (!needsStart || start);

  async function addFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) { toast('Images only for now: drop a PNG, JPG or WebP', true); continue; }
      const dims = await new Promise<{ w: number; h: number }>((r) => {
        const img = new Image();
        img.onload = () => r({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => r({ w: 0, h: 0 });
        img.src = URL.createObjectURL(f);
      });
      try {
        const token = await uploadFile(f);
        setRefs((cur) => {
          const role: Ref['role'] = !cur.some((r) => r.role === 'start') ? 'start' : model.end && !cur.some((r) => r.role === 'end') ? 'end' : 'ref';
          return [...cur, { token, role, kind: 'image' as const, name: f.name, ...dims }].slice(0, 6);
        });
      } catch (e) {
        toast(e instanceof Error ? e.message : 'upload failed', true);
      }
    }
  }

  usePageDrop(mode === 'loop' ? 'Drop an image to loop it' : 'Drop images to use as frames', (files) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length) void addFiles(images);
    else toast('Video takes still images here. Drop a clip on Mirror, Reshoot or Upscale.', true);
  });

  function cycleRole(i: number) {
    setRefs((cur) => cur.map((r, j) => {
      if (j !== i) return r;
      const order: Ref['role'][] = model.end ? ['start', 'end', 'ref'] : ['start', 'ref'];
      const next = order[(order.indexOf(r.role) + 1) % order.length];
      return { ...r, role: next };
    }).map((r, j, all) => (j !== i && r.role !== 'ref' && r.role === all[i].role ? { ...r, role: 'ref' } : r)));
  }

  async function go() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        kind: 'video', videoModel: model.id, prompt: compiled, userPrompt: prompt, preset: preset.id, presetName: preset.name,
        width: size.w, height: size.h, seconds, count, withAudio: audio,
        startImage: start?.token, endImage: end?.token, shotName: (prompt || preset.name).slice(0, 40),
      };
      if (model.id === 'h3') body.lengthFrames = secondsToFrames(seconds);
      if (model.id === 'h3' && turbo) body.h3Turbo = turbo;
      if (model.id === 'ltx25' && loras.length) body.loras = loras;
      if (castOn && castMode === 'frame') body.castMode = 'frame';
      if (mode === 'loop' && autoFix) body.seamFix = 'auto';
      const r = await api.generate(body);
      toast(`Queued ${r.takeIds.length} video${r.takeIds.length > 1 ? 's' : ''}`);
      setParams({ select: null, tab: null });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(false);
    }
  }

  const viewList = takes.filter((t) => t.status === 'done');
  const step = (dir: 1 | -1) => {
    const i = viewList.findIndex((t) => t.id === viewing);
    const n = viewList[(i + dir + viewList.length) % viewList.length];
    if (n) setViewing(n.id);
  };

  return (
    <div className="rail-layout">
      <aside className="rail">
        <Spill src={presetClip(preset.id)} video key={preset.id} />
        <div className="tabs">
          <button type="button" className={mode === 'create' ? 'on' : ''} onClick={() => setParams({ mode: null })}>Create video</button>
          <button type="button" className={mode === 'loop' ? 'on' : ''} onClick={() => setParams({ mode: 'loop' })}>Seamless loop</button>
        </div>

        <button type="button" className="preset-hero" onClick={() => setParams({ select: 'preset' })}>
          <Clip src={presetClip(preset.id)} key={preset.id} />
          <div className="txt">
            <div className="display">{preset.name}</div>
            <div className="label">Motion preset for {model.label}</div>
          </div>
          <span className="chip change"><Icon name="wand" size={13} />Change</span>
        </button>

        <div className="rail-section">
          <div className="label">{mode === 'loop' ? 'Loop frame' : 'Frames'}</div>
          {refs.length > 0 && (
            <div className="refs">
              {refs.map((r, i) => (
                <div className="ref" key={r.token + i}>
                  <img src={inputUrl(r.token)} alt="" />
                  <button type="button" className={`role ${r.role}`} onClick={() => cycleRole(i)} title="Click to change role">
                    {mode === 'loop' && r.role === 'start' ? 'start = end' : r.role}
                  </button>
                  <button type="button" className="x" onClick={() => setRefs((c) => c.filter((_, j) => j !== i))} aria-label="remove"><Icon name="x" size={12} /></button>
                </div>
              ))}
            </div>
          )}
          {refs.length < 6 && <Well onFiles={addFiles} compact={refs.length > 0} loop={mode === 'loop'} />}
        </div>

        <div className="rail-section">
          <div className="label">Prompt</div>
          <MentionBox className="prompt" rows={5} value={prompt} onChange={setPrompt}
            placeholder={mode === 'loop' ? 'What moves inside the loop. The first and last frame match exactly.' : 'Describe the shot: who, where, what happens. Type @ for your cast. The motion preset adds the camera.'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGo) void go(); }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="chip" style={{ background: 'transparent', padding: '4px 0' }}><Icon name="audio" size={14} /><span className="dim">Sound</span></span>
            <Switch on={audio} onChange={setAudio} label="sound" />
          </div>
          {mode === 'loop' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              title="Each loop is measured at its wrap either way. On, a visible seam gets extra tries (a trim, the wrap regenerated, a new seed) as new takes. They usually lower the seam and seldom close it.">
              <span className="chip" style={{ background: 'transparent', padding: '4px 0' }}><Icon name="loop" size={14} /><span className="dim">Auto-fix the seam</span></span>
              <Switch on={autoFix} onChange={setAutoFix} label="auto-fix the seam" />
            </div>
          )}
          {preset.text && (
            <details>
              <summary className="label" style={{ cursor: 'pointer' }}>Final prompt</summary>
              <div className="compiled" style={{ marginTop: 6 }}>{compiled || '...'}</div>
            </details>
          )}
        </div>

        {castOn && <CastShot members={castNamed} mode={castMode} onMode={setCastMode} size={size} />}

        <ModelRow value={model.id} onChange={(id) => setParams({ model: id === 'ltx25' ? null : id })} />
        {model.warn && <div className="label" style={{ color: 'var(--accent)', textTransform: 'none', letterSpacing: 0, fontSize: 11.5 }}>{model.warn}</div>}

        <div className="chip-row">
          <ChipMenu icon="clock" value={seconds} onChange={setSeconds} title="Duration"
            options={model.durations.map((d) => ({ value: d, label: `${d}s` }))} />
          <ChipMenu icon="aspect" value={aspect} onChange={setAspect} title="Aspect"
            options={[{ value: 'auto', label: 'Auto', note: start ? 'from frame' : '16:9' }, ...ASPECTS.map((a) => ({ value: a.id, label: a.id }))]} />
          <TierChip app="video" value={res} onChange={setRes} />
          <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
          {model.id === 'ltx25' && <LoraChips family="ltx" value={loras} onChange={setLoras} />}
          {model.id === 'h3' && turbos.length > 0 && (
            <ChipMenu icon="bolt" value={turbo} onChange={setTurbo} title="Turbo (step distill)"
              options={[{ value: '', label: 'Full · 20 steps', note: 'No distill: the slowest, the reference quality.' }, ...turbos.map((t) => ({ value: t.key, label: t.label, note: t.note }))]} />
          )}
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {needsStart && !start && <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{mode === 'loop' ? 'Add one image to loop.' : `${model.label} needs a start frame.`}</div>}
          <button type="button" className="generate" disabled={!canGo} onClick={() => void go()}>
            <span>{busy ? 'Queuing...' : 'Generate'}</span>
            <span className="cost">{shown.w}x{shown.h}{est ? ` · ${fmtSeconds(est * count)}` : ''}</span>
          </button>
        </div>
      </aside>

      <section className="canvas">
        <div className="canvas-head">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button type="button" className={tab === 'history' ? 'on' : ''} onClick={() => setParams({ select: null, tab: null })}>History</button>
            <button type="button" className={tab === 'presets' ? 'on' : ''} onClick={() => setParams({ select: 'preset' })}>Motion presets</button>
            <button type="button" className={tab === 'how' ? 'on' : ''} onClick={() => setParams({ select: null, tab: 'how' })}>How it works</button>
          </div>
          {tab === 'presets' && <button type="button" className="icon-btn" onClick={() => setParams({ select: null })} aria-label="close"><Icon name="x" /></button>}
        </div>
        <div className="canvas-body">
          {tab === 'presets' && <PresetPicker value={preset.id} onPick={(id) => setParams({ preset: id === 'free' ? null : id, select: null })} />}
          {tab === 'how' && <HowItWorks />}
          {tab === 'history' && (takes.length === 0 ? <HowItWorks /> : (
            <div className="grid">
              {takes.map((t) => (
                <MediaCard key={t.id} take={t} onOpen={() => setViewing(t.id)} actions={<>
                  <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                  <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                </>} />
              ))}
            </div>
          ))}
        </div>
      </section>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={step} />}
    </div>
  );
}

/**
 * How the cast gets into the shot: held on a reference sheet the whole clip
 * (Ingredients IC-LoRA), or composed into a hero frame the video starts from.
 */
function CastShot({ members, mode, onMode, size }: { members: CastMember[]; mode: 'sheet' | 'frame'; onMode: (m: 'sheet' | 'frame') => void; size: { w: number; h: number } }) {
  const sheet = useMemo(() => {
    const s = sheetSize(size.w, size.h);
    const sm = sheetMembers(members);
    const url = new Map(members.flatMap((m) => m.refs.map((r) => [r.token, r.url] as const)));
    return { ...sheetLayout(sm, s.width, s.height), url };
  }, [members, size.w, size.h]);
  return (
    <div className="rail-section">
      <div className="label">Cast in this shot</div>
      <div className="seg">
        <button type="button" className={mode === 'sheet' ? 'on' : ''} onClick={() => onMode('sheet')}>Reference sheet</button>
        <button type="button" className={mode === 'frame' ? 'on' : ''} onClick={() => onMode('frame')}>Hero frame</button>
      </div>
      {mode === 'sheet' ? (
        <>
          <div className="sheet-preview" style={{ aspectRatio: `${sheet.width} / ${sheet.height}` }} title="What LTX-2.5 holds on every frame">
            {sheet.tiles.map((t, i) => (
              <img key={i} src={sheet.url.get(t.image)} alt="" style={{ objectFit: t.fit, left: `${(t.x / sheet.width) * 100}%`, top: `${(t.y / sheet.height) * 100}%`, width: `${(t.w / sheet.width) * 100}%`, height: `${(t.h / sheet.height) * 100}%` }} />
            ))}
          </div>
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>The sheet steers every frame. Renders at {sheet.width}x{sheet.height}, 5 seconds or more.</div>
        </>
      ) : (
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>A still of your cast in this scene is composed first, then the video starts from it.</div>
      )}
    </div>
  );
}

function ModelRow({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const m = VIDEO_MODELS.find((x) => x.id === value)!;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="rail-row" onClick={() => setOpen(!open)}>
        <span className="label">Model</span>
        <span className="val">{m.label}<Icon name={open ? 'down' : 'chev'} size={14} /></span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          {VIDEO_MODELS.map((x) => (
            <button key={x.id} type="button" className={`pop-item ${x.id === value ? 'on' : ''}`} style={{ background: 'var(--panel-2)', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
              onClick={() => { onChange(x.id); setOpen(false); }}>
              <span style={{ fontWeight: 600 }}>{x.label} <small className="dim">· {x.vendor}</small></span>
              <small>{x.note}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Well({ onFiles, compact, loop }: { onFiles: (f: FileList | File[]) => void; compact?: boolean; loop?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const zone = useDropZone(onFiles);
  return (
    <div className={`well ${zone.over ? 'drag' : ''}`} style={compact ? { padding: 10 } : undefined}
      onClick={() => input.current?.click()} {...zone.props}>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && onFiles(e.target.files)} />
      {!compact && <div className="well-icons"><span><Icon name="image" /></span></div>}
      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{compact ? '+ Add frame' : loop ? 'Add the image to loop' : 'Add start or end frame'}</div>
      {!compact && <div style={{ fontSize: 12, marginTop: 2 }}>{loop ? 'It becomes the first and last frame' : 'Optional. Drop images, or skip for text to video'}</div>}
    </div>
  );
}

export function PresetPicker({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const list = PRESETS.filter((p) => (cat === 'all' || p.cat === cat) && (!q || p.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="picker">
      <div className="picker-top">
        {PRESET_CATS.map((c) => (
          <button key={c.id} type="button" className={`pill ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{c.label}</button>
        ))}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <input className="field" style={{ width: 200, padding: '7px 10px 7px 30px' }} placeholder="Search presets" value={q} onChange={(e) => setQ(e.target.value)} />
          <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--mute)' }}><Icon name="search" size={14} /></span>
        </div>
      </div>
      <div className="picker-grid">
        {list.map((p) => (
          <button key={p.id} type="button" className={`preset-card ${p.id === value ? 'on' : ''}`} onClick={() => onPick(p.id)} title={p.text || 'No camera direction'}>
            <PresetArt id={p.id} hue={p.hue} />
            <span className="cat badge">{PRESET_CATS.find((c) => c.id === p.cat)?.label}</span>
            <span className="name">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A rendered preview loop if one exists in /presets, else generated art. */
function PresetArt({ id, hue }: { id: string; hue: number }) {
  const [hasVideo, setHasVideo] = useState(true);
  return (
    <>
      <div className="art gen" style={{ ['--g' as any]: artFor(hue) }} />
      {hasVideo && (
        <video className="art" src={`/presets/${id}.mp4`} muted loop autoPlay playsInline preload="metadata"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setHasVideo(false)} />
      )}
    </>
  );
}

function HowItWorks() {
  return (
    <div className="hero-empty">
      <div className="label" style={{ marginBottom: 14 }}>Runs on your GPU · open weights</div>
      <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>Direct a shot <span className="hl">in three moves</span></div>
      <div className="steps3">
        <div><span className="label">01</span><b>Add a frame</b><span className="dim">Drop a still, or skip it and go text to video.</span></div>
        <div><span className="label">02</span><b>Pick the motion</b><span className="dim">Camera moves and effects, as presets.</span></div>
        <div><span className="label">03</span><b>Generate</b><span className="dim">LTX-2.5 renders it locally, no credits.</span></div>
      </div>
    </div>
  );
}

export { animate };
