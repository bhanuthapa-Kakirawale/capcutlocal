# Timeline

The timeline is the core of the application. Every other subsystem either feeds it (media), reads it (preview, export), or edits it (UI, AI proposals). This document fixes its data model, invariants, and edit semantics. Rendering-side evaluation is in [RENDERING.md](RENDERING.md).

Fields tagged *(Pn)* join the schema in roadmap phase *n* through a migration. The schema only contains what's implemented.

---

## 1. Time representation

All timeline and media times are **integer flicks**: 1 second = **705,600,000** flicks.

```ts
type Flicks = number & { readonly __brand: 'Flicks' };  // always Number.isSafeInteger
```
```rust
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Flicks(pub i64);
```

**Why flicks:** every common frame duration and audio sample period is an exact integer, including NTSC rates, so times never drift and equality is reliable:

| Rate | Frame (or sample) duration in flicks |
|---|---|
| 23.976 (24000/1001) | 29,429,400 |
| 24 | 29,400,000 |
| 25 | 28,224,000 |
| 29.97 (30000/1001) | 23,543,520 |
| 30 | 23,520,000 |
| 50 | 14,112,000 |
| 59.94 (60000/1001) | 11,771,760 |
| 60 | 11,760,000 |
| 48 kHz audio sample | 14,700 |
| 44.1 kHz audio sample | 16,000 |

**Range:** `Number.MAX_SAFE_INTEGER` flicks ≈ 147 days. Rust validates that every time crossing the IPC boundary fits in that range.

**Rules:**
- Seconds as floating-point exist only in display formatting and FFmpeg argument building (`ffmpeg` module, at the last moment).
- Frame rates are rationals: `type Rational = { num: number; den: number }`. Sequence frame rates come from the table above (the schema rejects others), so a sequence frame is always an integer number of flicks.
- Timeline edit positions are **quantized to the sequence frame grid** (`quantize(t) = floor(t / frameDur) * frameDur`). Source times aren't quantized to the sequence grid: a 25 fps clip in a 30 fps sequence has source positions that fall between its own frames, and the decoder picks the frame whose display interval contains the requested time (RENDERING.md §3).

## 2. Sequence

```ts
type Sequence = {
  id: SequenceId;
  name: string;
  format: SequenceFormat;
  tracks: Record<TrackId, Track>;
  videoTracks: TrackId[];      // compositing order: index 0 is the bottom layer
  audioTracks: TrackId[];      // display order (mixing is order-independent)
  captionTracks: TrackId[];    // (P8) drawn above all video tracks
  markers: Marker[];           // (P4) sorted by time
};

type SequenceFormat = {
  width: number;               // even, 16–8192
  height: number;              // even, 16–8192
  frameRate: Rational;         // one of the §1 table rates
  sampleRate: 48000;           // fixed in v1
  audioChannels: 2;            // stereo in v1
};
```

Format presets: **YouTube 1080p** 1920×1080, **Shorts** 1080×1920, **4K** 3840×2160, **Square** 1080×1080. Sequence duration is derived (the end of the last item), never stored.

## 3. Tracks and clips

Clips are stored **inside their track, sorted by `start`**. Per-track non-overlap is then a local, easily checked property, evaluation at time *t* is a binary search per track, and moving a clip between tracks is an explicit remove plus insert.

```ts
type TrackBase = { id: TrackId; name: string; locked: boolean };

type VideoTrack = TrackBase & {
  kind: 'video';
  hidden: boolean;
  clips: VisualClip[];          // sorted by start, non-overlapping
  transitions: Transition[];    // (P9) one per cut at most
};

type AudioTrack = TrackBase & {
  kind: 'audio';
  muted: boolean;
  clips: AudioClip[];
  transitions: Transition[];    // (P9) audio crossfades
  gainDb: number;               // (P10) track fader
  pan: number;                  // (P10) -1..1
  solo: boolean;                // (P10)
};

type CaptionTrack = TrackBase & {     // (P8)
  kind: 'caption';
  hidden: boolean;
  language: string;             // BCP-47: 'hi', 'en', 'hi-Latn' (romanized Hindi/Hinglish)
  style: CaptionStyle;
  cues: CaptionCue[];           // sorted, non-overlapping
};

type Track = VideoTrack | AudioTrack | CaptionTrack;
```

### 3.1 Clips

```ts
type ClipBase = {
  id: ClipId;
  start: Flicks;                // timeline position; frame-aligned, ≥ 0
  duration: Flicks;             // frame-aligned, ≥ 1 frame
  sourceIn: Flicks;             // content time at the clip's first frame (§3.2)
  linkId: LinkId | null;        // clips sharing a linkId are selected, moved, split, deleted together
  enabled: boolean;             // (P4) disabled clips are skipped by render
};

type VideoClip = ClipBase & {   // on video tracks; asset kind 'video' or 'image' (a still)
  type: 'video';
  assetId: AssetId;
  transform: Transform;         // (P7)
  opacity: Animatable<number>;  // (P7) 0..1
  effects: EffectInstance[];    // (P9) applied in order
};

type TextClip = ClipBase & {    // (P7)
  type: 'text';
  content: string;              // Unicode; Devanagari and mixed-script text are first-class
  style: TextStyle;
  transform: Transform;
  opacity: Animatable<number>;
  effects: EffectInstance[];
};

type VisualClip = VideoClip | TextClip;

type AudioClip = ClipBase & {   // on audio tracks
  type: 'audio';
  assetId: AssetId;
  streamIndex: number;          // which audio stream of the asset
  gainDb: Animatable<number>;   // static in v1; keyframes in (P10)
  fadeIn: Flicks;               // (P10)
  fadeOut: Flicks;              // (P10)
  effects: EffectInstance[];    // (P10)
};

type Transform = {              // (P7) all animatable; positions normalized to sequence size
  position: Animatable<Vec2>;   // center of the layer; (0.5, 0.5) = frame center
  scale: Animatable<Vec2>;      // 1 = fit-to-frame size (§3.4)
  rotationDeg: Animatable<number>;
  anchor: Vec2;                 // pivot in layer-normalized coords
  crop: { left: number; top: number; right: number; bottom: number };  // fractions of the source
};
```

Playback speed *(P9+)* will add `speed: Rational`, with source duration = `duration × speed`. Until then, source duration equals timeline duration.

### 3.2 Content time and the `sourceIn` rule

- **Media clips:** `sourceIn` is the media time (MEDIA-PIPELINE.md §3.2: flicks from the stream's first presentation timestamp) shown at `start`. For *t* in `[start, start + duration)`: `sourceTime = sourceIn + (t − start)`.
- **Stills and generated clips** (images, text) have an unbounded synthetic content timeline. A newly created clip has `sourceIn = 0`, and trimming the head moves `sourceIn` forward exactly like media.

This single rule lets **keyframes live in content time** (§7): trimming, splitting, and moving a clip never shifts its animation relative to its content.

**Handles** are the media available before `sourceIn` and after `sourceIn + duration`. Trims and transitions consume them. Stills and text have infinite handles.

### 3.3 Linked clips (A/V sync)

Placing a video that has audio creates a `VideoClip` and an `AudioClip` with the same `linkId`. Linked clips are selected, moved, split, and deleted together. Trimming one trims the others unless the user holds the unlink modifier (for J/L cuts). If linked clips from the same asset end up with different `sourceIn − start` offsets, the UI shows a sync-offset badge ("+3f") and offers "Resync". A link group of one member is dissolved automatically.

### 3.4 Fit rule for visual media

At `scale = 1`, a visual source is **fit** inside the sequence frame (letterbox/pillarbox, aspect preserved, after applying stream rotation and sample aspect ratio). That makes 16:9 footage in a 9:16 Shorts sequence behave predictably: the user scales up to fill and moves `position` to reframe.

## 4. Invariants

`checkInvariants(project)` returns every violation. It runs after each op in dev/test and on load and save in release.

1. **Track order lists** hold exactly the sequence's tracks of that kind, with no duplicates.
2. **Per track:** clips are sorted by `start` and don't overlap (`a.start + a.duration ≤ b.start`). The same holds for caption cues.
3. **Grid:** `start` and `duration` are non-negative multiples of the sequence frame duration, and `duration ≥ 1 frame`.
4. **Media bounds:** for `video`/`audio` assets, `0 ≤ sourceIn` and `sourceIn + duration ≤ asset.info.durationFlicks`. Image assets are unbounded.
5. **References:** `assetId` exists. The asset kind fits the track (video track: `video` or `image`; audio track: the asset has audio stream `streamIndex`).
6. **Links:** every `linkId` group has ≥ 2 clips, all in one sequence.
7. **Transitions:** each references two clips on its own track that are adjacent (`left.start + left.duration == right.start`), has enough handles on both sides (§8), and there's at most one transition per cut.
8. **Keyframes:** each animated value has ≥ 1 keyframe, times strictly increasing, and interpolation valid for the value type.

Keyframes outside a clip's visible range after a trim are **kept** (standard NLE behavior), so un-trimming restores the animation.

## 5. Edit operations

Every operation is a pure function in `src/domain/ops/`:

```ts
type EditOp<A> = (project: Project, args: A, ctx: EditContext) => Result<Project, EditError>;
type EditContext = { ids: IdGenerator };
```

Each op checks preconditions, builds the result with Immer, and in dev/test asserts invariants. Failures are values (`EditError` has a `code` such as `CLIP_LOCKED`, `OUT_OF_MEDIA_BOUNDS`, `INSUFFICIENT_HANDLES`, `COLLISION`, plus data like the maximum allowed delta so the UI can clamp). Locked tracks reject all ops on their contents.

| Operation | Semantics | Phase |
|---|---|---|
| `addTrack` / `removeTrack` / `reorderTrack` / `setTrackFlags` | Structure. Removing a non-empty track requires `force` (the UI confirms). | P4 |
| `insertClips` | Place clips at *t* on a track. `mode: 'overwrite'` trims or splits whatever is underneath; `mode: 'insert'` ripples later clips on that track and its linked tracks right by the inserted duration. | P4 |
| `moveClips` | Move a selection by Δtime and Δtrack, keeping relative positions. Same `overwrite`/`insert` modes as insert. Linked partners follow. Fails with `COLLISION` if the target track kind doesn't match. | P4 |
| `trimClip` | Move the head (changes `start`, `sourceIn`, `duration`) or tail (changes `duration`). Clamped by media bounds, neighbors, and transition handle needs, and the op returns the clamp value. `ripple: true` shifts later clips instead of leaving or overlapping gaps. | P4 |
| `splitClips` | Razor at *t* (frame-aligned) on the selected clips or all unlocked tracks. Produces two clips with new ids. Keyframes need no adjustment (content time). A split inside a transition region is rejected. | P4 |
| `deleteClips` (lift) | Remove clips and leave gaps. Transitions touching them are removed. | P4 |
| `rippleDelete` | Remove clips and close the gap on their tracks and their linked partners' tracks. Caption cues and markers after the removed range shift too (captions follow the content). | P4 |
| `closeGap` | Ripple-delete an empty range on a track. | P4 |
| `rollEdit` | Move a cut between two adjacent clips (one's tail and the next's head together). | P4 |
| `slipClip` | Change `sourceIn` without moving the clip on the timeline. | P7 |
| `slideClip` | Move a clip while trimming its neighbors to compensate. | P9 |
| `setClipProperty` / `setKeyframe` / `removeKeyframe` | Property and animation edits. | P7 |
| `addTransition` / `removeTransition` / `setTransition` | §8 | P9 |
| `addEffect` / `removeEffect` / `reorderEffect` / `setEffectParam` | RENDERING.md §8 | P9 |
| `addCaptionCues` / `editCue` / `removeCues` | Caption editing, also used to apply AI transcripts | P8 |

"Ripple" in v1 affects only the tracks involved (plus linked partners and caption tracks). A global **sync-lock** option that ripples every unlocked track is a later extension of the same op, not a new op.

## 6. Snapping

Snapping lives in `src/domain/snapping/` as pure functions. The UI supplies the pixel threshold converted to flicks at the current zoom.

- **Targets:** playhead, sequence start, clip edges on all tracks (excluding the clips being dragged), markers, and caption cue edges.
- At drag start, targets are collected once into a sorted array. Each pointer move does a binary search around each dragged edge. That's `O(k log n)` per move, independent of sequence size in practice.
- `snap(edges, targets, threshold) → { delta, target } | null` picks the target nearest any dragged edge within the threshold. The UI draws a snap line at `target`.
- Results are always quantized to the frame grid. Holding the snap-toggle key disables snapping to targets but never frame quantization.

## 7. Keyframes *(P7)*

```ts
type Animatable<T> =
  | { kind: 'static'; value: T }
  | { kind: 'animated'; keyframes: [Keyframe<T>, ...Keyframe<T>[]] };  // non-empty, sorted

type Keyframe<T> = {
  time: Flicks;                 // CONTENT time (§3.2), not timeline time
  value: T;
  interpolation: 'hold' | 'linear' | 'bezier';   // shape of the segment to the NEXT keyframe
  ease?: { x1: number; y1: number; x2: number; y2: number };  // cubic-bezier, when interpolation = 'bezier'
};
```

**Evaluation** (implemented identically in TS for the inspector and Rust for rendering, checked by the shared `fixtures/eval/keyframes.json`):
- Before the first keyframe, use its value. After the last, use the last value.
- Between `kᵢ` and `kᵢ₊₁` with `u = (t − tᵢ)/(tᵢ₊₁ − tᵢ)`: `hold` → `vᵢ`; `linear` → `lerp(vᵢ, vᵢ₊₁, u)`; `bezier` → `lerp(vᵢ, vᵢ₊₁, cubicBezier(ease, u))`.
- Value types: `number` and `Vec2` interpolate component-wise. `Color` interpolates in linear light (RENDERING.md §6). `boolean` and enums allow `hold` only.

## 8. Transitions *(P9)*

```ts
type Transition = {
  id: TransitionId;
  leftClipId: ClipId;
  rightClipId: ClipId;          // adjacent on the same track
  duration: Flicks;             // frame-aligned, > 0
  alignment: 'center' | 'start' | 'end';   // position relative to the cut
  effect: EffectInstance;       // a transition-type registry entry, e.g. 'kriti.crossfade@1'
};
```

**Semantics (handle-based, as in professional NLEs):** a transition doesn't change the timeline length or move clips. With the cut at `c`, `center` alignment covers `[c − d/2, c + d/2]`. During that range, the left clip plays past its out point (its tail handle) and the right clip starts before its in point (its head handle). If handles are too short, `addTransition` fails with `INSUFFICIENT_HANDLES { maxDuration }`, and the UI offers the maximum. Trims on clips under a transition are clamped to keep enough handles, and deleting either clip deletes the transition. Audio crossfades on audio tracks use the same structure.

## 9. Captions *(P8)*

```ts
type CaptionCue = {
  id: CaptionCueId;
  start: Flicks;                // sequence time, frame-aligned
  duration: Flicks;
  text: string;                 // may contain line breaks; any script
  words?: { start: Flicks; end: Flicks; text: string }[];   // (P11) word timings from transcription
  styleOverride?: Partial<CaptionStyle>;
};
```

Captions live on caption tracks in **sequence time**, not attached to clips. That matches how subtitle files work (SRT/VTT import and export are lossless for text and timing). Ripple edits shift cues after the edit point so captions stay on their content (§5). A caption track can be burned in at export, exported as a sidecar file, or both.

## 10. Markers *(P4)*

`Marker = { id, time: Flicks, label: string, color: MarkerColor }`. Markers are snap targets. Markers flagged as chapters become the YouTube chapter list in the export description helper *(P6+)*.

## 11. Performance design

- Derived indexes (`clipId → { trackId, index }`, per-track `start[]` arrays for binary search) are **memoized per document object**. They're recomputed only when the `Sequence` object identity changes, which Immer guarantees only happens on real edits.
- Ops copy only the tracks they touch, so structural sharing keeps unaffected tracks identical by reference. React components select per track and per clip, and unchanged tracks don't re-render.
- The timeline view virtualizes: only clips intersecting the visible time range (plus overscan) are rendered.
- **Budget:** every op < 2 ms on a 5,000-clip sequence, measured by `vitest bench` in the P4 gate.
