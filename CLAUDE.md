# OpenField, for the agent doing the install

You are being asked to set up OpenField on this machine. Work through the
checklist below. Read [`docs/INSTALL.md`](docs/INSTALL.md) for the detail behind
each step, and [`docs/MODELS.md`](docs/MODELS.md) for the model tables.

The two things to keep in mind throughout: the model downloads are enormous
(72 GB for the core install, 334 GB for everything) and slow, so confirm the
choice before starting one; and several of these models carry license terms that
restrict what the user may legally do with the output, so surface those rather
than downloading silently past them.

## Checklist

1. **Check the prerequisites.** `node -v` must be 22 or newer. Confirm an NVIDIA
   GPU and how much VRAM it has (`nvidia-smi`). Below 24 GB, tell the user video
   generation will offload and be slow, that under about 16 GB they should
   plan on stills only, and that OpenField will default video to 480p (24 GB
   and up defaults to 720p; Setup > Render size or `OPENFIELD_RENDER_TIER`
   changes it). Confirm there is enough free disk for what they choose.

2. **Find or install ComfyUI.** OpenField does not include it. If
   `curl -s http://127.0.0.1:8188/system_stats` answers, it is already running,
   and the reported `comfyui_version` must be 0.38 or newer. If it is not
   installed, follow step 1 of `docs/INSTALL.md`, matching the PyTorch CUDA index
   URL to the card. Leave ComfyUI running.

3. **Set up the repo.**
   ```bash
   npm install
   pipx install comfy-api-proxy
   cp .env.example .env
   ```
   On a PEP 668 system (a global `pip install` refuses), use `pipx` as above or
   a venv, and set `COMFY_PROXY_BIN` in `.env` to the venv's `comfy-api-proxy`.
   Check that `ffmpeg` and `ffprobe` are on PATH (or set `FFMPEG_BIN` /
   `FFPROBE_BIN`); Stage, Remove background, HDR, the seam meter and Upscale
   need them.
   OpenField runs every job through the Comfy SDK, which needs Comfy API v2.
   comfy-api-proxy serves it locally on :8189 and the OpenField server starts
   it automatically if it is on PATH (or `COMFY_PROXY_BIN` names it). Make sure
   ComfyUI is started with `--preview-method auto` for live previews.
   Then edit `.env`: `COMFY_URL` if ComfyUI is not on the default port,
   `COMFY_MODELS_DIR` pointing at ComfyUI's `models/` folder, and `HF_TOKEN`.

4. **Handle the HuggingFace token yourself only as far as you can.** You cannot
   accept a license on the user's behalf. Ask them to open
   <https://huggingface.co/Lightricks/LTX-2.5>, accept it, and create a read
   token at <https://huggingface.co/settings/tokens>. Then put the token in
   `.env`. Never print the token back or commit it. `.env` is gitignored; keep
   it that way.

5. **Ask which bundles they want before downloading anything.** Run
   `npm run models -- --list` first to see what the machine already has. Then
   present the choice, including the license consequences:

   - `ltx25` (40 GB) and `qwen` (32 GB) are the core install. Both permit
     commercial use. This is the right default.
   - `h3` (42 GB) adds the MiniMax H3 engine. **Its license excludes the United
     States, the EU, the UK and South Korea.** Ask explicitly rather than
     assuming; if the user is in one of those, say so plainly and let them decide.
   - `h3-refs` (21 GB) adds reference-image mode, `h3-turbo` (8 GB) adds step
     distills. Both need `h3`.
   - `flux2` (51 GB) adds FLUX.2 stills. **Non-commercial license.**
   - `upres` (Upscale Sharpen, RealESRGAN, commercially clean) also needs two
     custom node packs cloned into `ComfyUI/custom_nodes/`, per
     `docs/INSTALL.md`. `upres-ultrasharp` adds 4x-UltraSharp, which is
     **non-commercial**.
   - `seedvr2` (24 GB, Apache 2.0) is Upscale Redraw. It needs the
     ComfyUI-SeedVR2_VideoUpscaler pack, which silently downloads missing
     weights on first use; fetch them through the installer instead.
   - `effects` (3 GB) and `effects-community` (5.6 GB) add the Effects app's
     LoRAs; both need `ltx25` and permit commercial use under the same $10M
     LTX terms. Each Lightricks effect repo is gated separately, so the user has
     to accept five more licenses on Hugging Face. Each effect only needs its
     own file, so a partial download still runs the rest.
   - `edit` (31.8 GB, Apache 2.0) is the Edit app, the image apps, Restyle and
     Cast stills.
   - `mirror` (0.7 GB) and `reshoot` (1 GB) add Mirror and Reshoot, LTX terms.
     Mirror needs comfyui_controlnet_aux, Reshoot needs ComfyUI-CrossViewWarp.
   - `cast` (1.3 GB, LTX terms, gated) holds cast members in video.
   - `stage` (1.3 GB, LTX terms, gated) and `stage-look` (23.8 GB, Apache 2.0,
     Z-Image Turbo) are Stage.
   - `trellis2` (14 GB, MIT; DINOv3 under the Meta DINOv3 License) is Object.
   - `hdr` (1.3 GB, LTX terms, gated) is Finish in HDR.
   - `cutout` (0.4 GB, MIT) is Remove background; `sam3` (1.8 GB, Meta SAM
     License) adds its tracked modes and Object swap; `swap` (1.3 GB, LTX terms,
     gated) is Object swap.
   - `dream` (no downloads) is Upscale Dream on `ltx25`.
   - `ltx-tools` (no downloads) is Extend, Transitions and Add sound: it only
     checks that VideoHelperSuite, KJNodes (GPL-3.0) and ComfyUI-LTXVideo are
     cloned. Speak needs nothing beyond `ltx25`.
   - `ltx23` is legacy, for running community fine-tunes. Skip unless asked.

   Then `npm run models` for the core, or
   `npm run models -- --only <ids>` for a specific set. Downloads resume, so
   re-run the same command after any failure rather than starting over.

6. **Restart ComfyUI.** It only scans its model folders at startup, so
   everything just downloaded is invisible until it does. Skipping this makes
   step 7 fail confusingly.

7. **Verify.** `npm run doctor`. It checks the Node version, whether ComfyUI
   answers, whether the weights are visible to the engine, and whether the output
   folder is writable. Everything it marks FAIL must be fixed before you tell the
   user it is ready. Do not report success on the basis of the download having
   finished; the doctor is the check.

8. **Run it.** `npm run dev`, then tell them to open <http://localhost:3160>.
   Suggest generating a still first: it is the fastest render and it exercises
   the whole path, submit through live preview through file write.

## Things that will trip you up

- **OpenField resolves models by exact filename.** A file with the right content
  and a slightly different name is a missing file. The names in
  `server/models.ts` are what the graph builders ask ComfyUI for, except for a
  model slot (`server/graphs/slots.ts`) whose variable is set in `.env`: then
  the configured name counts. Builders read a slot's file through `slotFile()`,
  never as a literal; `npm run test:model-slots` enforces that.
- **`COMFY_MODELS_DIR` is not necessarily where ComfyUI reads from.** ComfyUI's
  `extra_model_paths.yaml` frequently redirects model folders to another drive.
  The installer therefore asks the running engine what it can see and only falls
  back to scanning the filesystem when the engine is down. If those two disagree,
  the engine is right.
- **Do not set `OPENFIELD_HOST` to anything other than loopback.** There is no
  authentication, and project folders are arbitrary write paths.
- **Do not edit `docs/MODELS.md`.** It is generated from `server/models.ts` by
  `npm run docs:models`.
- If you change any code, `npm run typecheck` must pass before you hand back.
