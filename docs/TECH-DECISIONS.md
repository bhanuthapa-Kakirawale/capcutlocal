# Technical Decisions

Architecture Decision Records (ADRs). Each one gives the context, the decision, its consequences, and the alternatives we rejected, so a future change can be argued against the original reasoning instead of rediscovering it.

Status values: **Accepted** (in force), **Gated** (accepted, pending a measurement at a named phase gate), **Superseded**.

| # | Decision | Status |
|---|---|---|
| 001 | Tauri 2 desktop shell | Accepted |
| 002 | Project document owned by TypeScript; Rust holds a read-only mirror | Accepted |
| 003 | Time is integer flicks | Accepted |
| 004 | FFmpeg as external processes behind one gateway | Accepted |
| 005 | One Rust renderer for preview and export; CPU compositor first | Accepted |
| 006 | Project file is JSON; SQLite for the media/cache index | Accepted |
| 007 | Undo via immutable snapshots; full-snapshot document sync | Accepted |
| 008 | Hand-written Zod IPC contracts plus shared fixtures, no codegen | Accepted |
| 009 | Preview frames over Tauri Channel (binary) | Gated (P5) |
| 010 | Zustand stores, domain logic outside React | Accepted |
| 011 | Proxy format | Accepted |
| 012 | Text rendering in Rust with bundled fonts | Accepted |
| 013 | Audio engine format and clock | Accepted |
| 014 | Test tooling | Accepted |
| 015 | Working codename and identifiers | Accepted (placeholder) |
| 016 | Toolchain and pinning | Accepted |
| 017 | Windows first, cross-platform by design | Accepted |
| 018 | Tailwind CSS v4, dark UI | Accepted |

---

### ADR-001 — Tauri 2 desktop shell

- **Context:** The app needs a rich UI (React) and a native core for media work. It must stay responsive while CPU-heavy jobs run.
- **Decision:** Tauri 2. A Rust core hosts services, and the system WebView (WebView2 on Windows) hosts the React UI.
- **Consequences:** Small installers and memory footprint. Rust handles media, process supervision, and concurrency. The capability-based permission model limits what the UI can reach. WebView engines differ per OS, but that matters little here because video pixels come from the Rust renderer (ADR-005), not from WebView codecs.
- **Rejected:** *Electron* (bundles Chromium, ~150 MB baseline, and Node native modules for media are fragile). *Fully native UI (Qt/egui)* (much slower UI iteration; the requested stack is React).

### ADR-002 — The TypeScript domain owns the project document

- **Context:** Edits must feel instant (drag, trim, keyframe). Edit operations need thorough property-based testing. Rendering and export must also run without the UI.
- **Decision:** The document and all edit operations live in pure TypeScript (`src/domain`), and Zustand holds the current version. Rust receives **immutable, revisioned snapshots** for preview and export, and keeps a read-only serde mirror of the render-relevant schema (`model`).
- **Consequences:** Edits cost no IPC round-trip. Ops are pure functions that are trivial to test with Vitest and fast-check. The cost is two schema definitions (Zod and serde) plus two copies of small math (keyframe interpolation, transforms). Both are kept identical by shared golden fixtures run in both test suites. Migrations run in TS only. Rust accepts only current-version snapshots.
- **Rejected:**
  - *Rust-owned document* (every edit becomes an async round-trip, and the UI needs a synchronized read model anyway).
  - *Rust domain compiled to WASM for the UI* (a single implementation, but it adds a WASM build and binding layer, makes debugging harder, and fights the Zod/Zustand stack). Revisit if the duplicated surface grows beyond the render mirror.

### ADR-003 — Time is integer flicks

- **Context:** Floating-point seconds accumulate error, break equality checks, and can't represent NTSC rates exactly. Frame numbers depend on a single frame rate, but media and sequences mix rates.
- **Decision:** All times are integers at 705,600,000 per second (flicks). Sequence frame rates are restricted to rates whose frame duration is an integer number of flicks.
- **Consequences:** Exact for 23.976 through 60 fps, including NTSC, and for 44.1/48 kHz samples. Safe-integer range is about 147 days. The only floats are in display and FFmpeg arguments.
- **Rejected:** *Seconds as `f64`* (drift and equality bugs). *Rational everywhere* (correct, but slow and awkward in JSON and UI code). *Premiere-style 254,016,000,000 ticks/s* (overflows JS safe integers after about 9.9 hours).

### ADR-004 — FFmpeg as external processes behind one gateway

- **Context:** FFmpeg is required for probing, decoding, and encoding. It can be linked (libav* through Rust bindings) or run as a CLI process.
- **Decision:** Run `ffmpeg`/`ffprobe` as child processes. Bundle them as Tauri sidecars in release; in development, use the configured path or `PATH`. Only the `ffmpeg` module spawns them, with typed argument builders and supervised pipes.
- **Consequences:**
  - A decoder crash fails one job, not the app.
  - No bindgen, libclang, or FFmpeg dev libraries in the build.
  - FFmpeg can be upgraded by swapping binaries.
  - GPL/LGPL obligations stay separable because FFmpeg isn't linked. The build variant for distribution (GPL with x264, or LGPL with hardware/OpenH264 encoders) is decided in the packaging phase.
  - Costs: 30–80 ms process startup on Windows, raw-frame pipe bandwidth (a limit at 4K), and no zero-copy hardware decode.
- **Upgrade path:** in-process libav decoding behind the `DecoderPool` API (RENDERING.md §3) if 4K preview demands it. The gateway stays the only FFmpeg boundary.
- **Rejected:** *Linking libav from the start* (build complexity and crash coupling before there's any measured need).

### ADR-005 — One Rust renderer for preview and export; CPU compositor first

- **Context:** Preview must match export ("what you see is what you export"). Text (including Devanagari), keyframes, and effects must look identical in both.
- **Decision:** A single pipeline in Rust: `evaluate → decode → composite`, used by both preview (proxies, reduced size, real-time pacing) and export (originals, full size, every frame). Compositor v1 is CPU-based (`tiny-skia`). A GPU (`wgpu`) backend comes in P12 behind the same entry point.
- **Consequences:** WYSIWYG by construction, deterministic pixel tests, and no GPU driver issues in v1. 1080p is fast enough on CPU. 4K export is slow until P12, a known and documented limit.
- **Rejected:**
  - *WebView preview (`<video>` + WebGL) with FFmpeg-filtergraph export:* two renderers that inevitably drift, frame-inaccurate `<video>` seeking, and codec support that varies by OS WebView.
  - *FFmpeg filtergraph as the only renderer:* the graph restarts on every edit and seek, keyframes become filter expressions, and there's no interactive text editing.
  - *GPU-first:* setup and device-loss complexity before we have evidence the CPU is insufficient.

### ADR-006 — Project file is JSON; SQLite for the media/cache index

- **Context:** "SQLite where appropriate." The document is a tree that's loaded and saved whole, while the media and artifact index is queried and updated incrementally across projects.
- **Decision:** `.kriti` project files are UTF-8 JSON with a versioned envelope, written with atomic replace plus a `.bak`. `library.db` (SQLite via `rusqlite`, bundled, WAL mode) holds probe results, the artifact index, and recent projects.
- **Consequences:** Projects are human-readable, diffable, and easy to migrate and repair. The cache index gets indexed queries and LRU eviction. Losing `library.db` only costs regeneration time.
- **Rejected:** *SQLite project files* (a relational mirror of a tree adds sync bugs, and migrations are harder to review). *JSON for the cache index* (no efficient LRU queries; concurrent writers would corrupt it).

### ADR-007 — Undo via immutable snapshots; full-snapshot document sync

- **Context:** Undo must be correct for complex ripple and multi-track operations.
- **Decision:** An immutable document built with Immer (structural sharing). History stores previous versions (200 entries). Continuous gestures use transactions to produce one entry. Rust receives whole-sequence snapshots per revision (coalesced).
- **Consequences:** Undo is correct by construction, with no inverse operations to get wrong. Memory is bounded by structural sharing. Snapshot sync costs a few ms for large sequences. Immer patches are the documented optimization if profiling demands it.
- **Rejected:** *Command pattern with inverse operations* (every op implemented twice, which is where editor undo bugs usually come from).

### ADR-008 — Hand-written Zod IPC contracts plus shared fixtures, no codegen

- **Context:** TS and Rust types at the IPC boundary must agree, and responses should be validated at runtime (Zod is part of the stack).
- **Decision:** Rust DTOs use serde (camelCase). TS mirrors them as Zod schemas in `src/ipc/`, and every response and event is parsed with Zod. Rust tests write representative payloads to `fixtures/ipc/`, and Vitest parses them.
- **Consequences:** No codegen toolchain. Drift is caught by tests, not users, and runtime validation catches anything the tests miss. The cost is manual duplication for a small DTO surface.
- **Rejected:** *tauri-specta / ts-rs codegen* (generates types but not Zod validators, and adds a toolchain that has spent a long time in pre-release for Tauri 2). Revisit if the command surface grows past about 50 commands.

### ADR-009 — Preview frames over a Tauri Channel (binary) — *Gated at P5*

- **Decision:** Deliver preview frames as raw binary over `tauri::ipc::Channel` to a `<canvas>`.
- **Gate:** sustained 960×540 at 30 fps with ≤ 5 ms transport plus draw per frame. If it fails, switch to a localhost WebSocket carrying the same binary frames. The measured result will be recorded here.

### ADR-010 — Zustand stores; domain logic outside React

- **Decision:** Separate stores for the document with history (`projectStore`), UI (`uiStore`), runtime media status (`mediaStore`), and jobs (`jobsStore`). Stores call pure `domain` functions for logic and `ipc` for effects. Components subscribe with fine-grained selectors (per track, per clip).
- **Consequences:** Logic is testable without React. Re-renders are limited to what changed, which structural sharing makes cheap to detect.
- **Rejected:** *Redux Toolkit* (more ceremony for the same model). *Logic inside components or hooks* (untestable, and couples UI to rules).

### ADR-011 — Proxy format

- **Decision:** MP4 H.264, `veryfast`, `fastdecode`, CRF 23, GOP 15 with no B-frames, longest edge 960 px, CFR at the source's nominal rate, rotation baked in, SDR, **no audio**. Proxy time equals original media time.
- **Consequences:** Seeks cost at most 15 decoded frames. VFR sources become predictable. Audio always comes from the original, which removes proxy-induced drift. Files are small enough for a 50 GB default budget.
- **Rejected:** *ProRes/DNxHR proxies* (huge files, and the system drive constraint is real). *Intra-only H.264* (roughly 3× larger for little extra benefit at this resolution).

### ADR-012 — Text rendering in Rust with bundled fonts

- **Decision:** `cosmic-text` for shaping and layout and `swash` for rasterization, inside the compositor. Bundle Noto Sans and Noto Sans Devanagari, plus a few OFL display fonts.
- **Consequences:** Correct Devanagari and mixed Hinglish shaping, identical in preview and export and on every machine.
- **Rejected:** *FFmpeg drawtext/libass* (not interactive and a second text engine). *Rendering text in the WebView and shipping bitmaps to Rust* (couples export to the UI process and to browser font differences).

### ADR-013 — Audio engine format and clock

- **Decision:** 48 kHz, f32, stereo internal format. `cpal` output. The audio device clock is the master clock during playback. `ebur128` for loudness, targeting −14 LUFS and −1 dBTP for YouTube presets.
- **Consequences:** Sample-accurate edits (14,700 flicks per sample), glitch-free playback (video drops frames, audio never waits), and platform-consistent loudness.

### ADR-014 — Test tooling

- **Decision:**
  - **Vitest** for TS unit, property (fast-check), and component tests.
  - **Playwright** in two modes: (1) against the Vite dev server with the mock `ipc` backend, for UI flows; (2) attached over CDP to the real app's WebView2 (`--remote-debugging-port` via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`), for launch smoke tests and end-to-end runs.
  - **cargo test** for Rust, with FFmpeg-dependent tests behind a `media-tests` feature.
  - Test media is **generated** with FFmpeg lavfi, never committed.
- **Consequences:** UI flows are tested fast without Rust, and the real app is still verified end to end on Windows. The CDP mode is Windows-specific. macOS and Linux E2E will use `tauri-driver` (WebDriver) when those platforms are targeted.

### ADR-015 — Working codename and identifiers (placeholder)

- **Decision:** Codename **Kriti** (Hindi कृति, "creation"). Bundle identifier `com.kriti.studio`, project extension `.kriti`, log file `kriti.log`, env prefix `KRITI_`.
- **Changing it** before first public release touches: `src-tauri/tauri.conf.json` (`productName`, `identifier`, window title), `src-tauri/Cargo.toml` (package and lib name), `package.json` (`name`), `index.html` (`<title>`), and these docs. The identifier sets the app-data directory, so changing it **after** release would need a data migration.

### ADR-016 — Toolchain and pinning

- **Decision:**
  - Node 24 LTS.
  - **pnpm** via corepack, pinned with `packageManager` in `package.json`.
  - Rust stable, pinned by `rust-toolchain.toml` (with `rustfmt` and `clippy`), MSVC target on Windows, **edition 2024**.
  - Tauri 2.x, React 19, TypeScript 6 (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Vite 8, Tailwind CSS 4, Zustand 5, Zod 4, Vitest 5, Playwright.
  - The lockfiles (`pnpm-lock.yaml`, `Cargo.lock`) are committed.
  - The release profile uses **thin LTO** with `codegen-units = 1`. Fat LTO's single-module link ran out of memory on the 8 GB reference machine while ordinary desktop apps were open. Thin LTO keeps most of the size and speed benefit with a far lower memory peak. Whether distribution builds need fat LTO (in a separate profile on a larger build machine) is measured in P6.
- **Consequences:** Reproducible builds that fit the development machine. Toolchain upgrades are deliberate commits.

### ADR-017 — Windows first, cross-platform by design

- **Context:** Development and primary users are on Windows. macOS and Linux should remain possible.
- **Decision:** Windows 10/11 x64 is the first supported platform and the only one gated in v1 tests. No Windows-only APIs outside clearly marked `#[cfg(windows)]` code (Job Objects, `CREATE_NO_WINDOW`). Paths are always `PathBuf`/`OsString`. Preview doesn't depend on WebView codecs (ADR-005).
- **Consequences:** Porting means packaging, sidecar binaries per target triple, an E2E driver, and `cfg` equivalents. No architectural change.

### ADR-018 — Tailwind CSS v4, dark UI

- **Decision:** Tailwind v4 through `@tailwindcss/vite`, with design tokens in CSS `@theme`. The UI is dark by default, as in professional editors, because a neutral dark surround avoids biasing color judgment of the video.
- **Consequences:** No component-library lock-in. Tokens give consistent spacing and color. Complex widgets (timeline, preview) are custom components regardless.
