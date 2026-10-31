# OpenField over MCP

OpenField ships an [MCP](https://modelcontextprotocol.io) server, so any agent
that speaks MCP (Claude Code, Claude Desktop, others) can drive every app:
Video, Seamless Loop, Image, Director, Mirror, Reshoot and Upscale. It runs on
your machine and talks only to your own OpenField server. OpenField itself
runs on local ComfyUI; Comfy Cloud as its engine is experimental, and Object
(`make_3d`) and Finish in HDR (`finish_hdr`) need the local engine. Video tools
render at the machine's render size, 720p by default on 24 GB or more.

The server is a thin stdio client of the OpenField HTTP API on `:3161`. It
builds the same request bodies the pages send (see
[`mcp/bodies.ts`](../mcp/bodies.ts)), so a take queued by an agent is the same
take you would get from the UI, and it shows up live in the UI's history.

## Setup

OpenField itself must be running (`npm run dev`, or `npm start`), with ComfyUI
up. Check with `curl -s http://127.0.0.1:3161/api/status`.

### Claude Code

```bash
claude mcp add openfield -- npx tsx /path/to/openfield/mcp/server.ts
```

`npx tsx` needs `tsx` reachable from wherever Claude Code starts the server; if
it is not installed globally (`npm i -g tsx`), run it through the repo instead,
which uses the repo's own copy and keeps stdout clean:

```bash
claude mcp add openfield -- npm --prefix /path/to/openfield run -s mcp
```

Add `--scope user` to make it available in every project, and
`-e OPENFIELD_URL=http://127.0.0.1:3161` if the server is not on the default
port. Then `/mcp` inside Claude Code lists the `openfield` tools.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config). Use
absolute paths: Desktop does not start from your shell, so `npx` may not be on
its PATH.

Linux, or native Windows with OpenField on the same machine:

```json
{
  "mcpServers": {
    "openfield": {
      "command": "npx",
      "args": ["tsx", "/path/to/openfield/mcp/server.ts"],
      "env": { "OPENFIELD_URL": "http://127.0.0.1:3161" }
    }
  }
}
```

Windows, with OpenField running inside WSL:

```json
{
  "mcpServers": {
    "openfield": {
      "command": "wsl.exe",
      "args": ["-e", "bash", "-lc", "cd /path/to/openfield && npm run -s mcp"]
    }
  }
}
```

`bash -lc` loads your login shell so Node from nvm is found. Restart Claude
Desktop after editing.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENFIELD_URL` | `http://127.0.0.1:3161` | The OpenField server the MCP talks to |
| `FFMPEG_BIN` | `ffmpeg` | Shrinks still previews before returning them |
| `FFPROBE_BIN` | next to `FFMPEG_BIN` | Reads clip length and size for Mirror and Reshoot |

Without ffprobe, clips are treated the way the UI treats unreadable metadata:
5 seconds at the app's default size.

## Tools

The server registers 31 tools.

| Tool | App | What it does |
| --- | --- | --- |
| `status` | | Engine up, ComfyUI version, GPU and free VRAM, queue, installed model bundles |
| `list_presets` | | Motion presets, LoRA effects, Director axes, Mirror modes, Reshoot angles, Transition styles, Edit modes and their options, model menus |
| `list_recipes` | | Ready-made prompt + preset pairs |
| `generate_video` | Video | Text to video, or start frame / start + end frame; preset, seconds, aspect, resolution, audio, count, model, `loras` (LTX-2.5) |
| `make_loop` | Seamless Loop | One image as first and last frame; every loop is measured; `auto_fix` (off by default) also tries to improve a visible seam |
| `generate_image` | Image | Qwen-Image or FLUX.2; aspect, quality, resolution, count, `loras`; on FLUX.2 up to 6 `references` (files or `take:<id>`) carried into a new photograph |
| `list_loras` | Your LoRAs | Every LoRA the engine sees that no app loads by itself, with the model family read from its tensor keys; pass names as `loras` (`{ name, strength }`, up to 4) |
| `edit_image` | Edit + image apps | Qwen-Image-Edit 2509. `mode=free`: an instruction, up to 2 extra images, optional mask. `angle`, `coverage`, `pushin`, `next`, `relight`: one take per picked option. `expand`: outpaint to a new aspect and/or pull back |
| `direct_shot` | Director | Scene + genre, camera, framing, light, film, look, grade, an `era` year (1960 to 2020, graded on the output with `era_grade`) and a speed `ramp`. `mode=frame` for stills, `mode=shot` for video with a camera move and optional hero frame |
| `direct_scene` | Director (Scene) | One scene into 2 to 6 shots, rendered and cut into one take. Without `shots` a local LLM plans them (Gemma 3 in the engine, then the OpenAI-compatible server in `OPENFIELD_LLM_URL` if set, then Ollama, then a sentence split); `plan_only` returns the plan to edit; a shot with `take` is reused, so re-rolling one shot is the same call |
| `stage_render` | Stage | Block a shot as JSON (props with `pos`, `size`, `rot`, optional `to`; camera `keys` or one key plus a `move`; `lens`, `seconds`, `aspect`) and render it with LTX-2.5 Layout to Render. The server draws the clay and depth passes; without `look_frame` it makes a look frame from the depth pass first (its own still take) |
| `mirror_motion` | Mirror | Source clip + prompt; mode `body`, `scene` or `outlines`; optional first frame |
| `restyle_video` | Mirror > Restyle | Source clip + a style (`list_presets section=restyle`) and/or your own words for the look; frame 0 is redrawn, the clip's motion carries it |
| `swap_object` | Mirror > Object swap | Experimental. Clip + what to replace (words, or a click point on frame 0) + what it becomes (words and/or a picture) |
| `remove_background` | Remove background | Still or clip; transparent (PNG, or ProRes 4444 with alpha as `alpha_path`), or over a color, a blur or a picture; clip modes `matte` (default), `hybrid`, `track` |
| `apply_effect` | Effects | One LoRA effect on a clip (`cutout`, `flood`, `nightfall`, `empty`) or a still (`living-photo`, `pop`, `inflate`, `cake`, `squish`, `unzip`, `gulp`); `text` fills what the effect asks for |
| `reshoot` | Reshoot | Clip + azimuth, elevation, pivot depth; `preview=true` for the fast depth-warp angle preview |
| `extend_video` | Extend | Continue a clip forward by 2 to 8 s, or `direction=backward` for a lead-in; returns one joined clip |
| `make_transition` | Transitions | Bridge two clips or stills with a style (`morph`, `whip`, `match`, `light-leak`, ...); returns from + bridge + to |
| `speak` | Speak | Face still + sound file: the picture follows the audio (LTX-2.5 audio to video) |
| `add_sound` | Add sound | Generate a soundtrack for a clip; the frames stay as they are (LTX-2.5 video to audio) |
| `upscale` | Upscale | A take or file, video or still. `mode` sharpen (2x, `model` esrgan or ultrasharp, `rife`), redraw (SeedVR2, `model` 3b or 7b, `height` 1080 or 1440, `color`) or dream (LTX-2.5, `creativity`, `prompt`) |
| `list_cast` | Cast | The cast: each member's `@mention`, kind, description and picture paths |
| `create_cast` | Cast | Save a character, prop or place from 1 to 6 pictures (paths or `take:<id>`) plus a description; an existing name gets the pictures added |
| `fix_seam` | Improve the seam | Measure a take's loop point (`measure_only`), or try to lower it: `strategy` auto (trim, then regen, then reseed, each only while the seam still shows), trim, regen, bridge or reseed. Fixes arrive as new takes |
| `make_3d` | Object | A still (file or `take:<id>`) to a textured GLB take on TRELLIS.2. `quality` draft or high, `remove_background` (BiRefNet, default on; off uses the PNG's own alpha), `count`. `get_take` returns `object.glb_url`, `turntable_url` and `subject_url` |
| `finish_hdr` | Finish in HDR | Re-render a video take with the LTX-2.5 SDR-to-HDR IC-LoRA: ACEScg EXR sequence (zip), HLG HEVC .mov and HLG ProRes .mov, frame-locked to the source; `get_take` lists the files and the format check |
| `list_takes` | | Recent takes, filterable by status, kind and app |
| `get_take` | | One take's status, output path and a preview image |
| `wait_for_take` | | Polls until the takes finish, fail or time out; sends MCP progress notifications |
| `cancel` | | Cancel one take, or clear the whole queue |

Every prompt, scene and instruction can **@mention** a cast member by name
(`"@Mara walks through the market"`). The server resolves the mention: its
description goes into the prompt, and its pictures go to the engine. Stills are
composed from the pictures by Qwen-Image-Edit 2509 (on FLUX.2 they become
reference latents instead), videos hold them on a
reference sheet through the LTX-2.5 Ingredients IC-LoRA (or, with
`cast_mode=frame`, start from a composed hero frame), and Mirror and Speak
compose a first frame of the member when you give none.

Generate tools queue the render and return take ids straight away. Renders take
from about 15 seconds (a draft still) to several minutes (a 1080p video), so the
agent calls `wait_for_take` next, then reads the result.

**Inputs.** Image, clip and sound arguments take a local file path (absolute, `~/...`,
or a `C:\...` path when the server runs under WSL) or `take:<id>` to reuse a
finished take. Local files are uploaded through `/api/upload`, the same as a
drop on a page. The upload limit is 45 MB per file.

**Previews.** `get_take` and `wait_for_take` return the still itself, or a
poster frame for a video, as MCP image content, downscaled to about 768 px wide.
The full file is at `output_path`.

**Licenses.** `model: "h3"` (MiniMax H3) is not licensed in the United States,
the EU, the UK or South Korea, and `flux2` is non-commercial. The default
upscale model (`ultrasharp`) is non-commercial too; `esrgan` is BSD-3-Clause.
Defaults are LTX-2.5 and Qwen-Image. Full list in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Example prompts

1. *"Make three Qwen stills of an old lighthouse keeper in a yellow raincoat on
   a pier as a storm breaks, 16:9. Show me them, then animate the best one with
   the Push In preset at 720p."* The agent calls `generate_image` with
   `count: 3`, `wait_for_take`, looks at the previews, then `generate_video`
   with `start_image: "take:<id>"` and `preset: "push-in"`.

2. *"Direct this: a fox crosses a frozen lake at dawn. Anamorphic, low angle,
   moonlight, 500T film, cold steel grade. Two frames first, then shoot the
   better one with a crane rise for 5 seconds."* `direct_shot` in frame mode,
   then again with `mode: "shot"`, `move: "crane-up"` and
   `hero_image: "take:<id>"`.

3. *"Cover this scene in three shots, 1970s, noir, with an impact ramp on the
   last one: a keeper climbs the lighthouse stairs as the storm hits, then sees a
   ship break on the rocks."* `direct_scene` with `plan_only: true`, then again
   with the returned `shots` (the last one with `ramp: "impact"`), `era: 1974`
   and `genre: "noir"`, then `wait_for_take` on the cut.

4. *"Take ~/clips/dance.mp4 and Mirror it in body mode onto a bronze statue
   dancing in an empty marble hall. When it is done, redraw it at 1080p and give me
   the file path."* `mirror_motion`, `wait_for_take`, `upscale`,
   `wait_for_take`, then `output_path` from the result.

4. *"Extend take 47 by 3 seconds, then make a whip-pan transition from it to
   the kite still, take 58."* `extend_video` with `clip: "take:47"`,
   `wait_for_take`, then `make_transition` with `from: "take:<new id>"`,
   `to: "take:58"`, `style: "whip"`.

## Development

```bash
npm run mcp          # run the server on stdio (what the agent launches)
npm run mcp:check    # body parity: MCP bodies vs the page code, no network
npm run mcp:smoke    # spawn the server with the SDK client, call the read-only tools
```

`mcp:check` extracts the request-body code from `src/pages/*.tsx`, evaluates it
with the same inputs, and compares the result to what `mcp/bodies.ts` builds. If
you change how a page builds its body, it fails until the MCP builder matches.
`mcp:smoke` needs OpenField running and never queues a render.

When you add an app, add its body builder to `mcp/bodies.ts`, a case to
`mcp/bodies.check.ts`, and a tool to `mcp/server.ts`.
