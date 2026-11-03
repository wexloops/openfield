/** Setup: which model bundles are on disk, and how to get the rest. */
import { useEffect, useState } from 'react';
import { api, type BundleStatus } from '../api';
import { useStore } from '../store';
import { RenderTierPicker } from '../ui';

export default function Setup() {
  const [bundles, setBundles] = useState<BundleStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const st = useStore((s) => s.status);
  const load = async (refresh = false) => {
    setBusy(true);
    try { setBundles((await api.preflight(refresh)).bundles); } catch { setBundles([]); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  return (
    <div className="page-scroll">
      <div className="page-pad" style={{ maxWidth: 980 }}>
        <h1 className="display" style={{ fontSize: 44, margin: 0 }}>Setup</h1>
        <p className="dim">OpenField runs your local ComfyUI through the Comfy SDK. Weights live in ComfyUI. Anything marked missing is switched off until its files exist.</p>
        <div className="tile" style={{ margin: '18px 0' }}>
          <dl className="kv" style={{ width: '100%' }}>
            <dt>Engine</dt><dd>{st?.target === 'cloud' ? 'Comfy Cloud' : `Local ComfyUI ${st?.version ? `v${st.version}` : ''}`}</dd>
            <dt>Comfy API v2</dt><dd>{st?.api ? 'answering' : 'not answering'}</dd>
            <dt>GPU</dt><dd>{st?.gpu ?? 'unknown'}{st?.vramTotalGb ? ` · ${(st.vramTotalGb * 1e9 / 2 ** 30).toFixed(0)} GB` : ''}</dd>
            <dt>Render size</dt><dd><RenderTierPicker /><div className="dim" style={{ fontSize: 12, marginTop: 4 }}>Every video app starts here and keeps its own size chip. Past 720p, use Upscale.</div></dd>
            <dt>Get models</dt><dd className="mono">npm run models</dd>
            <dt>Check install</dt><dd className="mono">npm run doctor</dd>
          </dl>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0 12px' }}>
          <div className="label">Model bundles</div>
          <button type="button" className="btn sm" disabled={busy} onClick={() => void load(true)}>{busy ? 'Checking...' : 'Re-check'}</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {bundles?.map((b) => (
            <div key={b.id} className="tile" style={{ flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', width: '100%' }}>
                <span className="badge" style={b.ready ? { background: 'rgba(110,231,168,.14)', color: 'var(--ok)' } : b.optional ? undefined : { background: 'rgba(255,93,108,.14)', color: 'var(--bad)' }}>{b.ready ? 'ready' : 'missing'}</span>
                <b>{b.label}</b>
                <span className="dim" style={{ marginLeft: 'auto' }}>{b.gb} GB{b.optional ? ' · optional' : ''} · <span className="mono">{b.id}</span></span>
              </div>
              <div className="dim" style={{ fontSize: 12.5 }}>{b.purpose}</div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{b.license}</div>
              {b.licenseWarning && <div style={{ color: 'var(--accent)', fontSize: 12.5 }}>{b.licenseWarning}</div>}
              {!b.ready && (
                <div className="compiled">
                  {b.missingFiles.map((f) => <div key={f.file}>models/{f.dir}/{f.file}  ← {f.override ? `set by ${f.override} in .env (not downloaded)` : `${f.repo}${f.gated ? ' (gated: accept the license on Hugging Face first)' : ''}`}</div>)}
                  {b.missingNodes.map((n) => <div key={n.class}>custom nodes: {n.pack}  ← {n.url}</div>)}
                </div>
              )}
            </div>
          ))}
          {bundles?.length === 0 && <div className="empty">Could not read the engine. Start ComfyUI and press Re-check.</div>}
        </div>
      </div>
    </div>
  );
}
