# Kriti

A production-oriented desktop video editor for YouTube, YouTube Shorts, screen recordings, AI-generated video, and Hindi/Hinglish content. "Kriti" is a working codename (see [ADR-015](docs/TECH-DECISIONS.md)).

**Status:** Phase 1 (architecture and foundation). The app launches and talks to its Rust core. It has no editing features yet. See the [roadmap](docs/ROADMAP.md).

## Design documents

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then:

| Document | Covers |
|---|---|
| [PROJECT-MODEL.md](docs/PROJECT-MODEL.md) | Project document, media references, serialization, undo/redo |
| [TIMELINE.md](docs/TIMELINE.md) | Time model, tracks, clips, invariants, edit operations |
| [MEDIA-PIPELINE.md](docs/MEDIA-PIPELINE.md) | FFmpeg integration, import, proxies, cache |
| [RENDERING.md](docs/RENDERING.md) | Preview, compositor, audio, effects, export |
| [TECH-DECISIONS.md](docs/TECH-DECISIONS.md) | Decision records |
| [ROADMAP.md](docs/ROADMAP.md) | Phases and gates |

## Prerequisites (Windows)

- Node.js 24+, with pnpm through corepack (`corepack enable pnpm`). The version is pinned in `package.json`.
- Rust via rustup. The toolchain is pinned in `rust-toolchain.toml` and installs on first use.
- Microsoft C++ Build Tools (MSVC v143 + Windows 11 SDK) and the WebView2 runtime ([Tauri prerequisites](https://tauri.app/start/prerequisites/)).
- FFmpeg 7+ on `PATH`. The media features need it from Phase 3 on.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install frontend dependencies |
| `pnpm tauri dev` | Run the app with hot reload |
| `pnpm verify` | Format check, lint, typecheck, Vitest, rustfmt, clippy, cargo test |
| `pnpm tauri build --no-bundle` | Build the release executable (`src-tauri/target/release/kriti.exe`) |
| `pnpm test:e2e` | Launch the built app and run the Playwright smoke tests against it |

Logs are written to `%LOCALAPPDATA%\com.kriti.studio\logs\kriti.<date>.log`. Set `KRITI_LOG=debug` for more detail.
