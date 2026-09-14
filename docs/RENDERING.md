# Rendering

How a document becomes pixels and sound, both for interactive preview and for final export. It covers timeline evaluation, decoding, compositing, color, audio, effects and plugins, text, and export.

---

## 1. One renderer for preview and export

```
document snapshot (revision N)
   │
   ▼
engine::evaluate(sequence, t) ──▶ FramePlan  (what to draw at t, fully resolved)
   │
   ▼
DecoderPool ──▶ source frames (proxy or original, at the requested size)
   │
   ▼
compositor ──▶ RGBA frame ──┬─▶ preview: FrameTransport → <canvas>  (real time, drops frames)
                            └─▶ export:  ffmpeg encoder stdin      (every frame, as fast as possible)

engine::evaluate_audio(sequence, range) ──▶ mixer ──┬─▶ preview: audio device (master clock)
                                                    └─▶ export: loudness pass → WAV → mux
```

Preview and export differ only in **source variant** (proxy or original), **resolution**, **resampling quality**, and **pacing**. Evaluation, compositing, text, effects, and mixing are the same code, so preview matches export by construction (ADR-005). This is why the renderer lives in Rust rather than in the WebView: a WebView-side preview (HTML `<video>` + WebGL) next to an FFmpeg-filtergraph export would be two renderers that drift apart. It would also inherit per-OS WebView codec gaps.

---

## 2. Timeline evaluation (`engine::evaluate`)

A pure, Tauri-free function over the read-only Rust mirror of the document (`model`):

```rust
pub struct FramePlan {
    pub revision: u64,
    pub time: Flicks,
    pub canvas: Size,             // sequence size × preview scale
    pub layers: Vec<Layer>,       // bottom → top
}

pub struct Layer {
    pub input: LayerInput,
    pub crop: RectF,              // in source pixels
    pub transform: Affine2,       // fit rule × clip transform, in canvas pixels, resolved at t
    pub opacity: f32,
    pub effects: Vec<ResolvedEffect>,     // params resolved at t (content time)
}

pub enum LayerInput {
    Media { asset: AssetId, source_time: Flicks },
    Still { asset: AssetId },
    Text  { content: String, style: ResolvedTextStyle },
    Transition { effect: ResolvedEffect, progress: f32, from: Box<Layer>, to: Box<Layer> },
}
```

- For each visible video track, bottom to top: binary-search the clip, or the transition region, containing `t`. Compute `sourceTime = sourceIn + (t − start)`, resolve every `Animatable` at content time (TIMELINE.md §7), and emit a layer. Caption tracks are evaluated last into text layers.
- Cost is `O(tracks × log clips)` per frame, negligible next to decoding.
- `evaluate_audio(sequence, [t0, t1))` returns the audio segments overlapping the range: `(asset, stream, source range, gain envelope, pan, fades)`.
- **Golden tests:** `fixtures/eval/*.json` pairs a sequence with expected `FramePlan`s at given times. Keyframe interpolation fixtures are shared with the TS implementation.

---

## 3. Decoding (`preview::DecoderPool`)

A **decode session** is one FFmpeg child producing raw frames on stdout for one `(asset, variant, output size)`:

```
ffmpeg -ss <source start> -i <file> -map 0:v:0
       -vf "[tonemap,]scale=W:H:in_color_matrix=…:in_range=…:flags=…,fps=<sequence rate>,format=rgba"
       -f rawvideo pipe:1
```

- **Frames come out CFR at the sequence rate** (`fps` filter). Frame *k* of a session is exactly `start + k × frameDuration`, so no per-frame timestamps are needed on the pipe. VFR sources decode correctly because the `fps` filter picks frames by timestamp.
- `-ss` before `-i` is frame-accurate when decoding: FFmpeg seeks to the preceding keyframe and discards frames up to the target. On proxies (GOP 15), a seek costs < 100 ms. On long-GOP originals, it's the reason proxies exist.
- **Session reuse:** a request for the next expected frame reads from the running session. Anything else starts a new session. Sessions idle for 5 s are closed.
- **Read-ahead** during playback is bounded (8 frames). Pipe backpressure throttles FFmpeg, so memory stays flat.
- **Stills** are decoded once to RGBA at the needed size and kept in the frame cache.
- **Bandwidth:** 960×540 RGBA is 2 MB per frame, or 60 MB/s at 30 fps per layer, which is easy. 1080p export is 8.3 MB per frame, fine. 4K is 33 MB per frame, the known v1 ceiling (§11).
- The `DecoderPool` API (`frame_at(asset, variant, t, size)`, `stream_from(…)`) hides the process model. In-process libav decoding with hardware acceleration can replace child processes later without touching callers (ADR-005).

---

## 4. Compositor

- **v1: CPU compositing in Rust with `tiny-skia`.** Premultiplied RGBA8, affine transforms with bilinear (preview) or bicubic (export) filtering, opacity, standard blend modes, and crop and clip.
- Why CPU first: it's deterministic (pixel golden tests are stable across machines and drivers), has no GPU setup or device-loss handling, and is fast enough for 1080p. A full-frame layer costs a few ms at 540p and about 10–15 ms at 1080p.
- **Fast paths:** an opaque, identity-transformed, full-frame layer is a copy. Layers fully hidden under an opaque full-frame layer are skipped before decoding, which saves the decode too.
- **Export parallelism:** decode (FFmpeg processes) ∥ composite (worker thread, `rayon` over tiles) ∥ encode (FFmpeg process), connected by bounded queues of 3–4 frames.
- **GPU backend (wgpu)** comes in P12, when 4K export and heavier effects need it. The compositor's entry point (`composite(&FramePlan, &FrameSources, &mut Target)`) stays the same, and the golden tests (with tolerance) keep CPU and GPU in agreement. No abstraction layer is created until the second backend exists.

---

## 5. Preview playback

```
          ┌──── seek/scrub ────┐
 Idle ──▶ Seeking(t) ──▶ Paused(t) ⇄ Playing(from t)
                             ▲            │ edit (new revision): switch at next frame
                             └─ scrubbing ┘
```

- **Master clock is the audio device clock** (samples consumed by the output callback). With no audible audio, a monotonic system clock is used.
- The video render thread targets the frame for the current clock time. A frame that misses its deadline is dropped. **Audio never waits for video.**
- **Scrubbing** coalesces requests (latest wins), shows the nearest cached frame immediately, then replaces it with the exact frame.
- **Edits during playback:** a new document revision takes effect at the next frame. Decoder sessions unaffected by the edit keep running.
- **Preview resolution:** automatic (the panel size, capped at sequence size), or manual (Full, ½, ¼). Proxies can be switched on and off.

### 5.1 Frame transport to the WebView

Rendered RGBA frames at preview size go to the WebView as **binary messages over a Tauri `Channel`** (raw payload, no JSON or base64). They're drawn on a `<canvas>` via `putImageData`, or a WebGL texture upload if profiling says so. Each frame carries `{ revision, time }`, so stale frames are discarded.

**Validation gate (P5):** sustained 960×540 at 30 fps with ≤ 5 ms transport plus draw per frame on the reference machine. If it fails, the fallback is a localhost WebSocket carrying the same binary frames, an approach other Tauri video apps use in production. The measured decision will be recorded as an ADR.

### 5.2 Overlays

Transform handles, crop handles, and **safe-area guides** (title-safe, and the YouTube Shorts UI zones covered by buttons and captions) are drawn by the WebView as SVG over the canvas. They use the TS copy of the transform math, pinned to the Rust version by shared fixtures. The pixels underneath always come from Rust.

---

## 6. Color

- Decoding converts to 8-bit RGBA **with explicit input matrix and range** (`in_color_matrix=bt601|bt709`, `in_range=tv|pc`) taken from `MediaInfo`. Defaults are never trusted, because wrong assumptions cause the classic washed-out or crushed-blacks export. HDR sources are tone-mapped to SDR (MEDIA-PIPELINE.md §3.4).
- **Working space v1:** 8-bit premultiplied, BT.709 primaries and transfer, blending in gamma space. This matches common consumer editors.
- **Output:** RGBA → `yuv420p` BT.709 limited range, with explicit tags (`-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`) so YouTube interprets colors correctly.
- Color keyframes interpolate in linear light.
- Future (P12): 16-bit float linear working space on the GPU, HDR output.

---

## 7. Audio engine

- **Internal format:** 48 kHz, 32-bit float, stereo. Timeline audio is sample-accurate: 1 sample = 14,700 flicks exactly.
- **Sources:** FFmpeg decode sessions per `(asset, stream)` → `-f f32le -ac 2 -ar 48000`, resampled with `aresample=resampler=soxr` when available, feeding lock-free SPSC ring buffers.
- **Mixer** (real-time thread, no allocation and no locks in the callback):
  - clip gain (keyframed, ramped per sample, no zipper noise) and fades
  - constant-power pan
  - track gain, pan, mute, solo (P10)
  - master bus
  - peak and RMS meters sent to the UI at ≤ 30 Hz
- **Output:** `cpal` (WASAPI shared mode on Windows).
- **Export:**
  1. The same mixer runs offline, faster than real time.
  2. Integrated loudness is measured with the `ebur128` crate.
  3. Gain is applied to reach the preset target (YouTube preset: −14 LUFS integrated).
  4. A true-peak limiter caps output at −1 dBTP.
  5. The result is written as a 32-bit float WAV in the cache `tmp/` folder, then muxed.
- **Later audio work (P10):** EQ, compressor, noise reduction, ducking under voice. These are registry effects (§8) implemented in the mixer.

---

## 8. Effects and plugin architecture

### 8.1 Registry

```rust
pub struct EffectDef {
    pub id: &'static str,              // "kriti.color.adjust"
    pub version: u32,
    pub kind: EffectKind,              // Video | Audio | Transition | Generator
    pub params: &'static [ParamDef],   // key, type, default, range, animatable, label, unit
    pub migrate: Option<fn(u32, &mut ParamMap) -> Result<(), EffectError>>,  // older versions → current
}
```

- Built-in effects are implemented in the engine: compositor for video, mixer for audio.
- The UI fetches the catalog (`effects_list`), **generates inspector controls and Zod validators from the `ParamDef`s**, and contains no per-effect UI code for standard parameters.
- Document representation: `EffectInstance = { id, effect: 'kriti.color.adjust', version: 1, enabled, params: Record<string, Animatable<ParamValue>> }`.
- **Unknown effect** (id or version not in this build): the instance is preserved exactly, the effect renders as bypass, and the UI shows a "missing effect" badge. Projects never lose effects by passing through an older build.
- **Order of operations per layer:** source → crop → effects (in list order, in source pixel space) → transform → opacity → blend.

### 8.2 Initial catalog (P9, P10)

| Video | Transitions | Audio |
|---|---|---|
| color adjust (brightness, contrast, saturation, temperature), Gaussian blur, chroma key (green screen), drop shadow, LUT (`.cube`) | crossfade, dip to black/white, wipe, slide | gain, fades, 3-band EQ, compressor, noise reduction |

### 8.3 Third-party plugins (future)

Third-party effects will be **data, not native code**: a JSON manifest (params in the `ParamDef` format) plus WGSL shaders run by the GPU compositor in a sandbox with no filesystem or network access. That requires the GPU backend (P12), so nothing plugin-specific is built before then. The registry and `ParamDef` format above are the stable contract they'll use.

---

## 9. Text and captions

- **Shaping and layout:** `cosmic-text`, which provides HarfBuzz-class shaping (rustybuzz), bidi, line breaking, and font fallback. Devanagari conjuncts and matras, and **mixed Latin + Devanagari (Hinglish) lines**, shape correctly.
- **Fonts:** the app bundles Noto Sans and Noto Sans Devanagari, plus a small set of OFL display fonts, so projects render identically on every machine. System fonts are also available through `fontdb`. The document stores family, weight, and style. A missing font falls back with a visible warning in the UI and in the export report, never silently.
- **Rasterization:** glyphs are rendered with `swash` into a layer bitmap with fill, outline stroke, shadow, rounded background box, wrap width, alignment, and line height. Layers are cached by `(content, style, scale)`, so static text costs nothing per frame.
- **Captions** use the same renderer with the caption track style, positioned inside the safe area. Word-level highlight (karaoke style) comes with transcription (P11).
- **Why not FFmpeg `drawtext`/libass:** preview must show identical text interactively. One text engine inside the compositor covers both preview and export. Sidecar **SRT/VTT** export is still provided for YouTube's own caption system.

---

## 10. Export

1. **Start:** the UI export dialog sends preset, range, and output path to `export_start`, which returns a job id. The job takes an **immutable snapshot** of the current revision, so editing can continue during export.
2. **Preflight:**
   - All used media must be online. If not, the export fails immediately with the offline list.
   - All fonts must resolve, or the user confirms fallbacks.
   - Free disk space must cover estimated size × 1.2.
3. **Audio pass:** offline mix → loudness normalization → temp WAV. It's fast, and it surfaces audio problems before the long video pass.
4. **Video pass:** for each output frame *k*: `evaluate(t_k)` → decode originals at output size → composite at output resolution (high-quality filtering) → write RGBA to the encoder's stdin:
   ```
   ffmpeg -f rawvideo -pix_fmt rgba -s WxH -framerate R -i pipe:0 -i mix.wav
          -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p
          -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
          -c:a aac -b:a 384k -movflags +faststart <out>.part.mp4
   ```
5. **Finish:** progress is frames written over total, with ETA. Cancel kills the pipeline and deletes the `.part` file. On success, the output is probed (duration and stream check), renamed into place (the dialog has already confirmed any overwrite), and an export report (settings, time taken, warnings) goes to the job log.

### 10.1 Presets (v1)

| Preset | Size | Video | Audio | Loudness |
|---|---|---|---|---|
| YouTube 1080p | 1920×1080 | H.264 High, CRF 18, sequence fps, BT.709 | AAC-LC 48 kHz stereo 384 kb/s | −14 LUFS, −1 dBTP |
| YouTube Shorts | 1080×1920 | same | same | same |
| Custom | any even size ≤ sequence | CRF or target bitrate | AAC bitrate | target or off |

Sidecar outputs: SRT/VTT per caption track (P8), and chapter list text from chapter markers (P6+). 4K presets come in P12.

---

## 11. Known v1 limits and their upgrade paths

| Limit | Cause | Upgrade (phase) |
|---|---|---|
| 4K export is slow | CPU compositing; 33 MB RGBA frames over pipes | wgpu compositor, YUV transport, in-process hardware decode (P12) |
| 8-bit SDR only | working space | f16 linear GPU pipeline, HDR output (P12) |
| ~100 ms seek on non-proxied originals | new decode session per seek | proxies (P5); in-process decoding (P12) |
| Software encode only | hardware encoders unverified | NVENC/QSV/AMF after verified test encode (P12) |

Each of these is a change *behind* an existing boundary (`DecoderPool`, compositor entry point, `ffmpeg` encode plan). None requires touching the timeline model.
