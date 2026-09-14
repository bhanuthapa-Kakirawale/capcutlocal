# Media Pipeline

How media gets from a file on disk to something the editor can show, scrub, and render, without ever modifying the file, loading it whole into memory, or blocking the UI. Covers FFmpeg integration, import, metadata, derived artifacts (thumbnails, filmstrips, waveforms, proxies), and the cache.

---

## 1. FFmpeg integration: the `ffmpeg` gateway

The Rust `ffmpeg` module is the **only** code that spawns `ffmpeg` or `ffprobe`. Other modules ask it for typed operations (`probe`, `extract_poster`, `decode_video`, `encode`, …) and get typed results or typed errors.

### 1.1 Binary resolution and capability detection

1. Resolution order: **user-configured path** → **bundled sidecar** (Tauri `externalBin`: `binaries/ffmpeg-<target-triple>[.exe]`) → **`PATH`**.
2. On first use (cached for the session), the gateway runs `-version`, `-encoders`, `-decoders`, `-filters`, and `-hwaccels` and builds `FfmpegCapabilities`: version, available encoders (`libx264`, `aac`, `h264_nvenc`, `h264_qsv`, `h264_amf`, …), required filters present (`scale`, `zscale`, `tonemap`, `loudnorm`, …), and hardware acceleration.
3. Minimum supported FFmpeg version is **7.0**. Older or missing binaries produce `FFMPEG_MISSING`/`FFMPEG_TOO_OLD`, shown in Settings → Diagnostics with the resolved path.
4. A hardware encoder counts as available only after a 1-second test encode succeeds. Listing in `-encoders` isn't enough, since drivers are often missing.

The development machine has a recent GPL build (`N-122897`, 2026-02) on `PATH`. Distribution licensing (GPL build with x264 vs. an LGPL build) is decided in the packaging phase (ADR-004). Running FFmpeg as a separate process keeps that decision open because the app never links FFmpeg.

### 1.2 Typed command construction

- Arguments are built as `Vec<OsString>` and passed to `std::process::Command` directly, **never through a shell**. Paths with spaces, quotes, or Devanagari characters (`समाचार क्लिप.mp4`) need no escaping and can't inject arguments. A path beginning with `-` is prefixed with `file:` so it can't be read as an option.
- Every invocation includes `-hide_banner -nostdin` (except encoders that read frames from stdin) and an explicit `-loglevel`.
- Floating-point seconds appear only here, converted from flicks at the last moment with enough precision (`{:.6}`) to address individual frames.
- On Windows, processes are created with `CREATE_NO_WINDOW` (no console flashes) and assigned to a **Job Object with `KILL_ON_JOB_CLOSE`**, so if the app crashes, no orphaned FFmpeg keeps burning CPU.

### 1.3 Process supervision

- Spawned with `tokio::process::Command`, `kill_on_drop(true)`, and all three pipes captured.
- **stderr is drained continuously** into a 64 KiB ring buffer plus the per-job log file. An undrained stderr pipe is the classic cause of hung FFmpeg children.
- Progress: jobs whose stdout isn't carrying data use `-progress pipe:1 -nostats` and parse `out_time_us=` against the known output duration.
- Stall watchdog: no progress and no output for 30 s (configurable per job kind) → kill, fail with `FFMPEG_STALLED`.
- Cancellation: `CancellationToken` → kill the child → delete temp output → `cancelled`.
- Exit mapping: non-zero exit → `FfmpegError { kind, exitCode, stderrTail }`. `kind` is classified from known stderr patterns: `InputNotFound`, `InvalidData`, `UnsupportedCodec`, `EncoderMissing`, `DiskFull`, `PermissionDenied`, `Unknown`. The UI message comes from `kind`, and `stderrTail` goes to the log and the "details" disclosure.

---

## 2. Import

### 2.1 Flow

```
UI: native file dialog / drag-drop ─▶ media_import({ paths })
Rust, per file (probe class, 4 concurrent):
  1. stat → size, mtime
  2. fingerprint: BLAKE3(size ‖ first 1 MiB ‖ middle 1 MiB ‖ last 1 MiB)
  3. library.db lookup by fingerprint ─ hit ─▶ cached MediaInfo
                                     └ miss ─▶ ffprobe (JSON) → MediaInfo → store
  4. classify kind (video | audio | image) and check decoder support
  5. emit per-file result (success or typed error); a failure never aborts the batch
UI: addAssets op (one undo step for the batch) ─▶ Asset records in the document
Rust: enqueue derived jobs (§4): poster → filmstrip, waveform → proxy (per policy)
      emit media:updated as each artifact lands
```

- **Fingerprint** reads 3 MiB, so it's constant-time for a 50 GB file. Including the size makes accidental collisions practically impossible for real media. Content-based identity means the same file imported into two projects, or moved to another drive, reuses all cached artifacts.
- **Classification:** a video stream flagged `attached_pic` (album art) doesn't make a file "video". Single-frame image codecs (PNG, JPEG, WebP, BMP, TIFF) are `image`. Animated GIF and WebP are treated as `video`.
- Import is **non-blocking**: the asset appears as soon as the probe finishes (target < 1 s), and thumbnails stream in afterwards.

### 2.2 Change detection

On project open and on window focus, each online asset is `stat`ed. If size or mtime changed, the sample hash is recomputed. A different hash marks the asset **changed** (PROJECT-MODEL.md §3.2), and the user is asked before the new file is accepted, because its duration and frames may no longer match the edit.

### 2.3 Relink

For offline assets, the user picks a folder. Rust scans it (recursive, bounded depth and count, cancellable job) and filters candidates by **size first** (free), then by sample hash (3 MiB read each). When one asset is found in a folder, the remaining offline assets are tried there first, which relinks a moved project folder in one step.

---

## 3. Media metadata

### 3.1 `MediaInfo`

Parsed from `ffprobe -v error -print_format json -show_format -show_streams` into a strict struct. Mirrored as a Zod schema in TS; the shape is covered by a contract fixture.

```ts
type MediaInfo = {
  container: string;                 // ffprobe format_name
  durationFlicks: Flicks;            // normalized (§3.2)
  sizeBytes: number;
  bitRate: number | null;
  video: VideoStreamInfo | null;     // primary video stream (not attached pictures)
  audio: AudioStreamInfo[];          // all audio streams; AudioClip.streamIndex points into this
  image: { width: number; height: number; hasAlpha: boolean } | null;
  probedWith: string;                // ffprobe version; a major change triggers a re-probe
};

type VideoStreamInfo = {
  streamIndex: number;
  codec: string;                     // "h264" | "hevc" | "prores" | "vp9" | "av1" | …
  profile: string | null;
  width: number; height: number;     // coded size, before rotation
  sampleAspectRatio: Rational;
  rotation: 0 | 90 | 180 | 270;      // from display-matrix side data (phones)
  frameRate: Rational;               // nominal (r_frame_rate)
  avgFrameRate: Rational;
  isVariableFrameRate: boolean;      // §3.3
  pixelFormat: string;               // "yuv420p", "yuv420p10le", …
  bitDepth: number;
  colorPrimaries: string | null; colorTransfer: string | null; colorSpace: string | null;
  colorRange: 'tv' | 'pc' | null;
  isHdr: boolean;                    // transfer is PQ (smpte2084) or HLG (arib-std-b67)
  hasAlpha: boolean;
  startOffsetFlicks: Flicks;         // stream start relative to media time 0 (§3.2)
  durationFlicks: Flicks;
};

type AudioStreamInfo = {
  streamIndex: number;
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout: string | null;
  language: string | null;           // e.g. "hin", "eng"
  startOffsetFlicks: Flicks;
  durationFlicks: Flicks;
};
```

### 3.2 Time normalization

Containers often start at a non-zero timestamp (MPEG-TS, MP4 edit lists, recordings where audio starts slightly before video).

- **Media time 0 = the container's `start_time`.** Each stream's `startOffsetFlicks = stream.start_time − format.start_time` keeps the true A/V offset.
- A decode request for media time *m* seeks to `format.start_time + m`.
- `pts × time_base → flicks` conversion is integer math with an `i128` intermediate, rounded to nearest. No floating-point on the timestamp path.

### 3.3 Variable frame rate (screen recordings)

Screen recordings (OBS, Game Bar, phone captures) are often VFR, a leading cause of audio drift in editors.

- **Detection:** `r_frame_rate ≠ avg_frame_rate` is a hint. It's confirmed by sampling packet timestamps in three windows (`-read_intervals`) and checking the variance of frame intervals.
- **Handling:** all decoding is **timestamp-based**. Frame *n* is never assumed to sit at *n / fps*, so VFR plays in sync. Proxies are conformed to CFR (§5). Export decodes originals by timestamp.

### 3.4 Rotation, aspect, HDR

- Decoders always deliver **display-oriented** frames (FFmpeg autorotate), so the engine never deals with rotation metadata. Display size = coded size, rotated, times SAR.
- **HDR (PQ/HLG) in v1:** tone-mapped to SDR BT.709 at decode (`zscale` + `tonemap`, or `libplacebo` when available), with a visible "HDR converted to SDR" note. A real HDR pipeline is roadmap P12.

---

## 4. Derived artifacts

All artifacts are cache content (§6): keyed by fingerprint, versioned, regenerable, never referenced from the project file.

| Artifact | How | Format | Consumer |
|---|---|---|---|
| **Poster** | One frame at 10% of duration (skips black intros), scaled to 320 px wide | JPEG | media browser |
| **Filmstrip** | Keyframe-only decode (`-skip_frame nokey`) at an adaptive interval (≥ 1 s, ≤ 600 frames per asset), 160 px high, packed into sprite sheets | JPEG sheets + `index.json` (frame times) | timeline clip thumbnails |
| **Waveform peaks** | FFmpeg decodes the audio stream to f32 PCM on stdout. Rust reduces it in a single streaming pass to min/max pairs: base level 256 samples/pair, then ×4 mip levels | binary `.peaks` (header + i16 min/max per channel per level), ~1.3 MB per channel-hour | timeline waveforms at any zoom |
| **Proxy** | §5 | MP4 H.264 | preview |
| **Transcription audio** *(P11)* | 16 kHz mono PCM | WAV | AI transcription |

The UI loads posters and filmstrip sheets through Tauri's asset protocol (scoped to the cache directory). File names include the generator version, so browser caching is safe. Waveform peaks go over raw IPC per requested level and time range, so the UI never holds more than it draws.

---

## 5. Proxies

**Purpose:** smooth scrubbing and playback of media that's expensive to decode or seek: 4K, HEVC/AV1, long-GOP phone and camera footage, 60 fps VFR screen recordings. **Proxies are never used for export.**

**Policy** (`ProjectSettings.proxyPolicy`, default `auto`). With `auto`, a proxy is created when any of these hold:
- display height > 1080
- codec ∈ {hevc, av1, vp9, prores}
- measured GOP > 2 s
- VFR

**Format:**

| Property | Value | Why |
|---|---|---|
| Container, codec | MP4, H.264 `libx264 -preset veryfast -tune fastdecode -crf 23` | fast to create and decode everywhere |
| Size | longest edge 960 px, even dimensions, square pixels, rotation baked in | 960×540 for 16:9, 540×960 for Shorts |
| GOP | `-g 15 -bf 0` | seek to any frame by decoding ≤ 15 frames |
| Frame rate | CFR at the source's nominal rate (`fps` filter) | makes VFR sources scrub predictably |
| Timestamps | proxy time 0 = original media time 0 | the same `sourceTime` addresses both |
| Color | SDR BT.709 (HDR tone-mapped) | preview is SDR in v1 |
| Audio | **none**; audio is always decoded from the original | audio decode is cheap, and it removes any chance of proxy-induced audio drift |

**Lifecycle:** `none → queued → generating(progress) → ready | failed(code)`, tracked in `library.db` and mirrored to the UI. Preview uses the proxy when it's `ready` and "Use proxies" is on, and falls back to the original otherwise, including mid-generation.

**Validation:** after encoding, the proxy is probed. A duration more than one frame off from the original, or wrong dimensions, discards it and marks it `failed`.

**Hardware encoders** (NVENC/QSV/AMF, only when verified per §1.1) are an optimization for proxy speed in a later phase. The format stays the same.

---

## 6. Cache

### 6.1 Location

Default is Tauri's `app_cache_dir` (on Windows, `%LOCALAPPDATA%\com.kriti.studio\cache`). It's **user-relocatable** in Settings, because proxies need tens of GB and system drives are often small. The development machine has about 17 GB free on C:, which is exactly this case. Relocating either moves content or abandons it (it's all regenerable).

### 6.2 Layout

```
cache/
  thumbs/<ab>/<fingerprint>-poster-v1.jpg
  filmstrips/<ab>/<fingerprint>-v1/index.json, sheet-000.jpg, …
  waveforms/<ab>/<fingerprint>-s<stream>-v1.peaks
  proxies/<ab>/<fingerprint>-<profileHash>.mp4
  tmp/                                   in-progress outputs; purged at startup
```

`<ab>` is the first two hex characters of the fingerprint, which keeps directories small. The artifact key is `(fingerprint, kind, variant, generatorVersion)`. Bumping a generator's version invalidates its old artifacts, which are then evicted lazily.

### 6.3 Index: `library.db` (SQLite)

SQLite through `rusqlite` (bundled SQLite, so there's no system dependency), in WAL mode. It's owned by the `db` module on a dedicated thread (actor style) that serializes writes. Queries are tiny, so a pool isn't needed. Schema migrations use `PRAGMA user_version`.

| Table | Purpose |
|---|---|
| `media(fingerprint PK, size_bytes, sample_hash, info_json, probed_with, last_seen_path, updated_at)` | probe cache shared across projects |
| `artifacts(key PK, fingerprint, kind, variant, generator_version, rel_path, bytes, state, created_at, last_access_at)` | what exists in the cache and its state |
| `recent_projects(path PK, name, last_opened_at)` | start screen |

Losing `library.db` loses nothing but time: every row is reconstructible from media files and the cache folder.

### 6.4 Integrity and eviction

- **Atomic writes:** every artifact is written under `tmp/`, validated, renamed into place, and only then inserted into the index.
- **Startup reconciliation:** index rows without files are deleted, files without rows are deleted, and `tmp/` is purged.
- **Budgets** (configurable): proxies 50 GB, filmstrips + posters 2 GB, waveforms 1 GB. **LRU eviction** by `last_access_at`, skipping artifacts referenced by the open project.
- **Disk guard:** heavy jobs don't start when free space on the cache volume is below 5 GB, and fail with `DISK_LOW`. Export has its own check against the estimated output size.

### 6.5 In-memory caches

| Cache | Owner | Bound |
|---|---|---|
| Decoded frames `(asset, variant, frameTime, size) → RGBA` | Rust `preview` | 512 MB default, LRU by bytes |
| Recently composited timeline frames | Rust `preview` | 32 frames |
| Posters and filmstrip sheets | WebView HTTP cache via asset URLs | browser-managed |

No cache anywhere is proportional to media file size.

---

## 7. Media jobs summary

| Job | Class | Triggered by | Output | On cancel or failure |
|---|---|---|---|---|
| Probe + fingerprint | `probe` | import, relink, change detection | `library.db` row | per-file error; batch continues |
| Poster | `light` | import | JPEG | retry on next open |
| Filmstrip | `light` (low priority) | import; promoted when the clip is visible on the timeline | sprite sheets | retry on next open |
| Waveform | `light` | import (audio present) | `.peaks` | retry on next open |
| Proxy | `heavy` | proxy policy or user action | MP4 | partial file deleted; state `failed` with code |
| Relink scan | `probe` | user action | path updates | no changes |

---

## 8. Hindi and Hinglish content

- **Unicode paths** travel as `OsString` or UTF-8 end to end, with no shell involved. The generated test media set includes Devanagari file names.
- **Audio language tags** (`hin`, `eng`) are preserved in `AudioStreamInfo.language` and later seed transcription language hints (P11).
- **Embedded subtitle streams** (e.g. `mov_text`, SRT in MKV) show up in probe output and can be imported as caption tracks (P8).
