import { spawn } from 'node:child_process';
import { join } from 'node:path';
import React, { useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { buildKnowledgeTree, type CategoryTreeNode, type DocumentTreeNode } from '../markdown/tree.js';
import { readStoredMarkdownDocument } from '../markdown/repository.js';
import type { DocumentFrontmatter } from '../markdown/schema.js';

type TreeEntry =
  | { type: 'category'; node: CategoryTreeNode; parentPath: string }
  | { type: 'document'; node: DocumentTreeNode; parentPath: string };

interface OpenDocument {
  metadata: DocumentFrontmatter;
  body: string;
  path: string;
}

export interface ExplorerProps {
  dataRoot: string;
  projectName?: string;
  refreshVersion: number;
  onBack?: () => void;
  onExit?: () => void;
  copyPath?: (path: string) => void;
  editorCommand?: string;
}

const TREE_MAX_DEPTH = 6;
const TREE_MAX_ENTRIES = 200;
const DOCUMENT_LINES = 10;

export function Explorer({
  dataRoot,
  projectName,
  refreshVersion,
  onBack,
  onExit,
  copyPath = writeClipboardPath,
  editorCommand = process.env.VISUAL ?? process.env.EDITOR,
}: ExplorerProps): React.JSX.Element {
  const { suspendTerminal, exit } = useApp();
  const knowledgeRoot = projectName === undefined
    ? undefined
    : join(dataRoot, 'projects', projectName, 'knowledge');
  const snapshot = useMemo(() => {
    if (knowledgeRoot === undefined) {
      return { tree: undefined, error: undefined };
    }
    try {
      return {
        tree: buildKnowledgeTree(knowledgeRoot, {
          maxDepth: TREE_MAX_DEPTH,
          maxEntries: TREE_MAX_ENTRIES,
        }),
        error: undefined,
      };
    } catch {
      return { tree: undefined, error: 'Knowledge is unavailable. Check the project files and Markdown frontmatter, then refresh.' };
    }
  }, [knowledgeRoot, refreshVersion]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const entries = useMemo(
    () => snapshot.tree === undefined ? [] : flattenTree(snapshot.tree, expanded),
    [snapshot.tree, expanded],
  );
  const [cursor, setCursor] = useState(0);
  const [document, setDocument] = useState<OpenDocument>();
  const [relatedCursor, setRelatedCursor] = useState(0);
  const [documentScroll, setDocumentScroll] = useState(0);
  const [documentFocus, setDocumentFocus] = useState<'body' | 'related'>('body');
  const [message, setMessage] = useState<string>();

  const documentsById = useMemo(() => {
    const byId = new Map<string, DocumentTreeNode>();
    if (snapshot.tree !== undefined) {
      collectDocuments(snapshot.tree.documents, snapshot.tree.categories, byId);
    }
    return byId;
  }, [snapshot.tree]);
  const relatedDocuments = useMemo(
    () => (document?.metadata.related ?? [])
      .map((id) => documentsById.get(id))
      .filter((node): node is DocumentTreeNode => node !== undefined),
    [document, documentsById],
  );
  const activeCursor = Math.min(cursor, Math.max(0, entries.length - 1));
  const selectedEntry = entries[activeCursor];

  const openDocument = (path: string): void => {
    if (knowledgeRoot === undefined) {
      setMessage('Select a project before browsing documents.');
      return;
    }
    try {
      const parsed = readStoredMarkdownDocument(knowledgeRoot, path);
      if (parsed.metadata.type !== 'document') {
        setMessage('This file is not a knowledge document. Refresh the tree and choose a document.');
        return;
      }
      setDocument({ metadata: parsed.metadata, body: parsed.body, path });
      setRelatedCursor(0);
      setDocumentScroll(0);
      setDocumentFocus('body');
      setMessage(undefined);
    } catch {
      setDocument(undefined);
      setMessage('Could not read this document. Check that it exists and its Markdown frontmatter is valid, then refresh.');
    }
  };

  useInput((input, key) => {
    if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
      onExit?.();
      exit();
      return;
    }
    if (document !== undefined) {
      if (key.escape || input.toLowerCase() === 'b') {
        setDocument(undefined);
        setMessage(undefined);
        return;
      }
      if (input.toLowerCase() === 'r') {
        openDocument(document.path);
        return;
      }
      if (key.tab && relatedDocuments.length > 0) {
        setDocumentFocus((focus) => focus === 'body' ? 'related' : 'body');
        return;
      }
      if (documentFocus === 'related' && relatedDocuments.length > 0) {
        if (key.upArrow) {
          setRelatedCursor((index) => index === 0 ? relatedDocuments.length - 1 : index - 1);
          return;
        }
        if (key.downArrow) {
          setRelatedCursor((index) => (index + 1) % relatedDocuments.length);
          return;
        }
        if (key.return) {
          const related = relatedDocuments[relatedCursor];
          if (related !== undefined) {
            openDocument(related.path);
          }
          return;
        }
      } else if (key.upArrow || input.toLowerCase() === 'k') {
        setDocumentScroll((offset) => Math.max(0, offset - 1));
        return;
      } else if (key.downArrow || input.toLowerCase() === 'j') {
        setDocumentScroll((offset) => Math.min(
          Math.max(0, document.body.split(/\r?\n/u).length - DOCUMENT_LINES),
          offset + 1,
        ));
        return;
      }
      if (input.toLowerCase() === 'c') {
        try {
          copyPath(join(knowledgeRoot ?? '', document.path));
          setMessage('Document path copied to the terminal clipboard.');
        } catch {
          setMessage('Could not copy the path. Use the displayed relative path instead.');
        }
        return;
      }
      if (input.toLowerCase() === 'e') {
        if (editorCommand === undefined || editorCommand.trim().length === 0) {
          setMessage('No external editor is configured. Set EDITOR or VISUAL, then try again.');
          return;
        }
        const args = parseEditorCommand(editorCommand);
        if (args === undefined) {
          setMessage('The configured editor command is invalid. Set EDITOR or VISUAL to an executable and optional arguments.');
          return;
        }
        const [command, ...editorArgs] = args;
        if (command === undefined) {
          setMessage('No external editor is configured. Set EDITOR or VISUAL, then try again.');
          return;
        }
        setMessage('Opening the document in the configured external editor.');
        void (async () => {
          let opened = false;
          await suspendTerminal(async () => {
            opened = await new Promise<boolean>((resolve) => {
              const child = spawn(command, [...editorArgs, join(knowledgeRoot ?? '', document.path)], {
                stdio: 'inherit',
                shell: false,
              });
              child.once('error', () => resolve(false));
              child.once('exit', (code) => resolve(code === 0));
            });
          });
          setMessage(opened
            ? 'Returned from the external editor. The Explorer remains read-only.'
            : 'Could not open the external editor. Check EDITOR or VISUAL and try again.');
        })().catch(() => setMessage('Could not open the external editor. Check EDITOR or VISUAL and try again.'));
        return;
      }
      return;
    }

    if (key.escape) {
      onBack?.();
      return;
    }
    if (key.upArrow && entries.length > 0) {
      setCursor((index) => index === 0 ? entries.length - 1 : index - 1);
      return;
    }
    if (key.downArrow && entries.length > 0) {
      setCursor((index) => (index + 1) % entries.length);
      return;
    }
    if (key.leftArrow && selectedEntry?.type === 'category') {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(selectedEntry.node.path);
        return next;
      });
      return;
    }
    if (key.rightArrow && selectedEntry?.type === 'category') {
      setExpanded((current) => new Set(current).add(selectedEntry.node.path));
      return;
    }
    if (key.return && selectedEntry !== undefined) {
      if (selectedEntry.type === 'category') {
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(selectedEntry.node.path)) {
            next.delete(selectedEntry.node.path);
          } else {
            next.add(selectedEntry.node.path);
          }
          return next;
        });
      } else {
        openDocument(selectedEntry.node.path);
      }
      return;
    }
    if (input.toLowerCase() === 'c' && selectedEntry?.type === 'document') {
      try {
        copyPath(join(knowledgeRoot ?? '', selectedEntry.node.path));
        setMessage('Document path copied to the terminal clipboard.');
      } catch {
        setMessage('Could not copy the path. Use the displayed relative path instead.');
      }
    }
  });

  if (projectName === undefined) {
    return <Text>No project is selected. Select a project from the Dashboard, then open Explorer.</Text>;
  }

  if (document !== undefined) {
    const bodyLines = document.body.split(/\r?\n/u);
    const visibleBody = bodyLines.slice(documentScroll, documentScroll + DOCUMENT_LINES);
    return (
      <Box flexDirection="column">
        <Text bold>{safeTerminalText(document.metadata.title)}</Text>
        <Text>Project: {safeTerminalText(projectName)} | Path: {safeTerminalText(document.path)} | ID: {safeTerminalText(document.metadata.id)}</Text>
        <Text>Depth: {document.metadata.depth} | Status: {safeTerminalText(document.metadata.status)}</Text>
        {document.metadata.description === undefined ? null : <Text>Description: {safeTerminalText(document.metadata.description)}</Text>}
        {document.metadata.source_ids === undefined ? null : <Text>Sources: {safeTerminalText(document.metadata.source_ids.join(', ') || '(none)')}</Text>}
        {document.metadata.source_sections === undefined ? null : <Text>Source sections: {safeTerminalText(document.metadata.source_sections.join(', ') || '(none)')}</Text>}
        <Text dimColor>Content (lines {bodyLines.length === 0 ? 0 : documentScroll + 1}-{Math.min(bodyLines.length, documentScroll + DOCUMENT_LINES)} of {bodyLines.length}):</Text>
        {visibleBody.length === 0 ? <Text>(empty document)</Text> : visibleBody.map((line, index) => (
          <Text key={`${documentScroll + index}-${line}`}>{safeTerminalText(line) || ' '}</Text>
        ))}
        {relatedDocuments.length > 0 ? (
          <>
            <Text bold>Related documents{documentFocus === 'related' ? ' [focus]' : ''}:</Text>
            {relatedDocuments.map((related, index) => (
              <Text key={related.id}>{index === relatedCursor ? '› ' : '  '}{safeTerminalText(related.title)} ({safeTerminalText(related.path)})</Text>
            ))}
          </>
        ) : null}
        {message ? <Text>{message}</Text> : null}
        <Text dimColor>↑/↓ or j/k scroll; Tab related list; Enter open related; c copy path; e external editor; b/Esc back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>Project: {projectName} | Tree depth limit: {TREE_MAX_DEPTH} | Entry limit: {TREE_MAX_ENTRIES}</Text>
      {snapshot.error ? <Text>{snapshot.error}</Text> : snapshot.tree === undefined ? (
        <Text>No knowledge tree is available. Build knowledge for this project, then refresh.</Text>
      ) : entries.length === 0 ? (
        <Text>No knowledge documents or categories found.</Text>
      ) : entries.map((entry, index) => {
        const selected = index === activeCursor;
        const indent = '  '.repeat(entry.node.depth);
        if (entry.type === 'category') {
          const isExpanded = expanded.has(entry.node.path);
          return <Text key={`category:${entry.node.path}`}>{selected ? '› ' : '  '}{indent}{isExpanded ? '▾' : '▸'} {safeTerminalText(entry.node.title)}/</Text>;
        }
        return <Text key={`document:${entry.node.path}`}>{selected ? '› ' : '  '}{indent}  {safeTerminalText(entry.node.title)} ({safeTerminalText(entry.node.path)})</Text>;
      })}
      {snapshot.tree?.truncated ? <Text dimColor>Tree is bounded; some entries are omitted. Reduce project size or browse a category.</Text> : null}
      {message ? <Text>{message}</Text> : null}
      <Text dimColor>↑/↓ select; → expand; ← collapse; Enter expand/open; c copy document path; Esc back.</Text>
    </Box>
  );
}

function flattenTree(
  tree: { documents: DocumentTreeNode[]; categories: CategoryTreeNode[] },
  expanded: ReadonlySet<string>,
): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (documents: readonly DocumentTreeNode[], categories: readonly CategoryTreeNode[], parentPath: string): void => {
    for (const category of categories) {
      entries.push({ type: 'category', node: category, parentPath });
      if (expanded.has(category.path)) {
        visit(category.documents, category.categories, category.path);
      }
    }
    for (const document of documents) {
      entries.push({ type: 'document', node: document, parentPath });
    }
  };
  visit(tree.documents, tree.categories, '');
  return entries;
}

function collectDocuments(
  documents: readonly DocumentTreeNode[],
  categories: readonly CategoryTreeNode[],
  byId: Map<string, DocumentTreeNode>,
): void {
  for (const document of documents) {
    byId.set(document.id, document);
  }
  for (const category of categories) {
    collectDocuments(category.documents, category.categories, byId);
  }
}

function writeClipboardPath(path: string): void {
  process.stdout.write(`\u001b]52;c;${Buffer.from(path).toString('base64')}\u0007`);
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ');
}

function parseEditorCommand(command: string): string[] | undefined {
  const parts: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaping = false;
  const source = command.trim();
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaping) {
      current += character;
      escaping = false;
    } else if (character === '\\' && quote !== 'single') {
      const next = source[index + 1];
      if (next !== undefined && (/[\s"'\\]/u.test(next))) {
        escaping = true;
      } else {
        current += character;
      }
    } else if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
    } else if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
    } else if (/\s/u.test(character) && quote === undefined) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaping || quote !== undefined) {
    return undefined;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts.length === 0 ? undefined : parts;
}
