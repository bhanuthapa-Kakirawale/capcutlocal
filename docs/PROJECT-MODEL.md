# Project Model

The project document is the single source of truth for an edit. It holds **references** to media and **instructions** for combining them, never media data. The timeline part of the model (sequences, tracks, clips) is specified in [TIMELINE.md](TIMELINE.md). This document covers the document as a whole: identity, media references, serialization, migrations, validation, and undo/redo.

Types below are TypeScript. The authoritative definitions are Zod schemas in `src/domain/model/`, and TS types are inferred from them (`z.infer`). Fields tagged *(Pn)* join the schema in roadmap phase *n* through a migration. They're shown here so the design is complete, but they aren't implemented before their phase.

---

## 1. Document tree

```
ProjectFile                      envelope on disk (§5)
└─ Project
   ├─ settings
   ├─ assets: Record<AssetId, Asset>            media references (§3)
   ├─ sequences: Record<SequenceId, Sequence>   timelines (TIMELINE.md)
   ├─ sequenceOrder: SequenceId[]
   └─ activeSequenceId
```

A project can hold several sequences because a core workflow for this product is **one set of assets, several cuts**: a 16:9 YouTube video and a 9:16 Shorts version of it. Sequences share assets but never share clips.

## 2. Identifiers

- Every entity has a branded string id: `ProjectId`, `AssetId`, `SequenceId`, `TrackId`, `ClipId`, `TransitionId`, `EffectInstanceId`, `MarkerId`. Branding (`string & { __brand: 'ClipId' }`) keeps a `TrackId` from being passed where a `ClipId` is expected.
- Ids are UUID v4 from an injected `IdGenerator`. Production uses `crypto.randomUUID()`; tests use a deterministic counter, so fixtures and snapshots are stable.
- Ids are never reused and survive save/load. Copy/paste and duplicating a sequence mint new ids.
- Entities are stored in `Record<Id, Entity>` for O(1) lookup. **Order is always explicit** (`sequenceOrder`, `Sequence.trackOrder`, clips ordered by time), never implied by object key order.

## 3. Project and assets

```ts
type Project = {
  id: ProjectId;
  name: string;
  createdAt: string;                 // ISO-8601, set once
  settings: ProjectSettings;
  assets: Record<AssetId, Asset>;
  sequences: Record<SequenceId, Sequence>;
  sequenceOrder: SequenceId[];
  activeSequenceId: SequenceId;
};

type ProjectSettings = {
  defaultSequenceFormat: SequenceFormat;   // TIMELINE.md §2; used by "New sequence"
  proxyPolicy: 'auto' | 'always' | 'never';   // (P5)
};
```

There's no `modifiedAt` inside `Project`. It would change on every edit and break the "undo back to the saved state means clean" rule (§7.4). The save time lives in the file envelope.

### 3.1 Asset: a reference to media

```ts
type Asset = {
  id: AssetId;
  kind: 'video' | 'audio' | 'image';
  name: string;                        // display name; defaults to the file name, user-editable
  source: {
    path: string;                      // absolute, OS-native, as last resolved
    relativePath: string | null;       // relative to the project file's folder ('/'-separated); null if unsaved or on another drive
    fingerprint: Fingerprint;
  };
  info: MediaInfo;                     // metadata snapshot taken at import (MEDIA-PIPELINE.md §3)
};

type Fingerprint = {
  sizeBytes: number;
  modifiedMs: number;                  // change hint only, not identity
  sampleHash: string;                  // BLAKE3 of size + first/middle/last 1 MiB (MEDIA-PIPELINE.md §2)
};
```

**Why the metadata snapshot lives in the project:** the project must open and show the correct timeline even when media is offline (drive unplugged, files moved). Edits can then check clip bounds against media duration without re-probing. The snapshot refreshes on relink or when a file is detected as changed.

**Where each required media attribute lives:**

| Attribute | Location | Persisted in project? |
|---|---|---|
| path | `Asset.source.path` / `relativePath` | yes |
| duration, width, height, fps, codec, rotation, pixel format, color info | `Asset.info` (`MediaInfo`) | yes (snapshot) |
| audio streams (codec, sample rate, channels, layout, language) | `Asset.info.audio[]` | yes (snapshot) |
| thumbnail, filmstrip, waveform | cache, keyed by fingerprint | **no**, derived |
| proxy status and proxy file | cache index (`library.db`) | **no**, derived runtime state |
| online / offline / changed / unsupported | `mediaStore` (runtime, from Rust) | **no** |

Derived and runtime data stay out of the document on purpose. A project copied to another machine carries no stale cache paths, and deleting the cache never damages a project.

### 3.2 Path resolution on open

For each asset, Rust `media` checks the candidates in order: `relativePath` resolved against the project folder, then `path`. The first existing file whose `sizeBytes` and `sampleHash` match wins. A file at the right path with a different fingerprint is marked **changed** and is never silently accepted, because durations and frame positions could now be wrong. Missing media is **offline**, and the relink flow (MEDIA-PIPELINE.md §2.3) can search a user-chosen folder by fingerprint. Resolution results update `source.path` as a normal (non-undoable, dirty-marking) document change.

### 3.3 Generated media *(P8+)*

Media the app creates (TTS voice-over, AI images, extracted audio) is written as real files into `<project folder>/<project name> Media/` and imported like any other asset. The document never embeds media bytes.

---

## 4. Validation layers

| Layer | Where | Checks | When |
|---|---|---|---|
| 1. Schema | TS, Zod (`.strict()`) | shapes, types, ranges, integer-flick times (`Number.isSafeInteger`), enum values | load, save, IPC boundaries |
| 2. Invariants | TS, `checkInvariants(project)` | cross-entity rules: references resolve, no overlapping clips, transitions sit on real adjacent cuts, clips stay within media bounds (TIMELINE.md §4) | after every op in dev/test; load and save in release |
| 3. Render model | Rust, `model` | the render-relevant subset of invariants, as defense in depth | on every snapshot received |

An edit operation that would break an invariant returns an `EditError`. It doesn't produce a "fixed-up" document. Repair only happens on load, and it's reported to the user, never silent.

---

## 5. Serialization

### 5.1 File format

```json
{
  "format": "kriti.project",
  "schemaVersion": 1,
  "savedAt": "2026-09-14T10:00:00.000Z",
  "savedBy": "Kriti 0.1.0",
  "project": { "id": "…", "name": "…", "assets": {}, "sequences": {}, "…": "…" }
}
```

- UTF-8 JSON, no BOM, 2-space indentation, extension `.kriti`. It's human-readable and diffs cleanly in git. Size is negligible next to the media.
- JSON rather than SQLite for the document (ADR-006): the document is a tree that's loaded and saved whole, and atomic whole-file replacement is simpler and safer than keeping a relational mirror in sync. SQLite is used where queries and incremental updates actually matter: the cross-project media and cache index.
- Times are integer flicks (TIMELINE.md §1). Floating-point is only used for continuous parameters (opacity, gain in dB, positions in normalized units).

### 5.2 Save pipeline

```
projectStore ──serializeProject()──▶ Zod validate + invariants ──▶ JSON.stringify
     ──invoke project_save({ path, contents })──▶ Rust project module:
         1. size cap (256 MiB) and shallow envelope check (format, schemaVersion)
         2. write <name>.kriti.tmp in the same folder, flush + sync_all
         3. copy the existing <name>.kriti to <name>.kriti.bak (one generation)
         4. rename .tmp over <name>.kriti   (atomic replace on NTFS/APFS/ext4)
```

A crash at any step leaves either the old file or the new file, never a torn one. The store records which in-memory `Project` object was saved, for dirty tracking (§7.4).

### 5.3 Load pipeline

```
invoke project_open(path) ──▶ Rust reads bytes (size cap), returns text + file metadata
   ──▶ TS: JSON.parse ──▶ envelope check ──▶ migrate(schemaVersion → current)
   ──▶ Zod parse (strict) ──▶ checkInvariants ──▶ Result<Project, LoadError>
```

- `LoadError` carries the JSON path of the failure (from Zod issue paths), so a corrupt file produces an actionable message.
- `schemaVersion` newer than this build supports → refuse with "created with a newer version of Kriti". Never partially load. Never write back.
- A failed load never modifies the file on disk.

### 5.4 Forward compatibility and strictness

Core objects are strict: unknown keys are errors. That catches bugs and incomplete migrations early. The one deliberate exception is effect instances: an effect id unknown to this build keeps its `params` as opaque JSON, round-trips untouched, and renders as bypass with a warning (RENDERING.md §8). This lets projects move between app versions without destroying work.

---

## 6. Autosave and crash recovery

- When the document is dirty, an autosave runs every 60 s and on window blur. It writes to `<app-data>/autosave/<projectId>/<timestamp>.kriti` and keeps the newest 10 per project. **Autosave never touches the user's file.**
- Unsaved new projects are autosaved too.
- A session lock file (`<app-data>/session.lock`) is created at launch and removed on clean exit. On launch, if a stale lock exists and an autosave is newer than the project's last save, the app offers to restore it. The user always chooses; recovery never overwrites anything automatically.
- Autosaves older than 7 days for projects that were saved since are pruned.

---

## 7. Undo / redo

### 7.1 Model: immutable snapshots with structural sharing

The document is immutable. Edit operations are pure functions built with Immer's `produce`, so an edit allocates only the path from the root to what changed and shares everything else with the previous version. History is a list of those versions:

```ts
type HistoryEntry = { project: Project; label: string; selection: SelectionSnapshot };
type History = { past: HistoryEntry[]; present: Project; future: HistoryEntry[] };
```

- `dispatch(op)` runs the op against `present`. On `Err`, nothing changes and the error is surfaced. On `Ok`, the old `present` is pushed onto `past` (with the op's label and the selection at that time), `future` is cleared, and `revision` increments.
- `undo`/`redo` move entries between the stacks and restore the selection saved in the entry. Undoing a delete reselects the restored clips.
- Limits: 200 entries. Memory stays bounded because entries share structure. A 1,000-clip project edited 200 times holds roughly one document plus 200 changed paths.

**Why snapshots instead of do/undo command pairs** (ADR-007): every inverse command is a second implementation of an edit that can disagree with the first. Ripple and multi-track operations are notorious for this. Snapshots make undo correct by construction. Named operations still exist as the unit of dispatch, labels ("Undo Ripple Delete"), logging, and tests.

### 7.2 Transactions for continuous interactions

A clip drag, slider scrub, keyframe drag, or text typing burst must become **one** undo step while still updating the preview live:

```ts
const tx = store.beginTransaction('Move clip');
tx.update(moveClipOp(…));   // repeated during the drag; updates present and revision, not history
tx.commit();                // pushes a single history entry (the pre-drag snapshot)
// or tx.cancel();          // restores the pre-drag snapshot, e.g. on Escape
```

Only one transaction can be open at a time. Starting a new one commits any open transaction first.

Because dirty tracking and the "skip a no-op edit" optimization are both reference-based (§7.4), they only recognize a no-op when a *single* op call leaves the document unchanged (Immer's `produce` returns the original object in that case). A transaction whose updates net back to the original content across *several* calls — e.g. renaming to "A" then back to the original name — still commits one history entry: each call is a separate `produce`, so the final object is a different reference even though its content is equal. Only `undo` restores the exact stored reference.

Discrete repeated actions on the same target within 500 ms (arrow-key nudges, repeated "+1 frame") merge into the previous entry when the op declares a `mergeKey`.

### 7.3 What is and isn't undoable

| Undoable (document) | Not undoable (not document) |
|---|---|
| all timeline edits, keyframes, effects, text | selection, zoom, scroll, panel layout, playhead |
| importing media (adds an asset reference) | cache contents, proxy generation, jobs |
| removing unused assets from the project | files on disk (never touched) |
| sequence create/delete/rename/settings | relink path updates (§3.2) are dirty-marking but not undoable |

### 7.4 Dirty state

`dirty = history.present !== savedProject`, compared by object identity. Undoing back to exactly the saved version makes the project clean again, and a redo makes it dirty. No counters that drift.

### 7.5 Revision and synchronization

`revision` increases on every change to `present` (including undo, redo, and transient transaction updates). It's the version number sent to Rust with each document snapshot (ARCHITECTURE.md §5.3), so preview frames can be matched to the document state they depict.
