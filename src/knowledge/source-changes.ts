import { createHash } from 'node:crypto';
import type {
  ProjectSourceSnapshot,
  SourceSnapshotFile,
  SourceSnapshotSection,
} from '../database/source-snapshot.js';
import type { SourceDocument, SourceSection } from './source.js';

export type SourceChangeStatus = 'added' | 'modified' | 'deleted' | 'unchanged';

export interface SourceFileChange {
  sourceId: string;
  path: string;
  status: SourceChangeStatus;
  previousHash: string | null;
  currentHash: string | null;
}

export interface SourceSectionChange {
  sourceId: string;
  sourcePath: string;
  sectionId: string;
  previousParserSectionId: string | null;
  currentParserSectionId: string | null;
  status: SourceChangeStatus;
  previousHash: string | null;
  currentHash: string | null;
}

export interface SourceChangeSet {
  files: SourceFileChange[];
  sections: SourceSectionChange[];
}

export function createProjectSourceSnapshot(
  sourceRoot: string,
  sources: SourceDocument[],
  sections: SourceSection[],
): ProjectSourceSnapshot {
  const files: SourceSnapshotFile[] = sources.map(({ id, path, hash }) => ({
    sourceId: id,
    path,
    contentHash: hash,
  }));
  const occurrences = new Map<string, number>();
  const snapshotSections: SourceSnapshotSection[] = sections.map((section) => {
    // The parser's public section ID includes offsets. This snapshot key uses
    // structural identity so inserting text above a section does not make the
    // unchanged section look new.
    const structuralIdentity = JSON.stringify([
      section.sourceId,
      section.headingPath,
      section.title,
    ]);
    const occurrence = occurrences.get(structuralIdentity) ?? 0;
    occurrences.set(structuralIdentity, occurrence + 1);
    const sectionId = createHash('sha256')
      .update(`${structuralIdentity}\0${occurrence}`, 'utf8')
      .digest('hex');
    return {
      sourceId: section.sourceId,
      sectionId,
      parserSectionId: `${section.sourceId}:${section.id}`,
      contentHash: section.hash,
    };
  });

  return {
    sourceRoot,
    files: files.sort(compareByPathAndId),
    sections: snapshotSections.sort((left, right) =>
      compareStrings(left.sourceId, right.sourceId) ||
      compareStrings(left.sectionId, right.sectionId),
    ),
  };
}

export function compareProjectSourceSnapshots(
  current: ProjectSourceSnapshot,
  previous: ProjectSourceSnapshot | undefined,
): SourceChangeSet {
  const previousFiles = new Map(
    (previous?.files ?? []).map((file) => [file.sourceId, file]),
  );
  const currentFiles = new Map(current.files.map((file) => [file.sourceId, file]));
  const files: SourceFileChange[] = [];

  for (const sourceId of new Set([...previousFiles.keys(), ...currentFiles.keys()])) {
    const before = previousFiles.get(sourceId);
    const after = currentFiles.get(sourceId);
    files.push({
      sourceId,
      path: after?.path ?? before?.path ?? '',
      status: classify(before?.contentHash, after?.contentHash),
      previousHash: before?.contentHash ?? null,
      currentHash: after?.contentHash ?? null,
    });
  }

  const previousSections = new Map(
    (previous?.sections ?? []).map((section) => [section.sectionId, section]),
  );
  const currentSections = new Map(current.sections.map((section) => [section.sectionId, section]));
  const sourcePaths = new Map(
    [...(previous?.files ?? []), ...current.files].map(({ sourceId, path }) => [sourceId, path]),
  );
  const sections: SourceSectionChange[] = [];

  for (const sectionId of new Set([...previousSections.keys(), ...currentSections.keys()])) {
    const before = previousSections.get(sectionId);
    const after = currentSections.get(sectionId);
    const sourceId = after?.sourceId ?? before?.sourceId ?? '';
    sections.push({
      sourceId,
      sourcePath: sourcePaths.get(sourceId) ?? '',
      sectionId,
      status: classify(before?.contentHash, after?.contentHash),
      previousParserSectionId: before?.parserSectionId ?? null,
      currentParserSectionId: after?.parserSectionId ?? null,
      previousHash: before?.contentHash ?? null,
      currentHash: after?.contentHash ?? null,
    });
  }

  return {
    files: files.sort((left, right) =>
      compareStrings(left.path, right.path) || compareStrings(left.sourceId, right.sourceId),
    ),
    sections: sections.sort((left, right) =>
      compareStrings(left.sourcePath, right.sourcePath) ||
      compareStrings(left.sourceId, right.sourceId) ||
      compareStrings(left.sectionId, right.sectionId),
    ),
  };
}

function classify(previousHash: string | undefined, currentHash: string | undefined): SourceChangeStatus {
  if (previousHash === undefined) return 'added';
  if (currentHash === undefined) return 'deleted';
  return previousHash === currentHash ? 'unchanged' : 'modified';
}

function compareByPathAndId(left: SourceSnapshotFile, right: SourceSnapshotFile): number {
  return compareStrings(left.path, right.path) || compareStrings(left.sourceId, right.sourceId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
