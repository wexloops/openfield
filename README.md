# OpenField

OpenField is an open-source studio for video, stills and 3D that runs on your own
GPU through ComfyUI. Every app is a ComfyUI workflow with a screen on top, built
on open-weights models and the Comfy SDK.

Built for Comfy's Open Source Higgsfield competition. MIT licensed.

![Explore](docs/media/explore.png)

## What you can do

**Create**
- **Video**: text or an image to video, 28 motion presets, start and end frames, batch takes.
- **Image**: stills from a prompt, animated in one click. On FLUX.2, up to six reference pictures (or `@cast`) carry faces, clothes and objects into a new photograph.
- **Seamless Loop**: one image becomes a loop whose first and last frames match.
- **Object**: one still becomes a textured 3D model (GLB with PBR maps and a turntable).
- **Add sound**: a soundtrack for a silent take, with the picture left as it is.

**Direct**
- **Director**: genre, camera, framing, light, film stock, look, grade, an era scrubber (1960 to 2020) and speed ramps compile into the shot.
- **Scene**: write a scene, a local LLM plans 2 to 6 shots, and they render and cut into one take.
- **Stage**: block a shot in 3D with boxes, figures, walls or your own .glb models and a camera path; it renders as a finished shot that moves like the blocking. Figures hold their marks, so write people standing, turning or gesturing where you placed them.
- **Cast**: save a character, prop or place once and `@mention` it in any prompt.
- **Your LoRAs**: add up to four of your own LoRAs (a character, a style, a motion) to Image or Video. Drop the file in ComfyUI's `models/loras`; OpenField reads each file's tensor keys and only offers it to the model it was trained for.
- **Coverage**, **Push in**, **Next beat**: nine shots of one moment, a stepped push in, four continuations.

**Transform**
- **Mirror**: film a move on your phone and put that motion onto any character. Restyle (22 looks) and an experimental Object swap.
- **Reshoot**: re-aim the camera on an existing clip after the fact.
- **Effects**: one-click effects on a clip (Cutout, Flood, Nightfall, Empty the scene) or a still (Living photo, Pop, Inflate, Cake, Squish, Unzip, Gulp).
- **Edit**, **New angle**, **Relight**, **Expand**: change a still with a sentence and a mask, see it from new angles, move the light, grow the frame.
- **Remove background**: transparent PNG for stills, ProRes 4444 with alpha for clips.
- **Speak**: a face and a voice track become a talking shot.

**Finish**
- **Upscale**: Sharpen (fast 2x, optional frame doubling), Redraw (SeedVR2 to 1080p or 1440p) or Dream (prompt-steered 2x), with a drag compare.
- **Extend** and **Transitions**: continue a take or add a lead-in; bridge two takes with a generated move.
- **Finish in HDR**: ACEScg EXR, HLG HEVC and HLG ProRes masters, frame-locked to the source.
- **Improve the seam**: every loop gets a seam score; the fixer trims, re-renders or reseeds.

**Build with**
- **MCP**: 31 tools let Claude Code, Claude Desktop or any MCP client run every app.
- **Open in ComfyUI**: every take opens as the exact workflow that rendered it, or downloads as JSON.
- **[`workflows/`](workflows)**: every app's graph committed as API-format JSON.

| | |
| --- | --- |
| ![Video](docs/media/video.png) | ![Director scene](docs/media/director-scene.png) |
| ![Stage](docs/media/stage.png) | ![Mirror](docs/media/mirror.png) |
| ![Effects](docs/media/effects.png) | ![Upscale compare](docs/media/upscale-compare.png) |

![Viewer with its workflow](docs/media/viewer-workflow.png)

## What is new here

- **Phone to Mirror.** Scan a QR code, film a move on your phone, and the clip
  lands in Mirror as the motion source.
- **Reshoot after the fact.** Move the camera on a clip you already have.
- **Seamless loops with a seam meter.** Every loop is measured at its wrap and
  badged Seamless or Visible seam; the fixer reports the before and after numbers.
- **Every take opens as its ComfyUI workflow.** Download it or open it in ComfyUI,
  change it, run it there.
- **HDR and EXR finish.** 16-bit half ACEScg EXR sequences and HLG BT.2020 masters.
- **All local.** Renders run on your GPU and land in your folders. No credits,
  no paid account, no upload. A free Hugging Face account and read token fetch
  the gated LTX-2.5 weights.
- **Stage, greybox to shot.** Block boxes, figures, props and your own .glb models
  in the browser, set a lens and a camera path, and the LTX-2.5 Layout-to-Render
  IC-LoRA renders a finished shot that follows the blocking exactly.
- **MCP for agents.** 31 tools let an agent direct, render, check and finish shots
  end to end on your machine.

### How Stage differs

Stage blocks the shot in the browser: boxes, figures, walls, your own .glb
models, a lens and a camera path, drawn with three.js. No 3D package is needed.
The browser renders two passes of the blocking, a grey clay clip and an exact
depth pass from the same camera. The look frame is painted on that depth pass
(Z-Image Turbo with the Fun ControlNet Union), so the art-directed still keeps
every object where it was blocked. The clay clip and the look frame then go to
the LTX-2.5 Layout-to-Render IC-LoRA, which renders a shot that moves like the
blocking. Every step runs on open weights on your own GPU.

## How it is built

```
Browser (Vite + React)  ──>  OpenField server (Fastify, :3161)
                                │  graph builders: server/graphs/*.ts
                                │  every job: @comfyorg/sdk (Comfy API v2)
                                ▼
                         comfy-api-proxy (:8189)  ──>  ComfyUI (:8188, your GPU)
```

- Every render goes through the official Comfy SDK (`@comfyorg/sdk`,
  [`server/engine.ts`](server/engine.ts)): asset upload, job submit, the live event
  stream with step progress and latent previews, outputs and cancel.
- Locally the SDK talks to [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy)
  in front of your ComfyUI. OpenField starts the proxy for you.
- Local ComfyUI is the supported path. Comfy Cloud is experimental: set
  `COMFY_BASE_URL` and `COMFY_API_KEY` and the same SDK calls go there, but it
  is untested, the custom node packs limit which apps run, and Object and
  Finish in HDR need a local engine.
- Each app's workflow is a TypeScript graph builder in [`server/graphs/`](server/graphs).
  `npm run workflows` exports them to [`workflows/`](workflows).
- Model health and install checks read the ComfyUI server API directly, because
  Comfy API v2 has no node introspection yet.

## Requirements

| | |
| --- | --- |
| GPU | 24 GB VRAM for video. Built and measured on a 32 GB RTX 5090; NVIDIA is the only vendor tested. AMD through ROCm on Linux is untested (reports welcome). Video renders at 720p by default on 24 GB or more, 480p below (Setup > Render size changes it). Some apps cap their size: Mirror, Restyle, Object swap, Effects, Speak, Extend and Transitions stop at 720p, Reshoot at 480p. 12 to 16 GB runs stills. |
| OS | Linux or Windows, or WSL2 driving a Windows ComfyUI. macOS is untested. |
| Software | Node 22+, Python 3.10 to 3.12, ComfyUI 0.38 or newer, `ffmpeg` and `ffprobe` on PATH |
| Disk | 72 GB for the core install, about 334 GB for every bundle |

Disk per bundle (from [`server/models.ts`](server/models.ts); install only what you use):

| Bundle | Size | Apps |
| --- | --- | --- |
| `ltx25` (core) | 39.8 GB | Video, Loop, Director, Scene, Extend, Transitions, Speak, Add sound |
| `qwen` (core) | 31.8 GB | Image, hero frames |
| `edit` | 31.8 GB | Edit, image apps, Restyle, Cast stills |
| `stage` + `stage-look` | 1.3 + 23.8 GB | Stage |
| `trellis2` | 14 GB | Object |
| `seedvr2` | 23.8 GB | Upscale Redraw |
| `upres` | 0.1 GB | Upscale Sharpen |
| `mirror` | 0.7 GB | Mirror |
| `reshoot` | 1 GB | Reshoot |
| `effects` + `effects-community` | 3.1 + 5.6 GB | Effects |
| `cast` | 1.3 GB | Cast in video |
| `hdr` | 1.3 GB | Finish in HDR |
| `cutout` + `sam3` | 0.4 + 1.8 GB | Remove background, Object swap |
| `swap` | 1.3 GB | Object swap |
| `flux2` | 50.9 GB | Image with FLUX.2 (non-commercial) |
| `h3`, `h3-refs`, `h3-turbo` | 42.5, 21, 8 GB | MiniMax H3 video (geo-restricted) |

`dream` and `ltx-tools` add no weights. The Scene planner uses the Gemma 3 12B
encoder from the legacy `ltx23` bundle when it is present, and falls back to
an OpenAI-compatible server (`OPENFIELD_LLM_URL`), Ollama or a sentence split.

## Install

1. Start ComfyUI (0.38+) with live previews and leave it running:
   ```bash
   python main.py --listen 127.0.0.1 --port 8188 --preview-method auto
   ```
2. Install OpenField and the Comfy API v2 bridge:
   ```bash
   git clone https://github.com/wexloops/openfield.git
   cd openfield
   npm install
   pipx install comfy-api-proxy       # or a venv; then set COMFY_PROXY_BIN
   cp .env.example .env
   ```
3. Accept the license at <https://huggingface.co/Lightricks/LTX-2.5> (and the
   separately gated LoRA repos if you want Effects, Stage, Cast, HDR or Object
   swap), create a read token, and put these in `.env`:
   ```bash
   HF_TOKEN=hf_...
   COMFY_MODELS_DIR=/path/to/ComfyUI/models
   ```
4. Fetch the models, restart ComfyUI, check, run:
   ```bash
   npm run models -- --list           # what you have, what you are missing
   npm run models                     # core weights: LTX-2.5 + Qwen-Image
   npm run doctor                     # checks everything that breaks
   npm run dev                        # open http://localhost:3160
   ```
5. For a quick test, open Image and pick **Draft**.

For one process serving the UI and API together on :3161, run `npm run build`
then `npm start`.

The full walkthrough, the custom node packs each app needs and every bundle are
in [`docs/INSTALL.md`](docs/INSTALL.md). With Claude Code, open the repo and say
"set up OpenField": [`CLAUDE.md`](CLAUDE.md) is the install as an agent checklist.
One command does it on Linux or WSL: `bash scripts/install.sh` (see
[One-command install](docs/INSTALL.md#one-command-install); a password-gated
preview on a rented GPU is in [`docs/RUNPOD.md`](docs/RUNPOD.md)).

## Models and licenses

OpenField's code is MIT. It ships no model weights; you download them from their
publishers and each keeps its own license. Every default model is open weights.

- **LTX-2.5 and the LTX IC-LoRAs** (video, Stage, Mirror, Reshoot, Effects, HDR):
  LTX-2.x Community License, free for commercial use under $10M yearly revenue.
- **Qwen-Image, Qwen-Image-Edit 2509, Z-Image Turbo, SeedVR2:** Apache 2.0.
- **TRELLIS.2, BiRefNet, MoGe-2, RealESRGAN, RIFE:** MIT or BSD-3-Clause.
- **DINOv3 and SAM 3.1:** Meta licenses, commercial use allowed with acceptable-use exclusions.
- **Opt-in and non-commercial:** FLUX.2 dev and 4x-UltraSharp.
- **Opt-in and geo-restricted:** MiniMax H3 is unlicensed in the US, EU, UK and South Korea. Off by default.

Every model, LoRA and node pack with its license and source is in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). File lists and sizes are in
[`docs/MODELS.md`](docs/MODELS.md).

## Sample media

All sample media in this repository was generated with OpenField on open
weights. No real people, no third-party footage. Take, prompt, seed and model
for every file are in [`docs/MEDIA.md`](docs/MEDIA.md).

## MCP quick start

```bash
claude mcp add openfield -- npx tsx /path/to/openfield/mcp/server.ts
```

With the OpenField server running, ask in plain words: "Make a 5 second dolly
shot of a lighthouse at dusk, then upscale the best take." Claude Desktop setup,
the tool list and example prompts are in [`docs/MCP.md`](docs/MCP.md).

## Configuration

All optional, in `.env` (see [`.env.example`](.env.example)):

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI server (health, model lists) |
| `COMFY_BASE_URL` | `http://127.0.0.1:8189` | Comfy API v2 for jobs (the local proxy; Comfy Cloud is experimental). The auto-started proxy listens on this URL's port, so a second instance picks its own here |
| `COMFY_API_KEY` | | Comfy Cloud (experimental) or a deployment only |
| `COMFY_PROXY_BIN` | `comfy-api-proxy` | Started automatically when the local v2 API is down |
| `COMFY_LAUNCH` | | Command that starts ComfyUI from the engine status button |
| `COMFY_MODELS_DIR` | | ComfyUI's `models/` folder, for the installer |
| `HF_TOKEN` | | Hugging Face read token for the gated repos |
| `OPENFIELD_OUTPUT` | `~/openfield-output` | Where renders are saved |
| `OPENFIELD_PORT` | `3161` | Server port |
| `OPENFIELD_UI_PORT` | `3160` | Dev UI port (Vite) |
| `OPENFIELD_DATA` | `./data` | Database and engine-input cache |
| `OPENFIELD_RENDER_TIER` | by VRAM | Default video size: `480p`, `720p` or `1080p` (Setup > Render size overrides it) |
| `OPENFIELD_HOST` | `127.0.0.1` | Bind address. Keep it on loopback: the server has no authentication |
| `OPENFIELD_PHONE_PORT`, `OPENFIELD_PHONE_HOST` | `3162`, auto | The phone capture listener, open only while a QR code shows |
| `OPENFIELD_LLM_URL`, `OPENFIELD_LLM_MODEL`, `OPENFIELD_LLM_KEY` | unset, the first listed model, none | Optional Scene planner through an OpenAI-compatible server (base URL up to `/v1`) |
| `OPENFIELD_OLLAMA_URL`, `OPENFIELD_OLLAMA_MODEL` | `http://127.0.0.1:11434`, a model list | Optional Scene planner through Ollama |
| `FFMPEG_BIN`, `FFPROBE_BIN` | `ffmpeg`, `ffprobe` | Paths to ffmpeg and ffprobe |
| `WHISPER_BIN` | | openai-whisper CLI: video takes with speech get a transcript |
| `SPICE_DIR` | | Extra folder of LTX-2.3 community checkpoints for the legacy engine |

## Adding an app

1. Write a graph builder in `server/graphs/` (an API-format ComfyUI graph as an object).
2. Add a `kind` branch to `graphFor()` in `server/index.ts`.
3. Add a page in `src/pages/` and an entry in `APPS` in `src/catalog.ts`.
4. Expose it to agents: a body builder in `mcp/bodies.ts`, a parity case in
   `mcp/bodies.check.ts`, and a tool in `mcp/server.ts`.

## Models and tools used

The contest asks entrants to name every model and tool they combine. This is the
full list, taken from [`server/models.ts`](server/models.ts) and the graph
builders. Licenses are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Video: [LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) (Lightricks)**
- LTX-2.5 22B distilled transformer, video VAE, audio VAE and the x2 latent spatial upscaler.
- Gemma 4 12B text encoder with the LTX projections (Google Gemma 4, packaged by Lightricks).
- LTX-2.5 IC-LoRAs: Layout-to-Render (Stage), Ingredients (Cast), SDR-to-HDR and its scene embeddings (Finish in HDR), Alpha-Gen (Cutout), Water-Simulation (Flood), Day-To-Night (Nightfall), Clean-Plate (Empty the scene). The Cinemagraph LoRA (Living photo).
- LTX-2.3 IC-LoRAs that run on LTX-2.5: Union Control (Mirror) and In/Outpainting (Object swap).
- [CrossView-Warp v2 IC-LoRA and node](https://github.com/cseti007/ComfyUI-CrossViewWarp) (Cseti), for Reshoot.
- Community LoRAs by [kabachuha](https://huggingface.co/kabachuha) for Effects: ltx23-pop, ltx2-inflate, ltx2-cakeify-v2, ltx2-handsquish, ltx2-disguise-drop and ltx2-eat-v2.
- Gemma 3 12B (from the legacy `ltx23` bundle) as the Scene planner when it is installed.

**Stills**
- [Qwen-Image](https://huggingface.co/Qwen/Qwen-Image) with its VAE, [Qwen-Image-Edit 2509](https://huggingface.co/Qwen/Qwen-Image-Edit-2509) and the Qwen2.5-VL 7B text encoder (Alibaba Qwen).
- Qwen-Image and Qwen-Image-Edit-2509 Lightning 8-step LoRAs (lightx2v), the Qwen-Edit-2509 Multiple-angles LoRA (dx8152).
- [Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) (Tongyi-MAI), its Qwen3 4B text encoder, the FLUX.1 VAE (`ae.safetensors`, Black Forest Labs) and the Z-Image-Turbo Fun ControlNet Union (Alibaba PAI), for Stage look frames.

**Pose, depth and geometry**
- DWPose and the YOLOX-L person detector (Mirror body mode) and Depth Anything V2 Small (Mirror depth mode), through [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux).
- [MoGe-2](https://github.com/microsoft/MoGe) ViT-L (Microsoft), for Reshoot.

**3D and mattes**
- [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) 4B with its shape and texture VAEs (Microsoft) and the DINOv3 ViT-L image encoder (Meta), for Object.
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), for Remove background and Object.
- SAM 3.1 (Meta), for steady and tracked mattes and Object swap.

**Finish**
- [SeedVR2](https://github.com/ByteDance-Seed/SeedVR) 3B and 7B with its VAE (ByteDance Seed), for Upscale Redraw.
- [RealESRGAN](https://github.com/xinntao/Real-ESRGAN) x4plus, for Upscale Sharpen.
- [RIFE](https://github.com/hzwer/Practical-RIFE) 4.7, for frame doubling and Director speed ramps.

**Opt-in, off by default**
- FLUX.2 dev with its Mistral Small 3 text encoder, VAE and Turbo LoRA (Black Forest Labs, non-commercial).
- [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) FL2VA and Ref2VA with the Qwen3-VL 32B encoder, video and audio VAEs and the lightx2v turbo LoRAs (geo-restricted).
- 4x-UltraSharp (non-commercial), a second Sharpen model.
- An LLM on an OpenAI-compatible server (`OPENFIELD_LLM_URL`) or an Ollama model as the Scene planner fallback (for Ollama: gpt-oss 20B, Qwen3 30B or 8B, or Gemma 3 12B, whichever is installed).
- A local whisper CLI for dialogue transcripts (`WHISPER_BIN`).

**Tools**
- [ComfyUI](https://github.com/Comfy-Org/ComfyUI) 0.38+, the [Comfy SDK](https://www.npmjs.com/package/@comfyorg/sdk) and [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) (Comfy Org).
- Custom node packs: ComfyUI-LTXVideo, VideoHelperSuite, KJNodes, comfyui_controlnet_aux, ComfyUI-CrossViewWarp, ComfyUI-SeedVR2_VideoUpscaler and ComfyUI-Frame-Interpolation. ComfyUI's core GLSLShader node runs the era grade.
- ffmpeg and ffprobe: the seam meter, HDR format checks, alpha clips and previews.
- App: React, Vite, Fastify, SQLite (better-sqlite3), three.js, the MCP SDK, zod and ws.

OpenField is an independent project with its own name, design, copy and presets.
Higgsfield and Comfy Org do not endorse it.
