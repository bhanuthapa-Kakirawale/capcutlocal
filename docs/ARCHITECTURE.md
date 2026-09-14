# Architecture

Working codename: **Kriti** (placeholder; see TECH-DECISIONS.md, ADR-015).

This document is the entry point to the design. Details live in:

| Document | Covers |
|---|---|
| [PROJECT-MODEL.md](PROJECT-MODEL.md) | Project document, media asset references, IDs, serialization, migrations, undo/redo |
| [TIMELINE.md](TIMELINE.md) | Time representation, sequences, tracks, clips, invariants, edit operations, keyframes, transitions |
| [MEDIA-PIPELINE.md](MEDIA-PIPELINE.md) | FFmpeg integration, import/probe, thumbnails, waveforms, proxies, cache, media jobs |
| [RENDERING.md](RENDERING.md) | Timeline evaluation, compositor, preview playback, audio engine, export, effects/plugins, text |
| [TECH-DECISIONS.md](TECH-DECISIONS.md) | Architecture decision records (ADRs) with rationale and rejected alternatives |
| [ROADMAP.md](ROADMAP.md) | Phased implementation plan with exit criteria and validation gates |

---

## 1. Non-negotiable principles

1. **Non-destructive.** Original media files are opened read-only and never written, moved, or renamed. The project stores references plus editing instructions.
2. **The document is the single source of truth.** Everything else is derived (thumbnails, waveforms, proxies, preview frames, caches) and can be deleted and regenerated at any time without losing work.
3. **The UI thread never does heavy work.** React renders UI and edits a small JSON-like document. Decoding, compositing, encoding, hashing, and analysis all run in Rust or in FFmpeg child processes.
4. **FFmpeg lives behind one gateway.** Only the Rust `ffmpeg` module spawns `ffmpeg`/`ffprobe`. No other module builds command lines.
5. **One renderer.** Preview and export run the same evaluation and compositing code, so what you see is what you export (RENDERING.md).
6. **Exact time.** Timeline time is an integer (flicks), never a floating-point number of seconds (TIMELINE.md §1).
7. **Designed for 4K, shipped at 1080p.** Nothing in the model or pipeline assumes 1080p. The 4K limits (CPU compositing, pipe bandwidth) are known and have a planned upgrade path.
8. **Add structure when a feature needs it.** No empty modules, no interfaces with a single hypothetical implementation, no speculative fields. Versioned migrations make later additions cheap.

---

## 2. System overview

```
┌──────────────────────────── Tauri application process ─────────────────────────────┐
│                                                                                     │
│  WebView (UI thread)                         Rust core (tokio + worker threads)     │
│  ┌──────────────────────────────┐   IPC      ┌───────────────────────────────────┐  │
│  │ React views (features/*)      │ commands  │ commands/  (thin handlers)         │  │
│  │   ▲ selectors                 │──────────▶│    │                               │  │
│  │ Zustand stores (state/*)      │           │    ▼                               │  │
│  │   ▲ dispatch(op)              │◀──────────│ services:                          │  │
│  │ domain/ (pure TS):            │  events,  │  project  media  jobs  cache       │  │
│  │   model, edit ops, history    │  channels │  preview  export  (ai, later)      │  │
│  │ ipc/ (typed, Zod-validated)   │           │    │                               │  │
│  └──────────────────────────────┘           │    ▼                               │  │
│     preview <canvas> ◀── frames ─────────────│ engine: evaluate → composite       │  │
│                                              │ ffmpeg/: the only process spawner  │  │
│                                              └──────────────┬────────────────────┘  │
└─────────────────────────────────────────────────────────────┼───────────────────────┘
                                                              │ stdin/stdout pipes
                                         ┌────────────────────▼─────────────────────┐
                                         │ ffmpeg / ffprobe child processes          │
                                         │ (probe, decode, thumbnails, proxies,      │
                                         │  encode). A crash kills one job, not the  │
                                         │  app.                                     │
                                         └──────────────────────────────────────────┘
Storage:  project file (*.kriti, JSON)  ·  app data: library.db (SQLite), autosaves, logs
          cache dir (user-relocatable): thumbnails, waveforms, proxies, temp renders
```

### 2.1 Who owns what

| State | Owner | Persistence | Notes |
|---|---|---|---|
| Project document (sequences, tracks, clips, asset refs) | **TS `domain` + `projectStore`** | `*.kriti` JSON via Rust atomic write | Only the UI edits it, and only through edit operations. |
| Undo/redo history | TS `projectStore` | memory only | Immutable snapshots with structural sharing. |
| UI state (selection, zoom, panels, playhead) | TS `uiStore` | selected bits in settings | Never stored in the project file. |
| Document mirror for rendering | Rust `preview` / `export` | none | Receives versioned snapshots, never edits them. |
| Media metadata cache, artifact index | Rust `media` / `cache` | `library.db` (SQLite) | Keyed by file fingerprint and shared across projects. |
| Derived artifacts (thumbs, waveforms, proxies) | Rust `cache` | cache dir | Always regenerable. |
| Runtime media status (online/offline, proxy progress) | Rust, mirrored to TS `mediaStore` via events | none | Never stored in the project file. |
| Jobs (import, proxy, export) | Rust `jobs` | none (re-derived on restart) | TS mirrors a read-only view. |

**Why the document lives in TypeScript** (full reasoning in ADR-002): edits must feel instant, the edit operations and their tests are pure functions that are easiest to write and property-test in TS, and the chosen stack (Zustand, Zod, Vitest) is built around that. Rust gets **immutable, revisioned snapshots** of the document for rendering and export. The price is a second, read-only model of the render-relevant schema in Rust. Shared golden fixtures keep the two in step (§10).

---

## 3. Module boundaries

### 3.1 Frontend (`src/`)

| Module | Responsibility | May import |
|---|---|---|
| `domain/` | Pure TypeScript: Zod schemas, types, time math, edit operations, invariants, history, migrations, snapping math. **No React, no Tauri, no I/O, no `Date.now()`/random without injection.** | `lib/`, `zod`, `immer` |
| `ipc/` | The **only** module that imports `@tauri-apps/api`. Typed command wrappers, Zod response validation, event subscriptions, error mapping. Gains a mock backend for browser-only Playwright flows in P4. | `domain/` (types only), `lib/` |
| `state/` | Zustand stores: `projectStore` (document + history + revision), `uiStore`, `mediaStore`, `jobsStore`. Stores call `domain` for logic and `ipc` for effects. | `domain/`, `ipc/`, `lib/` |
| `features/<name>/` | UI for one feature (timeline, preview, media-browser, inspector, export, captions). Features never import each other; shared pieces move to `components/`. | `state/`, `domain/` (types + pure helpers), `components/`, `lib/` |
| `components/` | Presentational, reusable UI with no store access. | `lib/` |
| `app/` | Shell, layout, providers, bootstrapping. | everything above |
| `lib/` | Small generic utilities (`Result`, `assertNever`, formatting). | nothing internal |

ESLint (`no-restricted-imports`) enforces these rules so a violation fails CI instead of relying on code review.

### 3.2 Rust (`src-tauri/src/`)

| Module | Responsibility | Depends on |
|---|---|---|
| `commands/` | Thin IPC handlers: deserialize, call a service, map errors to `AppError`. No business logic. | services, `error` |
| `error` | `AppError` (serializable IPC envelope) and conversions from module errors. | — |
| `logging` | `tracing` subscriber, rolling files, frontend log sink. | — |
| `project` | Atomic project file I/O, autosave ring, crash recovery. Treats the document as validated JSON. | `error` |
| `ffmpeg` | Locates binaries, builds typed command lines, spawns and supervises child processes, parses progress and stderr, handles cancellation. **The only spawner of processes.** | `error` |
| `media` | Import, fingerprinting, probe → `MediaInfo`, relinking. | `ffmpeg`, `db`, `cache`, `jobs` |
| `jobs` | Scheduler: priority queues per resource class, cancellation, progress throttling. | — |
| `cache` | Artifact paths, size budgets, LRU eviction, integrity reconciliation. | `db` |
| `db` | SQLite connection, migrations, and queries for `library.db`. | — |
| `model` | Read-only serde mirror of the render-relevant document schema, plus validation. | — |
| `engine` | Pure timeline evaluation (`evaluate(seq, t) → FramePlan`), compositor, audio mixer. **No Tauri, no I/O.** | `model` |
| `preview` | Playback state machine, decoder pool, frame transport, audio output. | `engine`, `ffmpeg`, `cache` |
| `export` | Export jobs: evaluate → composite → encode, loudness pass, muxing. | `engine`, `ffmpeg`, `jobs` |

Dependency direction is strictly `commands → services → (engine | ffmpeg | db)`. `engine` and `model` are the candidates for extraction into their own workspace crates. That happens when they have code and a second consumer (a headless render CLI or benchmarks), not before. The Tauri-free boundary exists so `cargo test` for the engine is fast and needs no WebView.

---

## 4. Folder structure (target)

Items marked *(Pn)* appear in roadmap phase *n*. Nothing is created before its phase.

```
/
├─ docs/                      Architecture documents (this folder)
├─ src/                       Frontend (React + TS)
│  ├─ app/                    Shell, layout, bootstrap
│  ├─ domain/          (P2)   model/ time/ ops/ history/ migrations/ snapping/
│  ├─ ipc/                    invoke.ts, commands.ts, contracts.ts (Zod); events (P3), mock backend (P4)
│  ├─ state/           (P2)   projectStore, uiStore, mediaStore (P3), jobsStore (P3)
│  ├─ features/        (P3+)  media-browser/ timeline/ preview/ inspector/ export/ captions/
│  ├─ components/             Shared presentational components
│  ├─ lib/                    Result, assertNever, formatting
│  └─ test/                   Test utilities, fixture loaders
├─ src-tauri/                 Rust core (Tauri app crate)
│  ├─ src/                    main.rs, lib.rs, commands/, error.rs, logging.rs, then per-phase modules
│  ├─ capabilities/           Tauri permission sets
│  ├─ icons/
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ fixtures/                  Golden fixtures read by Vitest and cargo test: ipc/ (P1), projects/ and eval/ (P2+)
├─ e2e/                       Playwright tests: real app over CDP (P1), browser flows on the mock backend (P4)
├─ scripts/           (P3)   Dev scripts (e.g. generate test media with ffmpeg lavfi)
└─ package.json, pnpm-lock.yaml, vite.config.ts, tsconfig*.json, eslint.config.js, rust-toolchain.toml
```

Test media is **generated** by scripts (`ffmpeg -f lavfi testsrc2/sine`, plus VFR and rotated variants), never committed as binaries.

---

## 5. IPC architecture

Three Tauri 2 mechanisms, each with one job:

| Mechanism | Use | Examples |
|---|---|---|
| **Commands** (`invoke`, request/response, async) | Every UI-initiated action and query | `app_info`, `project_save`, `media_import`, `job_cancel`, `preview_seek` |
| **Events** (Rust → all listeners) | Low-rate state-change notifications | `media:updated`, `job:progress`, `job:finished`, `project:autosaved` |
| **Channels** (`tauri::ipc::Channel`, ordered stream bound to one call) | High-rate or large streams | preview frames, per-export progress, waveform chunks |

### 5.1 Contract rules

- Command names are `snake_case` `<domain>_<verb>`. Events are `<domain>:<name>`.
- Payloads are JSON with `camelCase` keys (`#[serde(rename_all = "camelCase")]`).
- **Every command response and event payload is validated with Zod** in `ipc/` before it reaches stores. Rust structs and Zod schemas are written by hand. They stay in sync through **contract fixtures**: Rust tests serialize representative responses to `fixtures/ipc/*.json`, and Vitest parses the same files with the Zod schemas. Drift fails a test, not a user session (ADR-008).
- Time values cross the boundary as integer flicks (JSON numbers). Rust asserts `|v| ≤ 2^53−1`.
- Binary data (waveform peaks, frames) uses raw IPC payloads (`tauri::ipc::Response` / channel bytes), never base64-in-JSON.
- The UI never receives raw file contents it didn't ask for. Images for display (thumbnails) are served from the cache directory through Tauri's asset protocol, scoped to the cache dir only.

### 5.2 Error envelope

Every command returns `Result<T, AppError>`. `AppError` serializes as:

```json
{ "code": "MEDIA_UNSUPPORTED_CODEC", "message": "…human readable…", "retryable": false, "details": { "path": "…" } }
```

`code` is a closed, documented enum (TS: string-literal union validated by Zod). The `ipc` layer converts rejections into a typed `IpcError`, so callers can `switch` on `code`.

### 5.3 Document synchronization

The TS store owns the document and bumps a monotonic `revision` on every committed edit. After a commit it sends `preview_set_document({ revision, sequence })` (coalesced to at most one in flight). Rust renders only the latest revision and tags every frame with the revision it used, so the UI can ignore stale frames. For v1, full snapshots are fine: a 1,000-clip sequence is a few hundred KB of JSON. Immer patches are the documented upgrade if profiling shows serialization cost (ADR-007).

### 5.4 Security

- Tauri capabilities grant the main window only the commands it needs. No generic filesystem plugin is exposed to the WebView. All file access goes through typed Rust commands on paths the user chose via the native dialog or that appear in the open project.
- Strict CSP: no remote scripts. The asset protocol scope is limited to the cache directory.
- Secrets (future AI API keys) live in the OS keychain, stay in Rust, and are never sent to the WebView or written to project files or logs.

---

## 6. Background work and concurrency

| Execution context | Runs | Must never |
|---|---|---|
| WebView main thread | React render, store updates, pure edit ops (µs–ms) | decode, hash, parse large files, loop over media |
| Tauri main thread (event loop) | window events | block. All commands are `async` or offloaded. |
| Tokio async runtime | IPC handlers, process supervision, file I/O orchestration | run CPU-bound loops (use `spawn_blocking` or a dedicated thread) |
| Dedicated threads | compositor, audio mixer (real-time), waveform reduction, fingerprint hashing | allocate or lock on the audio callback path |
| FFmpeg child processes | probe, decode, encode, proxy, thumbnail | be spawned by anything but `ffmpeg/` |

### 6.1 Job scheduler (`jobs`)

- A job has: `id`, `kind`, `resourceClass`, `priority`, `state` (`queued | running | succeeded | failed | cancelled`), `progress` (0–1 or indeterminate), and a `CancellationToken`.
- **Resource classes** cap concurrency independently, so a long proxy never starves the thumbnails that make the UI feel alive:

  | Class | Default concurrency | Jobs |
  |---|---|---|
  | `probe` | 4 | ffprobe, fingerprint |
  | `light` | 2 | poster thumbnail, filmstrip, waveform |
  | `heavy` | 1 | proxy generation, loudness analysis |
  | `export` | 1 | export. While running, `heavy` pauses to keep export fast. |

- **Priorities:** jobs for assets visible in the UI or on the timeline near the playhead are promoted. The UI tells Rust which assets are visible.
- **Cancellation** kills the FFmpeg child, deletes partial outputs (all outputs are written to a temp name, then atomically renamed), and reports `cancelled`.
- **Progress** comes from FFmpeg `-progress pipe:` output and is throttled to ≤ 10 events/s per job.
- **Restart behavior:** jobs aren't persisted. On launch, the cache index tells us which artifacts exist, and missing ones for open-project assets are re-enqueued. Export jobs aren't resumed; the user restarts them.

---

## 7. Error handling

**Classes of failure, and what happens:**

| Class | Examples | Handling |
|---|---|---|
| Expected, user-recoverable | missing media, unsupported codec, disk full, file locked | Typed error code → actionable UI message (relink, free space, retry). Document unaffected. |
| Environment | FFmpeg missing or too old, no GPU encoder | Detected at startup and on first use. Settings screen shows status. The feature degrades (software encode) or is disabled with an explanation. |
| External process failure | FFmpeg crash or non-zero exit | Job fails with code + last 50 stderr lines. The full stderr goes to the job log. The app keeps running. |
| Invalid document | corrupt or newer-version project file | Refuse to open, or open with repair report. Never silently drop data. Never overwrite the original on failed load. |
| Programmer bug | invariant violation, unreachable state | Dev/test: throw or panic loudly. Release: reject the edit, log with context, keep the previous document. |

**Rust rules:** each module defines its own error enum with `thiserror`. `commands/` maps them to `AppError`. `unwrap()`/`expect()` are forbidden outside tests (`clippy::unwrap_used`, `clippy::expect_used` = deny), except with a written justification. Panics in worker threads are caught at the job boundary and turned into a failed job.

**TypeScript rules:** expected failures are values (`Result<T, E>` discriminated unions from `lib/result.ts`), not exceptions. Edit operations return `Result<Document, EditError>`. Exceptions mean bugs. Each top-level panel has a React error boundary, so a broken inspector doesn't take down the timeline. `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are on.

**Never lose work:** autosave runs independently of the main save path (PROJECT-MODEL.md §6). A failed save leaves the previous file intact (atomic rename).

---

## 8. Logging and diagnostics

- **Rust:** `tracing` with structured fields, and `tracing-appender` writing daily-rotated files to `<app-log-dir>/kriti.<yyyy-mm-dd>.log` (14 files kept). A panic hook routes panics into the same log, since release builds have no console. Release default level is `info` (`warn` for noisy crates). Level is configurable via `KRITI_LOG` (env-filter syntax).
- **Frontend:** a small logger in `lib/` batches entries and sends them through `log_write` to the same `tracing` pipeline with `target = "ui"`, so one file shows the whole story. It also mirrors to the console in dev. Uncaught errors and unhandled rejections are captured.
- **FFmpeg:** each job's full command line and stderr go to `<app-log-dir>/jobs/<job-id>.log`. The main log records the job summary (kind, duration, exit status) plus the log path.
- **Correlation:** every job and every IPC command that starts work gets an id. That id appears in UI error messages ("Export failed — details: job 7f3a…"), in `tracing` spans, and in job log file names.
- **Privacy:** media paths are logged (needed for support). API keys, auth tokens, and file contents are never logged. A redaction helper wraps any secret-carrying type (`Secret<T>`, whose `Debug` prints `***`).
- **Later:** a "Collect diagnostics" action zips recent logs, app/FFmpeg versions, and system info for bug reports (no media).

---

## 9. Performance budgets

These are acceptance criteria for the phases that implement them (ROADMAP.md).

| Operation | Budget |
|---|---|
| UI frame during timeline drag (1,000 clips) | < 16 ms (60 fps); edit op + store update < 2 ms |
| Edit commit → updated preview frame (cached decode) | < 50 ms |
| Import: file appears in the media browser with metadata | < 1 s per file (probe only); thumbnails stream in after |
| Scrub on proxy media | ≥ 15 updated frames/s |
| Playback at 1080p timeline (proxies) | real-time without dropped audio; video frame drops < 1% |
| App cold start to interactive | < 2 s |
| Memory | never proportional to media file size; decoded-frame cache is capped (default 512 MB) |

---

## 10. Testing strategy

| Layer | Tool | What | When |
|---|---|---|---|
| Domain (TS) | Vitest + fast-check | Every edit op: example tests plus property tests (random op sequences keep invariants; `undo(redo(s)) = s`; serialization round-trips) | every commit |
| Schema/migrations | Vitest | Every historical `fixtures/projects/v*/` file migrates to current and validates | every commit |
| IPC contracts | cargo test + Vitest | Rust emits `fixtures/ipc/*.json`, Zod parses them | every commit |
| Engine (Rust) | cargo test | `evaluate()` golden fixtures (`fixtures/eval/`), keyframe interpolation parity with TS, compositor pixel tests with tolerance | every commit |
| FFmpeg integration | cargo test (`--features media-tests`) | probe, thumbnail, proxy, export on generated test media (CFR, VFR, rotated, HDR-tagged, audio-only, image) | CI and before release |
| Render golden | cargo test | Export fixture timelines → compare selected frames to reference PNGs (PSNR threshold), audio to reference loudness | CI |
| UI components | Vitest + Testing Library (jsdom) | Non-trivial components (timeline interactions, inspector) | every commit |
| UI flows (from P4) | Playwright → Vite dev server with mock `ipc` backend | Import → edit → undo → export dialog flows, no Rust needed | every commit |
| App smoke (E2E) | Playwright over CDP → real app (WebView2 `--remote-debugging-port`) | The built app launches, IPC round-trips, a real import and a short export work | before merge to main / release |
| Performance | Vitest bench + cargo bench | Edit op latency on 1k/5k-clip sequences; evaluate and composite frame times | per phase gate |

**Rules:** a bug fix starts with a failing test. Tests never depend on a developer's local media. FFmpeg-dependent tests are feature-gated so `cargo test` runs anywhere. Every phase gate runs: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `cargo clippy -D warnings`, `cargo test`, `pnpm tauri build` (or the debug build), and an app launch smoke test.

---

## 11. Plugins and effects (summary)

Effects, transitions, and generators are **registry entries** identified by `namespace.name@version`. Each entry has a parameter schema (types, ranges, defaults, animatable yes/no). The render implementation is in the Rust engine. The UI gets the catalog over IPC (`effects_list`), builds inspector controls and Zod validators from it, and never hard-codes effect UIs. Unknown effects in a document (made by a newer version) are **preserved byte-for-byte and bypassed with a warning**, never dropped. Third-party plugins are future work and will be data plus sandboxed shaders, never native DLLs loaded in-process. Details: RENDERING.md §8.

## 12. AI provider abstraction (future, designed now)

AI features (Hindi/Hinglish transcription → captions, transliteration, translation, title and chapter suggestions, TTS voice-over, image generation) plug in through **capability-specific Rust traits**, not one "AI" interface:

```rust
trait Transcriber   { async fn transcribe(&self, audio: AudioSource, opts: TranscribeOpts) -> Result<Transcript, AiError>; }
trait TextGenerator { async fn generate(&self, req: TextRequest) -> Result<TextResponse, AiError>; }
trait SpeechSynth   { async fn synthesize(&self, req: TtsRequest) -> Result<AudioFile, AiError>; }
```

- Each provider (local Whisper-family model, cloud APIs such as Anthropic Claude for text, Indic-specialized speech providers) implements only the capabilities it has. A registry picks one per capability from user settings.
- AI calls run as **jobs** in the scheduler, so they're cancellable, show progress, and never block the UI.
- **AI never edits the document directly.** Results (e.g. a `Transcript` with word timings) come back to TS as a *proposal*, and applying it is a normal edit operation: one undo step, fully reviewable.
- Audio for transcription is extracted by the `ffmpeg` gateway (16 kHz mono) and cached by fingerprint, so re-runs are cheap.
- Keys live in the OS keychain. Before any upload, the UI says which provider receives which media.
- None of this is built until the AI phase (ROADMAP.md). The shape is recorded now so captions and timeline design leave room for word-level timing (TIMELINE.md §7).
