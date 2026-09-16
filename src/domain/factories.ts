import type { IdGenerator } from './ids';
import { newProjectId, newSequenceId, newTrackId } from './ids';
import type { Project, Sequence, SequenceFormat } from './model';

/**
 * Builds a brand-new project with one sequence in `format`, seeded with one video and
 * one audio track (V1/A1) — every real NLE's "New Project" starts with usable tracks,
 * not an empty timeline the user must first build structure into. Not an edit op: this
 * is initial state construction ("File > New"), not an undoable change to a document.
 */
export function createProject(
  ids: IdGenerator,
  args: { name: string; format: SequenceFormat; sequenceName?: string },
): Project {
  const sequenceId = newSequenceId(ids);
  const videoTrackId = newTrackId(ids);
  const audioTrackId = newTrackId(ids);
  const sequence: Sequence = {
    id: sequenceId,
    name: args.sequenceName ?? 'Sequence 1',
    format: args.format,
    tracks: {
      [videoTrackId]: {
        id: videoTrackId,
        name: 'V1',
        locked: false,
        kind: 'video',
        hidden: false,
        clips: [],
      },
      [audioTrackId]: {
        id: audioTrackId,
        name: 'A1',
        locked: false,
        kind: 'audio',
        muted: false,
        clips: [],
      },
    },
    videoTracks: [videoTrackId],
    audioTracks: [audioTrackId],
    markers: [],
  };
  return {
    id: newProjectId(ids),
    name: args.name,
    createdAt: new Date().toISOString(),
    settings: { defaultSequenceFormat: args.format, proxyPolicy: 'auto' },
    assets: {},
    sequences: { [sequenceId]: sequence },
    sequenceOrder: [sequenceId],
    activeSequenceId: sequenceId,
  };
}
