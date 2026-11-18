import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { InputError } from '../errors/qlm-error.js';
import { readStoredMarkdownSource, restoreStoredMarkdownSource } from '../markdown/repository.js';
import { documentDraftFrontmatterSchema, type DocumentDraftFrontmatter } from '../markdown/schema.js';
import { projectMetadataSchema } from '../projects/schema.js';
import { assertMcpOperationAllowed, resolveMcpProjectScope } from './access.js';
import { saveMarkdownDocumentIfUnchanged } from '../markdown/repository.js';
import { rebuildProjectIndex } from '../database/reindex.js';
import type { McpPermission } from './access.js';

const MAX_PROPOSAL_BYTES = 256 * 1024;
const proposalSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string().min(1).max(64),
  documentPath: z.string().min(1).max(512),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  draft: z.object({
    metadata: documentDraftFrontmatterSchema,
    body: z.string().max(MAX_PROPOSAL_BYTES),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict();

export type StoredDocumentProposal = z.infer<typeof proposalSchema>;

function ensureProposalDirectory(dataRoot: string): string {
  const absoluteRoot = resolve(dataRoot);
  let current = parse(absoluteRoot).root;
  for (const part of absoluteRoot.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new InputError('Proposal storage path is invalid.');
    } catch (error) {
      if (error instanceof InputError || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      mkdirSync(current);
    }
  }
  const directory = join(absoluteRoot, 'mcp-proposals');
  mkdirSync(directory, { recursive: true });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError('Proposal storage path is invalid.');
  return directory;
}

export function createStoredDocumentProposal(options: {
  dataRoot: string;
  projectRoot: string;
  knowledgeRoot: string;
  documentPath: string;
  draft: { metadata: DocumentDraftFrontmatter; body: string };
}): StoredDocumentProposal {
  const project = projectMetadataSchema.parse(parseYaml(readFileSync(join(options.projectRoot, 'project.yaml'), 'utf8')));
  const source = readStoredMarkdownSource(options.knowledgeRoot, options.documentPath);
  const sourceHash = createHash('sha256').update(source.sourceText, 'utf8').digest('hex');
  const proposal = proposalSchema.parse({
    id: randomUUID(),
    projectId: project.id,
    projectName: project.name,
    documentPath: options.documentPath,
    sourceHash,
    draft: options.draft,
    createdAt: new Date().toISOString(),
  });
  const serialized = JSON.stringify(proposal);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROPOSAL_BYTES) {
    throw new InputError('The proposed document exceeds the maximum size.');
  }
  const directory = ensureProposalDirectory(options.dataRoot);
  writeFileSync(join(directory, `${proposal.id}.json`), serialized, { flag: 'wx', mode: 0o600 });
  return proposal;
}

export function readStoredDocumentProposal(dataRoot: string, proposalId: string): StoredDocumentProposal {
  if (!z.string().uuid().safeParse(proposalId).success) {
    throw new InputError('Invalid document proposal ID.');
  }
  const filePath = join(ensureProposalDirectory(dataRoot), `${proposalId}.json`);
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_PROPOSAL_BYTES) throw new Error('oversized');
    return proposalSchema.parse(JSON.parse(raw));
  } catch {
    throw new InputError('Document proposal is unavailable or invalid.');
  }
}

export function cancelStoredDocumentProposal(dataRoot: string, proposalId: string): void {
  if (!z.string().uuid().safeParse(proposalId).success) {
    throw new InputError('Invalid document proposal ID.');
  }
  try {
    unlinkSync(join(ensureProposalDirectory(dataRoot), `${proposalId}.json`));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new InputError('Document proposal could not be cancelled.');
    }
  }
}

export function approveStoredDocumentProposal(options: {
  dataRoot: string;
  proposalId: string;
  permissions: ReadonlySet<McpPermission>;
  confirmed: boolean;
  rebuildIndex?: (projectRoot: string, project: ReturnType<typeof resolveMcpProjectScope>['project']) => void;
}): void {
  assertMcpOperationAllowed('APPROVED_WRITE', options.permissions);
  if (!options.confirmed) throw new InputError('Local confirmation is required to apply a proposal.');
  const proposal = readStoredDocumentProposal(options.dataRoot, options.proposalId);
  const scope = resolveMcpProjectScope(options.dataRoot, proposal.projectName);
  if (scope.project.id !== proposal.projectId) {
    throw new InputError('The proposal no longer matches the selected project.');
  }
  const originalSource = readStoredMarkdownSource(scope.knowledgeRoot, proposal.documentPath);
  let appliedHash: string | undefined;
  try {
    saveMarkdownDocumentIfUnchanged(
      scope.knowledgeRoot,
      proposal.documentPath,
      proposal.draft,
      proposal.sourceHash,
    );
    const appliedSource = readStoredMarkdownSource(scope.knowledgeRoot, proposal.documentPath);
    appliedHash = createHash('sha256').update(appliedSource.sourceText, 'utf8').digest('hex');
    (options.rebuildIndex ?? rebuildProjectIndex)(scope.projectRoot, scope.project);
  } catch (cause) {
    if (appliedHash !== undefined) {
      try {
        restoreStoredMarkdownSource(scope.knowledgeRoot, proposal.documentPath, originalSource.sourceText, appliedHash);
      } catch {
        // Preserve a concurrent edit rather than overwriting it during rollback.
      }
    }
    throw cause;
  }
  unlinkSync(join(ensureProposalDirectory(options.dataRoot), `${proposal.id}.json`));
}
