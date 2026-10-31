/**
 * Director: structured shot direction. Genre, camera, framing, light, film,
 * look and grade are prompt compilers, the era is a scrubber that names the
 * decade and grades the output, and the compiled prompt is always visible.
 * Frame makes hero stills, Shot films one, Scene plans a shot list with a
 * local LLM and shoots it into one cut.
 */
import { useEffect, useRef, useState } from 'react';
import { api, inputUrl, mediaUrl, posterUrl, takeAsInput, uploadFile, type Take } from '../api';
import { usePageDrop } from '../drop';
import {
  ASPECTS, DIRECTOR_AXES as AXES, DIRECTOR_MOVES as CAMERA_MOVES, ERA_DECADES, ERA_MAX, ERA_MIN, IMAGE_MODELS, SCENE_FRAMINGS, SCENE_MAX_SHOTS,
  SCENE_MIN_SHOTS, SHOT_SECONDS, SPEED_RAMPS, compilePrompt, directorDirection, eraDecade, eraGrade, pickGenre, presetById, rampSeconds,
  shotPrompt, sizeFor, videoFrame, type AspectId, type RampId, type SceneShot,
} from '../catalog';
import { setParams, useRoute } from '../router';
import { isActive, isImage, settingsOf, toast, useStore, inFeed } from '../store';
import { ChipMenu, Icon, MediaCard, useClickAway, Stepper, Switch, fmtSeconds, useEstimate, Spill, presetClip, TierChip, useTierChoice } from '../ui';
import Viewer, { recreate, remove } from '../Viewer';
import { MentionBox } from '../Mention';
import { useCast } from '../castStore';

type Picks = Record<string, string>;
type Mode = 'image' | 'video' | 'scene';

/** A shot in the strip. `cut` is the cut whose takes it carries; editing a shot drops them. */
interface StripShot extends SceneShot { key: string; hero?: number; cut?: number }

const newKey = () => Math.random().toString(36).slice(2, 9);

export default function DirectorPage() {
  const { params } = useRoute();
  const mode: Mode = params.get('mode') === 'video' ? 'video' : params.get('mode') === 'scene' ? 'scene' : 'image';
  const [scene, setScene] = useState('');
  const [picks, setPicks] = useState<Picks>({});
  const [era, setEra] = useState<number | null>(null);
  const [grade, setGrade] = useState(true);
  const [ramp, setRamp] = useState<RampId>('linear');
  const [open, setOpen] = useState<string | null>(null);
  const [aspect, setAspect] = useState<AspectId>('16:9');
  const [count, setCount] = useState(mode === 'image' ? 2 : 1);
  const [imageModel, setImageModel] = useState<'qwen' | 'flux2'>('qwen');
  const [move, setMove] = useState('push-in');
  const [seconds, setSeconds] = useState(5);
  const [audio, setAudio] = useState(false);
  const [hero, setHero] = useState<{ token: string; take: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  // Scene mode
  const [shots, setShots] = useState<StripShot[]>([]);
  const [want, setWant] = useState(0);
  const [res, setRes] = useTierChoice(mode === 'scene' ? 'scene' : 'director');
  const [heroFrames, setHeroFrames] = useState(false);
  const [planning, setPlanning] = useState<string | null>(null);
  const [planNote, setPlanNote] = useState('');
  const [cutId, setCutId] = useState<number | null>(null);

  const direction = directorDirection(picks, era);
  const moveText = mode === 'video' ? presetById(move).text : '';
  const compiled = compilePrompt([moveText, scene, direction.join(', ')]);
  const size = mode === 'image' ? sizeFor(aspect, 1.0) : videoFrame(aspect, res);
  const toShoot = shots.filter((s) => !s.take || s.cut == null);
  const shotSecs = toShoot.length ? Math.round(toShoot.reduce((n, s) => n + s.seconds, 0) / toShoot.length) : seconds;
  const est = useEstimate(mode === 'image'
    ? { kind: 'still', model: imageModel, quality: 'quality', w: size.w, h: size.h }
    : { kind: 'video', model: 'ltx25', w: size.w, h: size.h, seconds: mode === 'scene' ? shotSecs : seconds });
  const takes = useStore((s) => s.takes.filter((t) => {
    const st = settingsOf(t);
    return inFeed(t) && st.app === 'director' && !st.sceneOf && (mode === 'scene' ? !!st.cut : !st.cut);
  }));
  const allTakes = useStore((s) => s.takes);
  const cut = cutId ? allTakes.find((t) => t.id === cutId) : undefined;

  // The current cut fills in its shots' takes as the server queues them.
  useEffect(() => {
    if (!cut) return;
    const stored = (settingsOf(cut).shots ?? []) as (SceneShot & { key?: string; hero?: number })[];
    setShots((prev) => prev.map((p) => {
      if (p.cut !== cut.id) return p;
      const m = stored.find((x) => x.key === p.key);
      return m && (m.take !== p.take || m.hero !== p.hero) ? { ...p, take: m.take, hero: m.hero } : p;
    }));
  }, [cut?.settings, cut?.id]);

  function choose(axis: string, id: string) {
    setPicks(axis === 'genre' ? pickGenre(picks, id) : { ...picks, [axis]: id });
    setOpen(null);
  }

  async function shootFrom(t: Take) {
    const token = await takeAsInput(t.id);
    setHero({ token, take: t.id });
    const s = settingsOf(t);
    if (s.scene) setScene(s.scene);
    if (s.picks) setPicks(s.picks);
    if (s.era != null) setEra(s.era);
    // The frame already carries the era grade; grading the shot again would double it.
    if (s.eraGraded) setGrade(false);
    setParams({ mode: 'video' });
    setCount(1);
  }

  usePageDrop('Drop an image to shoot from it', async (files) => {
    const f = files.find((x) => x.type.startsWith('image/'));
    if (!f) { toast('Director shoots from a still. Drop an image.', true); return; }
    try {
      setHero({ token: await uploadFile(f), take: 0 });
      setParams({ mode: 'video' });
    } catch (e) { toast(e instanceof Error ? e.message : 'upload failed', true); }
  });

  async function go() {
    setBusy(true);
    try {
      const common = { app: 'director', scene, picks, era, eraGrade: grade, userPrompt: scene || compiled, prompt: compiled, width: size.w, height: size.h, count, shotName: (scene || 'director').slice(0, 40) };
      const r = mode === 'image'
        ? await api.generate({ ...common, kind: 'still', model: imageModel, quality: 'quality' })
        : await api.generate({ ...common, kind: 'video', videoModel: 'ltx25', seconds, withAudio: audio, startImage: hero?.token, preset: move, presetName: presetById(move).name, ramp });
      toast(`Queued ${r.takeIds.length} ${mode === 'image' ? 'frame' : 'shot'}${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- scene mode ----------

  const planTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(planTimer.current), []);

  async function plan() {
    if (!scene.trim()) { toast('Write the scene first', true); return; }
    try {
      const p = await api.directorPlan({ scene, shots: want || undefined });
      setPlanning(p.id);
      setPlanNote('');
      const poll = async () => {
        try {
          const q = await api.directorPlanStatus(p.id);
          if (q.status === 'running') { planTimer.current = window.setTimeout(() => void poll(), 1500); return; }
          setPlanning(null);
          if (q.status === 'failed' || !q.shots) { toast(q.error ?? 'Planning failed', true); return; }
          setShots(q.shots.map((s) => ({ ...s, key: newKey() })));
          setCutId(null);
          const by = q.planner === 'engine' ? 'Gemma 3 on the engine' : q.planner === 'llm' ? 'the OpenAI-compatible LLM' : q.planner === 'ollama' ? 'Ollama' : 'a sentence split (no LLM answered)';
          setPlanNote(`${q.shots.length} shots, planned by ${by}${q.seconds ? ` in ${Math.round(q.seconds)}s` : ''}.`);
        } catch (e) {
          setPlanning(null);
          toast(e instanceof Error ? e.message : 'Planning failed', true);
        }
      };
      void poll();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Planning failed', true);
    }
  }

  /** Shoot every shot that has no take yet (all of them the first time), then cut. */
  async function shootAll(list = shots) {
    if (list.length < 1) { toast('Plan or add a shot first', true); return; }
    setBusy(true);
    try {
      const r = await api.directorScene({
        scene, picks, era, eraGrade: grade, ramp, withAudio: audio, heroFrames, imageModel,
        width: size.w, height: size.h,
        shots: list.map((s) => ({ key: s.key, framing: s.framing, move: s.move, action: s.action, seconds: s.seconds, ramp: s.ramp, cast: s.cast, take: s.cut != null ? s.take : undefined })),
      });
      setCutId(r.cutId);
      setShots(list.map((s) => ({ ...s, cut: r.cutId, ...(s.cut != null && s.take ? {} : { take: undefined, hero: undefined }) })));
      const fresh = list.filter((s) => s.cut == null || !s.take).length;
      toast(fresh ? `Shooting ${fresh} shot${fresh > 1 ? 's' : ''}, then cutting` : 'Cutting the shots');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(false);
    }
  }

  const edit = (i: number, patch: Partial<StripShot>) =>
    setShots(shots.map((s, k) => (k === i ? { ...s, ...patch, take: undefined, hero: undefined, cut: undefined } : s)));
  const moveShot = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= shots.length) return;
    const next = [...shots];
    [next[i], next[j]] = [next[j], next[i]];
    setShots(next);
  };
  const reroll = (i: number) => void shootAll(shots.map((s, k) => (k === i ? { ...s, take: undefined, hero: undefined, cut: undefined } : s)));
  const addShot = () => setShots([...shots, { key: newKey(), framing: 'medium', move: 'static', action: '', seconds: 3 }]);

  const done = takes.filter((t) => t.status === 'done');
  const step = (dir: 1 | -1) => {
    const i = done.findIndex((t) => t.id === viewing);
    const n = done[(i + dir + done.length) % done.length];
    if (n) setViewing(n.id);
  };

  const axes = mode === 'scene' ? AXES.filter((a) => a.id !== 'framing') : AXES;
  const canGo = mode === 'scene' ? shots.length > 0 && shots.every((s) => s.action.trim()) : !!compiled;
  const sceneEst = est ? est * toShoot.length * (heroFrames ? 1.25 : 1) : null;

  return (
    <div className="rail-layout" style={{ gridTemplateColumns: '380px 1fr' }}>
      <aside className="rail">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="display" style={{ fontSize: 26 }}>Director</div>
          <div className="seg" style={{ width: 216 }}>
            <button type="button" className={mode === 'image' ? 'on' : ''} onClick={() => setParams({ mode: null })}>Frame</button>
            <button type="button" className={mode === 'video' ? 'on' : ''} onClick={() => setParams({ mode: 'video' })}>Shot</button>
            <button type="button" className={mode === 'scene' ? 'on' : ''} onClick={() => setParams({ mode: 'scene' })}>Scene</button>
          </div>
        </div>

        {mode === 'video' && (
          <div className="rail-section">
            <div className="label">Hero frame</div>
            {hero ? (
              <div className="ref" style={{ aspectRatio: '16/9' }}>
                <img src={inputUrl(hero.token)} alt="" />
                <span className="role start">start</span>
                <button type="button" className="x" onClick={() => setHero(null)} aria-label="remove"><Icon name="x" size={12} /></button>
              </div>
            ) : <div className="well" style={{ cursor: 'default', padding: 12 }} onClick={() => setParams({ mode: null })}>Make a frame first, then press <b>Shoot it</b> on it. Or shoot straight from text.</div>}
          </div>
        )}

        <div className="rail-section">
          <div className="label">Scene</div>
          <MentionBox className="prompt" rows={mode === 'scene' ? 5 : 4} value={scene} onChange={setScene}
            placeholder={mode === 'scene'
              ? 'The whole scene, beat by beat. Example: @Keeper climbs the stairs with a lantern as the storm hits. At the top he sees a ship breaking on the rocks. Type @ for your cast.'
              : 'Who, where, what is happening. Example: a lighthouse keeper climbs the stairs with a lantern as the storm hits. Type @ for your cast.'} />
        </div>

        <div className="rail-section">
          <div className="label">Direction</div>
          {mode === 'video' && (
            <DirectionRow icon="orbit" label="Camera move" value={presetById(move).name} open={open === 'move'} onToggle={() => setOpen(open === 'move' ? null : 'move')}>
              {CAMERA_MOVES.map((p) => (
                <button key={p.id} type="button" className={`chip ${p.id === move ? 'on' : ''}`} onClick={() => { setMove(p.id); setOpen(null); }}>{p.name}</button>
              ))}
            </DirectionRow>
          )}
          {axes.map((a) => {
            const cur = a.options.find((o) => o.id === (picks[a.id] ?? 'auto')) ?? a.options[0];
            return (
              <DirectionRow key={a.id} icon={a.icon} label={a.label} value={cur.label} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)}>
                {a.options.map((o) => (
                  <button key={o.id} type="button" className={`chip ${o.id === cur.id ? 'on' : ''}`} onClick={() => choose(a.id, o.id)}>{o.label}</button>
                ))}
              </DirectionRow>
            );
          })}
          <EraScrubber era={era} onEra={setEra} grade={grade} onGrade={setGrade} />
          {mode !== 'image' && (
            <DirectionRow icon="bolt" label="Speed" value={SPEED_RAMPS.find((r) => r.id === ramp)!.label} open={open === 'ramp'} onToggle={() => setOpen(open === 'ramp' ? null : 'ramp')}>
              {SPEED_RAMPS.map((r) => (
                <button key={r.id} type="button" title={r.note} className={`chip ${r.id === ramp ? 'on' : ''}`} onClick={() => { setRamp(r.id); setOpen(null); }}>{r.label}</button>
              ))}
            </DirectionRow>
          )}
          {mode !== 'image' && ramp !== 'linear' && (
            <div className="dim" style={{ fontSize: 12, padding: '0 4px' }}>{SPEED_RAMPS.find((r) => r.id === ramp)!.note}. Retimed after the render with in-between frames; {mode === 'video' ? `a ${seconds}s shot runs ${rampSeconds(ramp, seconds)}s` : 'each shot runs longer where it slows'}, without sound.</div>
          )}
        </div>

        {mode !== 'scene' && (
          <details open>
            <summary className="label" style={{ cursor: 'pointer' }}>Compiled shot</summary>
            <div className="compiled" style={{ marginTop: 6 }}>{compiled || 'Pick a direction or write the scene.'}</div>
          </details>
        )}

        {mode === 'scene' ? (
          <>
            <div className="chip-row">
              <ChipMenu icon="grid" value={want} onChange={setWant} title="Shots to plan" options={[{ value: 0, label: 'Auto shots' }, ...Array.from({ length: SCENE_MAX_SHOTS - SCENE_MIN_SHOTS + 1 }, (_, i) => ({ value: i + SCENE_MIN_SHOTS, label: `${i + SCENE_MIN_SHOTS} shots` }))]} />
              <ChipMenu icon="aspect" value={aspect} onChange={setAspect} title="Aspect" options={ASPECTS.map((a) => ({ value: a.id, label: a.id }))} />
              <TierChip app="scene" value={res} onChange={setRes} />
              <span className="chip" style={{ gap: 10 }} title="Make a Qwen-Image hero frame per shot first, then shoot from it"><Icon name="image" size={14} />Hero frames <Switch on={heroFrames} onChange={setHeroFrames} label="hero frames" /></span>
              <span className="chip" style={{ gap: 10 }}><Icon name="audio" size={14} />Sound <Switch on={audio} onChange={setAudio} label="sound" /></span>
            </div>
            <button type="button" className="btn" disabled={!!planning || !scene.trim()} onClick={() => void plan()}>
              <Icon name="sparkle" size={14} />{planning ? 'Planning the shots...' : shots.length ? 'Plan again' : 'Plan shots'}
            </button>
            <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={busy || !canGo} onClick={() => void shootAll()}>
              <span>{busy ? 'Queuing...' : toShoot.length === shots.length ? 'Shoot all' : toShoot.length ? `Shoot ${toShoot.length} and cut` : 'Cut again'}</span>
              <span className="cost">{size.w}x{size.h}{sceneEst ? ` · ${fmtSeconds(sceneEst)}` : ''}</span>
            </button>
          </>
        ) : (
          <>
            <div className="chip-row">
              {mode === 'image'
                ? <ChipMenu icon="sparkle" value={imageModel} onChange={setImageModel} title="Model" options={IMAGE_MODELS.map((m) => ({ value: m.id, label: m.label }))} />
                : <ChipMenu icon="clock" value={seconds} onChange={setSeconds} title="Duration" options={[3, 5, 8, 10].map((d) => ({ value: d, label: `${d}s` }))} />}
              <ChipMenu icon="aspect" value={aspect} onChange={setAspect} title="Aspect" options={ASPECTS.map((a) => ({ value: a.id, label: a.id }))} />
              {mode === 'video' && <TierChip app="director" value={res} onChange={setRes} />}
              <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
              {mode === 'video' && <span className="chip" style={{ gap: 10 }}><Icon name="audio" size={14} />Sound <Switch on={audio && ramp === 'linear'} onChange={setAudio} label="sound" /></span>}
            </div>
            <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={busy || !canGo} onClick={() => void go()}>
              <span>{busy ? 'Queuing...' : mode === 'image' ? 'Make frames' : 'Shoot'}</span>
              <span className="cost">{size.w}x{size.h}{est ? ` · ${fmtSeconds(est * count)}` : ''}</span>
            </button>
          </>
        )}
      </aside>

      <section className="canvas">
        <div className="canvas-head"><div className="tabs" style={{ borderBottom: 0 }}><button type="button" className="on">{mode === 'scene' ? 'Scene' : 'Shots'}</button></div></div>
        <div className="canvas-body">
          {mode === 'scene' && (
            <ShotStrip shots={shots} takes={allTakes} planNote={planNote} planning={!!planning} direction={directorDirection({ ...picks, framing: 'auto' }, era)}
              onEdit={edit} onMove={moveShot} onReroll={reroll} onRemove={(i) => setShots(shots.filter((_, k) => k !== i))} onAdd={addShot} onOpen={setViewing} busy={busy} />
          )}
          {takes.length === 0 ? (
            mode === 'scene' ? (shots.length === 0 && !planning && (
              <div className="hero-empty">
                <div className="explore-glow" style={{ top: -140, left: -20, right: -20 }}><Spill src={presetClip('crane-up')} video /></div>
                <div className="label" style={{ marginBottom: 14, position: 'relative' }}>One scene, a shot list, one cut</div>
                <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>Cover the scene <span className="hl">in shots</span></div>
                <div className="steps3">
                  <div><span className="label">01</span><b>Write the scene</b><span className="dim">Set genre, era and speed, or leave them on Auto.</span></div>
                  <div><span className="label">02</span><b>Plan shots</b><span className="dim">A local model splits it into framings, moves and actions. Edit any of it.</span></div>
                  <div><span className="label">03</span><b>Shoot all</b><span className="dim">Each shot renders on its own, then they cut together.</span></div>
                </div>
              </div>
            )) : (
              <div className="hero-empty">
                <div className="explore-glow" style={{ top: -140, left: -20, right: -20 }}><Spill src={presetClip('dolly-zoom')} video /></div>
                <div className="label" style={{ marginBottom: 14, position: 'relative' }}>Frame first, then shoot</div>
                <div className="display" style={{ fontSize: 'clamp(34px,4.6vw,60px)' }}>Direct it <span className="hl">like a set</span></div>
                <div className="steps3">
                  <div><span className="label">01</span><b>Write the scene</b><span className="dim">Then set genre, camera, light, film, era and grade, or leave them on Auto.</span></div>
                  <div><span className="label">02</span><b>Make frames</b><span className="dim">Pick the hero frame from a few stills.</span></div>
                  <div><span className="label">03</span><b>Shoot it</b><span className="dim">Add a camera move and a speed ramp, and render the shot.</span></div>
                </div>
              </div>
            )
          ) : (
            <>
              {mode === 'scene' && <div className="label" style={{ margin: '22px 0 10px' }}>Cuts</div>}
              <div className="grid">
                {takes.map((t) => (
                  <MediaCard key={t.id} take={t} onOpen={() => setViewing(t.id)} pendingLabel={settingsOf(t).cut ? cutLabel(t, allTakes) : undefined} actions={<>
                    {isImage(t) && t.status === 'done' && <button type="button" className="icon-btn" title="Shoot it" onClick={() => void shootFrom(t).catch((e) => toast(String(e), true))}><Icon name="video" size={14} /></button>}
                    <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                    <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
                  </>} />
                ))}
              </div>
            </>
          )}
        </div>
      </section>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={step} />}
    </div>
  );
}

/** What a waiting cut is doing: how many of its shots are in. */
function cutLabel(cut: Take, all: Take[]): string {
  if (cut.prompt_id) return 'Cutting';
  const shots = (settingsOf(cut).shots ?? []) as { take?: number }[];
  const done = shots.filter((s) => s.take && all.find((t) => t.id === s.take)?.status === 'done').length;
  return `Shooting ${done}/${shots.length}`;
}

function DirectionRow(p: { icon: string; label: string; value: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button type="button" className="rail-row" onClick={p.onToggle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ico" style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--panel-3)', color: p.value === 'Auto' || p.value === 'Linear' ? 'var(--dim)' : 'var(--accent)' }}><Icon name={p.icon} size={14} /></span>
          <span className="label" style={{ color: 'var(--dim)' }}>{p.label}</span>
        </span>
        <span className="val">{p.value}<Icon name={p.open ? 'down' : 'chev'} size={13} /></span>
      </button>
      {p.open && <div className="chip-row" style={{ padding: '8px 2px 4px' }}>{p.children}</div>}
    </div>
  );
}

/** A CSS swatch of the era grade: its shadows on the left, its highlights on the right. */
function gradeSwatch(year: number): string {
  const g = eraGrade(year);
  const tone = (v: number, k: number) => Math.round(Math.max(0, Math.min(1, v)) * 255 * k);
  const dark = g.lift.map((l) => tone(0.12 + g.fade + l * 2.2, 1));
  const mid = [0.62, 0.42, 0.3].map((c, i) => tone(0.5 + (c - 0.5) * g.sat, (1 + g.lift[i]) * g.gain[i]));
  const light = g.gain.map((x) => tone(0.86 * x - g.fade * 0.3, 1));
  return `linear-gradient(90deg, rgb(${dark}) 0%, rgb(${mid}) 52%, rgb(${light}) 100%)`;
}

function EraScrubber(p: { era: number | null; onEra: (v: number | null) => void; grade: boolean; onGrade: (v: boolean) => void }) {
  const on = p.era != null;
  const year = p.era ?? 1985;
  return (
    <div className="era">
      <div className="era-head">
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ico" style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--panel-3)', color: on ? 'var(--accent)' : 'var(--dim)' }}><Icon name="clock" size={14} /></span>
          <span className="label" style={{ color: 'var(--dim)' }}>Era</span>
        </span>
        <span className="val">{on ? <>{year} <span className="dim">· {eraDecade(year).label}</span></> : 'Auto'}<Switch on={on} onChange={(v) => p.onEra(v ? year : null)} label="era" /></span>
      </div>
      {on && (
        <>
          <input type="range" min={ERA_MIN} max={ERA_MAX} step={1} value={year} onChange={(e) => p.onEra(Number(e.target.value))} aria-label="era year" />
          <div className="era-ticks">{ERA_DECADES.map((d) => <button key={d.year} type="button" className={eraDecade(year).year === d.year ? 'on' : ''} onClick={() => p.onEra(d.year)}>{`${String(d.year).slice(2)}s`}</button>)}</div>
          <div className="era-grade">
            <span className="era-swatch" style={{ background: gradeSwatch(year), opacity: p.grade ? 1 : 0.35 }} />
            <span className="dim">Grade the output</span>
            <Switch on={p.grade} onChange={p.onGrade} label="grade the output" />
          </div>
        </>
      )}
    </div>
  );
}

function ShotStrip(p: {
  shots: StripShot[]; takes: Take[]; planNote: string; planning: boolean; direction: string[]; busy: boolean;
  onEdit: (i: number, patch: Partial<StripShot>) => void; onMove: (i: number, d: -1 | 1) => void; onReroll: (i: number) => void;
  onRemove: (i: number) => void; onAdd: () => void; onOpen: (id: number) => void;
}) {
  if (!p.shots.length && !p.planning) return null;
  const total = p.shots.reduce((n, s) => n + s.seconds, 0);
  return (
    <div className="strip-wrap">
      <div className="strip-head">
        <span className="label">Shot list{p.shots.length ? ` · ${p.shots.length} shots · ${total}s before ramps` : ''}</span>
        <span className="dim" style={{ fontSize: 12 }}>{p.planning ? 'Planning on the local model...' : p.planNote}</span>
      </div>
      <div className="strip">
        {p.planning && !p.shots.length && [0, 1, 2].map((i) => <div key={i} className="shot ghost"><div className="shot-media" /></div>)}
        {p.shots.map((s, i) => (
          <ShotCard key={s.key} i={i} n={p.shots.length} shot={s} takes={p.takes} prompt={shotPrompt(s, p.direction)} busy={p.busy}
            onEdit={(patch) => p.onEdit(i, patch)} onMove={(d) => p.onMove(i, d)} onReroll={() => p.onReroll(i)} onRemove={() => p.onRemove(i)} onOpen={p.onOpen} />
        ))}
        {p.shots.length < SCENE_MAX_SHOTS && !p.planning && (
          <button type="button" className="shot add" onClick={p.onAdd}><Icon name="plus" size={18} /><span>Add shot</span></button>
        )}
      </div>
    </div>
  );
}

function ShotCard(p: {
  i: number; n: number; shot: StripShot; takes: Take[]; prompt: string; busy: boolean;
  onEdit: (patch: Partial<StripShot>) => void; onMove: (d: -1 | 1) => void; onReroll: () => void; onRemove: () => void; onOpen: (id: number) => void;
}) {
  const { shot: s } = p;
  const take = s.take ? p.takes.find((t) => t.id === s.take) : undefined;
  const hero = s.hero ? p.takes.find((t) => t.id === s.hero) : undefined;
  const progress = useStore((st) => {
    const live = take && isActive(take) ? take : hero && isActive(hero) ? hero : undefined;
    return live?.prompt_id ? st.progress[live.prompt_id] : undefined;
  });
  const pct = progress ? Math.round((progress.value / Math.max(1, progress.max)) * 100) : 0;
  const vref = useRef<HTMLVideoElement>(null);
  const state = take?.status === 'done' ? 'done'
    : take && isActive(take) ? (take.status === 'rendering' ? 'Shooting' : 'Queued')
    : hero && isActive(hero) ? (hero.status === 'rendering' ? 'Making the frame' : 'Frame queued')
    : take ? take.status : hero?.status === 'done' ? 'Frame ready' : hero ? hero.status : null;
  const outSecs = take ? settingsOf(take).outSeconds : undefined;
  const framing = SCENE_FRAMINGS.find((f) => f.id === s.framing);
  return (
    <div className="shot">
      <div className="shot-media"
        onClick={() => take?.status === 'done' && p.onOpen(take.id)}
        onMouseEnter={() => { const v = vref.current; if (v) { v.muted = true; void v.play().catch(() => {}); } }}
        onMouseLeave={() => { const v = vref.current; if (v) { v.pause(); v.currentTime = 0; } }}>
        {take?.status === 'done' ? (
          <>
            <img src={posterUrl(take.id)} alt="" />
            <video ref={vref} src={mediaUrl(take.id)} muted loop playsInline preload="none" />
          </>
        ) : hero?.status === 'done' ? <img src={posterUrl(hero.id)} alt="" style={{ opacity: 0.6 }} /> : null}
        <span className="shot-no">{p.i + 1}</span>
        {state && state !== 'done' && <span className={`shot-state ${state === 'failed' || state === 'stopped' ? 'bad' : ''}`}>{state}</span>}
        {(take && isActive(take)) || (hero && isActive(hero)) ? <div className="progress"><i style={{ width: `${pct}%` }} /></div> : null}
        {take?.status === 'done' && <span className="badge cool shot-len">{outSecs ?? s.seconds}s</span>}
      </div>
      <div className="shot-body">
        <div className="chip-row">
          <ChipMenu icon="aspect" value={s.framing} onChange={(v) => p.onEdit({ framing: v })} title="Framing" dir="down" options={SCENE_FRAMINGS.map((f) => ({ value: f.id, label: f.label }))} />
          <ChipMenu icon="orbit" value={s.move} onChange={(v) => p.onEdit({ move: v })} title="Camera move" dir="down" options={CAMERA_MOVES.map((m) => ({ value: m.id, label: m.name }))} />
          <ChipMenu icon="clock" value={s.seconds} onChange={(v) => p.onEdit({ seconds: v })} title="Length" dir="down" options={Array.from({ length: SHOT_SECONDS.max - SHOT_SECONDS.min + 1 }, (_, k) => ({ value: k + SHOT_SECONDS.min, label: `${k + SHOT_SECONDS.min}s` }))} />
          <ChipMenu icon="bolt" value={s.ramp ?? ''} onChange={(v) => p.onEdit({ ramp: (v || undefined) as RampId | undefined })} title="Speed for this shot" dir="down" options={[{ value: '', label: 'Scene speed' }, ...SPEED_RAMPS.map((r) => ({ value: r.id, label: r.label }))]} />
        </div>
        <MentionBox className="prompt" rows={3} chips={false} value={s.action} placeholder={`What happens in this ${framing?.label.toLowerCase() ?? 'shot'}`} onChange={(v) => p.onEdit({ action: v })} />
        <ShotCast ids={s.cast ?? []} onChange={(cast) => p.onEdit({ cast: cast.length ? cast : undefined })} />
        <details>
          <summary className="label" style={{ cursor: 'pointer' }}>Shot prompt</summary>
          <div className="compiled" style={{ marginTop: 6, fontSize: 11 }}>{p.prompt}</div>
        </details>
        <div className="shot-foot">
          <button type="button" className="icon-btn" title="Earlier" disabled={p.i === 0} onClick={() => p.onMove(-1)}><span style={{ display: 'grid', transform: 'rotate(180deg)' }}><Icon name="chev" size={13} /></span></button>
          <button type="button" className="icon-btn" title="Later" disabled={p.i === p.n - 1} onClick={() => p.onMove(1)}><Icon name="chev" size={13} /></button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn sm" title="Shoot this one again and re-cut" disabled={p.busy || !s.action.trim()} onClick={p.onReroll}><Icon name="redo" size={13} />Re-roll</button>
          <button type="button" className="icon-btn" title="Remove the shot" onClick={p.onRemove}><Icon name="trash" size={13} /></button>
        </div>
      </div>
    </div>
  );
}

/**
 * The cast members a shot holds. The server starts such a shot from a Cast
 * hero frame of them (castHeroSeam in server/scene.ts), then shoots it with LTX.
 */
function ShotCast(p: { ids: number[]; onChange: (ids: number[]) => void }) {
  const cast = useCast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false), open);
  const on = cast.filter((m) => p.ids.includes(m.id));
  const toggle = (id: number) => p.onChange(p.ids.includes(id) ? p.ids.filter((x) => x !== id) : [...p.ids, id].slice(0, 8));
  if (!cast.length && !on.length) return null;
  return (
    <div className="cast-chips shot-cast">
      {on.map((m) => (
        <button key={m.id} type="button" className="cast-chip" title={`Remove ${m.name} from this shot`} onClick={() => toggle(m.id)}>
          {m.refs[0] ? <img src={m.refs[0].url} alt="" /> : <Icon name="person" size={12} />}
          {m.name}
          <span aria-hidden className="shot-cast-x"><Icon name="x" size={10} /></span>
        </button>
      ))}
      <div className="pop-wrap" ref={ref}>
        <button type="button" className="chip" title="Who is in this shot" onClick={() => setOpen(!open)}>
          <Icon name="person" size={13} /><span>{on.length ? 'Cast' : 'Add cast'}</span>
        </button>
        {open && (
          <div className="popover down mention-pop">
            <div className="pop-title label">In this shot</div>
            {cast.map((m) => {
              const sel = p.ids.includes(m.id);
              return (
                <button key={m.id} type="button" role="menuitemcheckbox" aria-checked={sel}
                  className={`pop-item mention-item ${sel ? 'on' : ''}`} onClick={() => toggle(m.id)}>
                  <span className="mention-face">{m.refs[0] ? <img src={m.refs[0].url} alt="" /> : null}</span>
                  <span className="mention-name">{m.name}</span>
                  <small className="dim">{sel ? 'In shot' : m.refs.length ? m.kind : 'no pictures'}</small>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
