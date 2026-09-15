import type { IdGenerator } from './ids';
import { newProjectId, newSequenceId } from './ids';
import type { Project, Sequence, SequenceFormat } from './model';

/** Builds a brand-new, empty project with one sequence in `format`. Not an edit op: this is
 * initial state construction ("File > New"), not an undoable change to an existing document. */
export function createProject(
  ids: IdGenerator,
  args: { name: string; format: SequenceFormat; sequenceName?: string },
): Project {
  const sequenceId = newSequenceId(ids);
  const sequence: Sequence = {
    id: sequenceId,
    name: args.sequenceName ?? 'Sequence 1',
    format: args.format,
    tracks: {},
    videoTracks: [],
    audioTracks: [],
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
