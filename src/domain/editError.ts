/**
 * Closed set of edit-op failure codes (docs/PROJECT-MODEL.md §7, docs/TIMELINE.md §5).
 * Grows as new ops are added; each code arrives with the op that needs it.
 */
export type EditErrorCode =
  'VALIDATION' | 'NOT_FOUND' | 'TRACK_NOT_EMPTY' | 'TRACK_LOCKED' | 'COLLISION';

export type EditError = {
  code: EditErrorCode;
  message: string;
};
