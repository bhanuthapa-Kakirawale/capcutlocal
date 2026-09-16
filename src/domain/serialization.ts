import { z } from 'zod';
import { describeUnknown } from '../lib/describe';
import { err, ok, type Result } from '../lib/result';
import { checkInvariants, type InvariantViolation } from './invariants';
import {
  CURRENT_SCHEMA_VERSION,
  PROJECT_FILE_FORMAT,
  ProjectFileSchema,
  ProjectSchema,
  type Project,
  type ProjectFile,
} from './model';

/*
 * Save/load pipeline and migration framework (docs/PROJECT-MODEL.md §5). Rust owns the
 * actual file I/O (atomic write, autosave); this module only validates and converts
 * between a `Project` and the JSON text that goes on disk.
 */

export type SerializeError =
  { kind: 'invariant'; violations: InvariantViolation[] } | { kind: 'schema'; message: string };

/** Validates `project`, wraps it in the file envelope, and serializes it to pretty JSON. */
export function serializeProject(
  project: Project,
  savedBy: string,
): Result<string, SerializeError> {
  const violations = checkInvariants(project);
  if (violations.length > 0) return err({ kind: 'invariant', violations });

  const envelope: ProjectFile = {
    format: PROJECT_FILE_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    savedBy,
    project,
  };
  // Defense in depth: the envelope should already be valid given the checks above.
  const parsed = ProjectFileSchema.safeParse(envelope);
  if (!parsed.success) return err({ kind: 'schema', message: z.prettifyError(parsed.error) });
  return ok(JSON.stringify(parsed.data, null, 2) + '\n');
}

export type LoadError =
  | { kind: 'parse'; message: string }
  | { kind: 'envelope'; message: string }
  | { kind: 'unsupported-version'; fileVersion: number; supportedVersion: number }
  | { kind: 'schema'; message: string }
  | { kind: 'invariant'; violations: InvariantViolation[] };

/** Just enough of the envelope to decide the file's version before full validation. */
const EnvelopeShellSchema = z.looseObject({
  format: z.string(),
  schemaVersion: z.number().int().positive(),
  project: z.unknown(),
});

type Migration = { fromVersion: number; migrate: (project: unknown) => unknown };

/**
 * v1 → v2 (P4, docs/TIMELINE.md §4 & §10): adds `enabled: true` to every clip (P4's skip
 * flag) and `markers: []` to every sequence. Written defensively over `unknown` — a
 * shape this doesn't recognize is left alone, and `ProjectSchema.safeParse` reports the
 * resulting mismatch as a normal 'schema' load error rather than this throwing.
 */
function migrateV1ToV2(project: unknown): unknown {
  if (typeof project !== 'object' || project === null) return project;
  const asRecord = project as Record<string, unknown>;
  if (typeof asRecord.sequences !== 'object' || asRecord.sequences === null) return project;

  const sequences: Record<string, unknown> = {};
  for (const [sequenceId, sequence] of Object.entries(
    asRecord.sequences as Record<string, unknown>,
  )) {
    sequences[sequenceId] = migrateSequenceV1ToV2(sequence);
  }
  return { ...asRecord, sequences };
}

function migrateSequenceV1ToV2(sequence: unknown): unknown {
  if (typeof sequence !== 'object' || sequence === null) return sequence;
  const asRecord = sequence as Record<string, unknown>;
  if (typeof asRecord.tracks !== 'object' || asRecord.tracks === null) {
    return { ...asRecord, markers: [] };
  }

  const tracks: Record<string, unknown> = {};
  for (const [trackId, track] of Object.entries(asRecord.tracks as Record<string, unknown>)) {
    tracks[trackId] = migrateTrackV1ToV2(track);
  }
  return { ...asRecord, tracks, markers: [] };
}

function migrateTrackV1ToV2(track: unknown): unknown {
  if (typeof track !== 'object' || track === null) return track;
  const asRecord = track as Record<string, unknown>;
  if (!Array.isArray(asRecord.clips)) return track;

  const clips = asRecord.clips.map((clip: unknown) =>
    typeof clip === 'object' && clip !== null ? { ...clip, enabled: true } : clip,
  );
  return { ...asRecord, clips };
}

/** Keyed by the version each migration migrates FROM (docs/PROJECT-MODEL.md §5.4). */
const MIGRATIONS: readonly Migration[] = [{ fromVersion: 1, migrate: migrateV1ToV2 }];

/** Parses, migrates, validates and invariant-checks project file text. Never partially loads. */
export function loadProjectFromText(text: string): Result<Project, LoadError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return err({ kind: 'parse', message: describeUnknown(error) });
  }

  const shell = EnvelopeShellSchema.safeParse(raw);
  if (!shell.success) {
    return err({ kind: 'envelope', message: z.prettifyError(shell.error) });
  }
  if (shell.data.format !== PROJECT_FILE_FORMAT) {
    return err({
      kind: 'envelope',
      message: `Not a Kriti project file (format "${shell.data.format}")`,
    });
  }
  if (shell.data.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return err({
      kind: 'unsupported-version',
      fileVersion: shell.data.schemaVersion,
      supportedVersion: CURRENT_SCHEMA_VERSION,
    });
  }

  let migrated = shell.data.project;
  for (let version = shell.data.schemaVersion; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const migration = MIGRATIONS.find((m) => m.fromVersion === version);
    if (!migration) {
      return err({
        kind: 'unsupported-version',
        fileVersion: shell.data.schemaVersion,
        supportedVersion: CURRENT_SCHEMA_VERSION,
      });
    }
    migrated = migration.migrate(migrated);
  }

  const parsed = ProjectSchema.safeParse(migrated);
  if (!parsed.success) {
    return err({ kind: 'schema', message: z.prettifyError(parsed.error) });
  }

  const violations = checkInvariants(parsed.data);
  if (violations.length > 0) {
    return err({ kind: 'invariant', violations });
  }

  return ok(parsed.data);
}

export function describeLoadError(error: LoadError): string {
  switch (error.kind) {
    case 'parse':
      return `The file is not valid JSON: ${error.message}`;
    case 'envelope':
      return `The file is not a Kriti project: ${error.message}`;
    case 'unsupported-version':
      return `This project was created with a newer version of Kriti (schema ${error.fileVersion.toString()}; this build supports up to ${error.supportedVersion.toString()}). Update Kriti to open it.`;
    case 'schema':
      return `The project file does not match the expected shape: ${error.message}`;
    case 'invariant':
      return `The project file is internally inconsistent: ${error.violations.map((v) => v.message).join('; ')}`;
  }
}
