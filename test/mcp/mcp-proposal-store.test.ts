import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeRoot, createMarkdownDocument, readStoredMarkdownDocument } from '../../src/markdown/repository.js';
import { approveStoredDocumentProposal, createStoredDocumentProposal, readStoredDocumentProposal, cancelStoredDocumentProposal } from '../../src/mcp/proposal-store.js';
import { initializeProject } from '../../src/projects/manager.js';
import type { MarkdownDocumentDraft } from '../../src/markdown/repository.js';
import { assertProposalReviewComplete, formatProposalReview } from '../../src/mcp/commands.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('MCP proposal store', () => {
  it('rejects a symlinked proposal directory', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-proposal-'));
    const outside = mkdtempSync(join(tmpdir(), 'qlm-outside-'));
    roots.push(dataRoot, outside);
    const project = initializeProject(dataRoot, 'proposal-project');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = createKnowledgeRoot(join(projectRoot, 'knowledge'));
    createMarkdownDocument(knowledgeRoot, 'notes.md', draft());
    symlinkSync(outside, join(dataRoot, 'mcp-proposals'), 'junction');
    expect(() => createStoredDocumentProposal({ dataRoot, projectRoot, knowledgeRoot, documentPath: 'notes.md', draft: draft() })).toThrow(/Proposal storage path is invalid/u);
    expect(existsSync(join(outside, 'proposal.json'))).toBe(false);
  });
  it('persists a project-bound proposal without changing its Markdown source', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-proposal-'));
    roots.push(dataRoot);
    const project = initializeProject(dataRoot, 'proposal-project');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = createKnowledgeRoot(join(projectRoot, 'knowledge'));
    createMarkdownDocument(knowledgeRoot, 'notes.md', draft());
    const before = readFileSync(join(knowledgeRoot, 'notes.md'), 'utf8');
    const proposal = createStoredDocumentProposal({
      dataRoot, projectRoot, knowledgeRoot, documentPath: 'notes.md',
      draft: draft({ title: 'Proposed title', body: '\nProposed body\n' }),
    });
    expect(readStoredDocumentProposal(dataRoot, proposal.id)).toEqual(proposal);
    const review = formatProposalReview(proposal, readStoredMarkdownDocument(knowledgeRoot, 'notes.md'));
    expect(review).toContain('--- current metadata');
    expect(review).toContain('+++ proposed metadata');
    expect(review).toContain('Proposed title');
    const oversized = createStoredDocumentProposal({
      dataRoot, projectRoot, knowledgeRoot, documentPath: 'notes.md',
      draft: draft({ title: 'Oversized review', body: `\n${'x'.repeat(9_000)}\n` }),
    });
    const oversizedReview = formatProposalReview(oversized, readStoredMarkdownDocument(knowledgeRoot, 'notes.md'));
    expect(oversizedReview).toContain('[review truncated]');
    expect(() => assertProposalReviewComplete(oversizedReview)).toThrow(/create a smaller proposal/u);
    expect(readFileSync(join(knowledgeRoot, 'notes.md'), 'utf8')).toBe(before);
  });

  it('cancels a proposal without touching source Markdown', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-proposal-'));
    roots.push(dataRoot);
    const project = initializeProject(dataRoot, 'proposal-project');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = createKnowledgeRoot(join(projectRoot, 'knowledge'));
    createMarkdownDocument(knowledgeRoot, 'notes.md', draft());
    const proposal = createStoredDocumentProposal({ dataRoot, projectRoot, knowledgeRoot, documentPath: 'notes.md', draft: draft() });
    const source = readFileSync(join(knowledgeRoot, 'notes.md'), 'utf8');
    cancelStoredDocumentProposal(dataRoot, proposal.id);
    expect(() => readStoredDocumentProposal(dataRoot, proposal.id)).toThrow();
    expect(readFileSync(join(knowledgeRoot, 'notes.md'), 'utf8')).toBe(source);
  });

  it('requires write permission and local confirmation, then applies approved content', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-proposal-'));
    roots.push(dataRoot);
    const project = initializeProject(dataRoot, 'proposal-project');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = createKnowledgeRoot(join(projectRoot, 'knowledge'));
    createMarkdownDocument(knowledgeRoot, 'notes.md', draft());
    const proposal = createStoredDocumentProposal({ dataRoot, projectRoot, knowledgeRoot, documentPath: 'notes.md', draft: draft({ title: 'Approved title', body: '\nApproved body\n' }) });
    const original = readFileSync(join(knowledgeRoot, 'notes.md'), 'utf8');

    expect(() => approveStoredDocumentProposal({ dataRoot, proposalId: proposal.id, permissions: new Set(['READ']), confirmed: true })).toThrow();
    expect(() => approveStoredDocumentProposal({ dataRoot, proposalId: proposal.id, permissions: new Set(['READ', 'APPROVED_WRITE']), confirmed: false })).toThrow();
    expect(readFileSync(join(knowledgeRoot, 'notes.md'), 'utf8')).toBe(original);

    approveStoredDocumentProposal({ dataRoot, proposalId: proposal.id, permissions: new Set(['READ', 'APPROVED_WRITE']), confirmed: true });
    expect(readFileSync(join(knowledgeRoot, 'notes.md'), 'utf8')).toContain('Approved body');
    expect(() => readStoredDocumentProposal(dataRoot, proposal.id)).toThrow();
  });

  it('keeps the document unchanged when an approval proposal is stale', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-proposal-'));
    roots.push(dataRoot);
    const project = initializeProject(dataRoot, 'proposal-project');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = createKnowledgeRoot(join(projectRoot, 'knowledge'));
    createMarkdownDocument(knowledgeRoot, 'notes.md', draft());
    const proposal = createStoredDocumentProposal({ dataRoot, projectRoot, knowledgeRoot, documentPath: 'notes.md', draft: draft({ body: '\nProposed\n' }) });
    const currentPath = join(knowledgeRoot, 'notes.md');
    const newerSource = `${readFileSync(currentPath, 'utf8')}\nNew user edit\n`;
    writeFileSync(currentPath, newerSource);
    expect(() => approveStoredDocumentProposal({ dataRoot, proposalId: proposal.id, permissions: new Set(['READ', 'APPROVED_WRITE']), confirmed: true })).toThrow();
    expect(readFileSync(currentPath, 'utf8')).toBe(newerSource);
  });

  it('restores Markdown and retains the proposal when index rebuilding fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-proposal-'));
    roots.push(dataRoot);
    const project = initializeProject(dataRoot, 'proposal-project');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = createKnowledgeRoot(join(projectRoot, 'knowledge'));
    createMarkdownDocument(knowledgeRoot, 'notes.md', draft());
    const sourcePath = join(knowledgeRoot, 'notes.md');
    const original = readFileSync(sourcePath, 'utf8');
    const proposal = createStoredDocumentProposal({ dataRoot, projectRoot, knowledgeRoot, documentPath: 'notes.md', draft: draft({ body: '\nApproved update\n' }) });
    writeFileSync(join(knowledgeRoot, 'broken.md'), '---\nnot: [valid\n---\n');

    expect(() => approveStoredDocumentProposal({ dataRoot, proposalId: proposal.id, permissions: new Set(['READ', 'APPROVED_WRITE']), confirmed: true })).toThrow();
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);
    expect(readStoredDocumentProposal(dataRoot, proposal.id)).toEqual(proposal);
  });

  it('does not roll back over a newer edit made while indexing fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-proposal-'));
    roots.push(dataRoot);
    const project = initializeProject(dataRoot, 'proposal-project');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = createKnowledgeRoot(join(projectRoot, 'knowledge'));
    createMarkdownDocument(knowledgeRoot, 'notes.md', draft());
    const sourcePath = join(knowledgeRoot, 'notes.md');
    const proposal = createStoredDocumentProposal({ dataRoot, projectRoot, knowledgeRoot, documentPath: 'notes.md', draft: draft({ body: '\nApproved update\n' }) });
    const newer = `${readFileSync(sourcePath, 'utf8')}\nConcurrent edit\n`;
    expect(() => approveStoredDocumentProposal({
      dataRoot,
      proposalId: proposal.id,
      permissions: new Set(['READ', 'APPROVED_WRITE']),
      confirmed: true,
      rebuildIndex: () => { writeFileSync(sourcePath, newer); throw new Error('index failed'); },
    })).toThrow('index failed');
    expect(readFileSync(sourcePath, 'utf8')).toBe(newer);
    expect(readStoredDocumentProposal(dataRoot, proposal.id)).toEqual(proposal);
  });
});

function draft(overrides: { title?: string; body?: string } = {}): MarkdownDocumentDraft {
  return {
    metadata: { schema_version: 1, title: overrides.title ?? 'Existing title', type: 'document', status: 'active', depth: 1 },
    body: overrides.body ?? '\nExisting body\n',
  };
}
