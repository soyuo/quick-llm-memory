import { join } from 'node:path';
import React, { useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { readStoredMarkdownDocument } from '../markdown/repository.js';
import { listProjects } from '../projects/manager.js';
import type { ProjectMetadata } from '../projects/schema.js';
import {
  searchProjectDocuments,
  type SynchronousRetrievalMode,
  type RetrievalSearchResult,
} from '../retrieval/search.js';
import { sanitizeTerminalText } from './terminal-text.js';

type SearchFocus = 'query' | 'mode' | 'project' | 'results';

interface SearchDocument {
  path: string;
  title: string;
  body: string;
  sourceIds: string[];
  sourceSections: string[];
}

export interface SearchProps {
  dataRoot: string;
  initialProjectName?: string;
  refreshVersion: number;
  onBack?: () => void;
  onExit?: () => void;
}

const SEARCH_MODES: SynchronousRetrievalMode[] = ['path', 'hierarchical', 'fulltext', 'hybrid'];
const MAX_SEARCH_RESULTS = 20;
const RESULT_WINDOW_SIZE = 8;
const DOCUMENT_LINES = 10;

export function Search({
  dataRoot,
  initialProjectName,
  refreshVersion,
  onBack,
  onExit,
}: SearchProps): React.JSX.Element {
  const { exit } = useApp();
  const projectSnapshot = useMemo(() => {
    try {
      return { projects: listProjects(dataRoot), error: undefined };
    } catch {
      return { projects: [] as ProjectMetadata[], error: 'Project information is unavailable. Refresh and try again.' };
    }
  }, [dataRoot, refreshVersion]);
  const [chosenProjectName, setChosenProjectName] = useState(initialProjectName);
  const currentProjectName = chosenProjectName ?? initialProjectName;
  const projectIndex = Math.max(
    0,
    projectSnapshot.projects.findIndex(({ name }) => name === currentProjectName),
  );
  const project = projectSnapshot.projects[projectIndex];
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SynchronousRetrievalMode>('hybrid');
  const [focus, setFocus] = useState<SearchFocus>('query');
  const [results, setResults] = useState<RetrievalSearchResult[]>([]);
  const [resultCursor, setResultCursor] = useState(0);
  const [document, setDocument] = useState<SearchDocument>();
  const [documentScroll, setDocumentScroll] = useState(0);
  const [message, setMessage] = useState<string>();

  const runSearch = (): void => {
    if (query.trim().length === 0) {
      setResults([]);
      setMessage('Enter a search term, then press Enter.');
      return;
    }
    if (project === undefined) {
      setResults([]);
      setMessage('Select an initialized project before searching.');
      return;
    }
    try {
      const nextResults = searchProjectDocuments({
        projectRoot: join(dataRoot, 'projects', project.name),
        project,
        projectId: project.id,
        query,
        mode,
        maxResults: MAX_SEARCH_RESULTS,
        ...(mode === 'hierarchical' ? { maxDepth: 5 } : {}),
        // Keep interactive search bounded; an explicit index rebuild can be run from the CLI.
        synchronizeStaleIndex: false,
      });
      setResults(nextResults);
      setResultCursor(0);
      setDocument(undefined);
      setDocumentScroll(0);
      setMessage(nextResults.length === 0 ? 'No matching documents found.' : undefined);
      setFocus('results');
    } catch {
      setResults([]);
      setMessage('Search is unavailable. Check the project index, then refresh and retry.');
    }
  };

  const openSelectedDocument = (): void => {
    const selected = results[resultCursor];
    if (selected === undefined || project === undefined) {
      return;
    }
    const knowledgeRoot = join(dataRoot, 'projects', project.name, 'knowledge');
    try {
      const parsed = readStoredMarkdownDocument(knowledgeRoot, selected.path);
      if (parsed.metadata.type !== 'document' || parsed.metadata.id !== selected.documentId) {
        setMessage('The selected document changed. Refresh search results, then try again.');
        return;
      }
      setDocument({
        path: selected.path,
        title: parsed.metadata.title,
        body: parsed.body,
        sourceIds: [...(parsed.metadata.source_ids ?? [])],
        sourceSections: [...(parsed.metadata.source_sections ?? [])],
      });
      setDocumentScroll(0);
      setMessage(undefined);
    } catch {
      setMessage('Could not read this result. Refresh the project index and try again.');
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      onExit?.();
      exit();
      return;
    }
    if (document !== undefined) {
      if (input.toLowerCase() === 'q') {
        onExit?.();
        exit();
        return;
      }
      if (key.escape || input.toLowerCase() === 'b') {
        setDocument(undefined);
        setMessage(undefined);
        return;
      }
      if (key.upArrow || input.toLowerCase() === 'k') {
        setDocumentScroll((offset) => Math.max(0, offset - 1));
        return;
      }
      if (key.downArrow || input.toLowerCase() === 'j') {
        setDocumentScroll((offset) => Math.min(
          Math.max(0, document.body.split(/\r?\n/u).length - DOCUMENT_LINES),
          offset + 1,
        ));
        return;
      }
      return;
    }
    if (input.toLowerCase() === 'q' && focus !== 'query') {
      onExit?.();
      exit();
      return;
    }
    if (key.escape) {
      onBack?.();
      return;
    }
    if (key.tab) {
      const order: SearchFocus[] = ['query', 'mode', 'project', 'results'];
      const index = order.indexOf(focus);
      setFocus(order[(index + 1) % order.length]!);
      return;
    }
    if (focus === 'query') {
      if (key.backspace || key.delete) {
        setQuery((value) => value.slice(0, -1));
        return;
      }
      if (key.return) {
        runSearch();
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta && !key.escape) {
        setQuery((value) => value + input);
      }
      return;
    }
    if (focus === 'mode') {
      if (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow) {
        const offset = key.leftArrow || key.upArrow ? -1 : 1;
        const index = SEARCH_MODES.indexOf(mode);
        const nextMode = SEARCH_MODES[(index + offset + SEARCH_MODES.length) % SEARCH_MODES.length]!;
        setMode(nextMode);
        setResults([]);
        setResultCursor(0);
        setMessage('Mode changed. Press Enter to search again.');
        return;
      }
      if (key.return) {
        runSearch();
      }
      return;
    }
    if (focus === 'project') {
      if (projectSnapshot.projects.length > 0 && (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)) {
        const offset = key.leftArrow || key.upArrow ? -1 : 1;
        const nextIndex = (projectIndex + offset + projectSnapshot.projects.length) % projectSnapshot.projects.length;
        setChosenProjectName(projectSnapshot.projects[nextIndex]?.name);
        setResults([]);
        setMessage(undefined);
        return;
      }
      if (key.return) {
        runSearch();
      }
      return;
    }
    if (focus === 'results') {
      if (key.upArrow && results.length > 0) {
        setResultCursor((index) => index === 0 ? results.length - 1 : index - 1);
        return;
      }
      if (key.downArrow && results.length > 0) {
        setResultCursor((index) => (index + 1) % results.length);
        return;
      }
      if (key.return) {
        openSelectedDocument();
      }
    }
  });

  if (document !== undefined) {
    const lines = document.body.split(/\r?\n/u);
    const visibleLines = lines.slice(documentScroll, documentScroll + DOCUMENT_LINES);
    return (
      <Box flexDirection="column">
        <Text bold>{sanitizeTerminalText(document.title)}</Text>
        <Text>Project: {sanitizeTerminalText(project?.name ?? '')} | Path: {sanitizeTerminalText(document.path)}</Text>
        <Text>Sources: {sanitizeTerminalText(document.sourceIds.join(', ') || '(none)')}</Text>
        <Text>Source sections: {sanitizeTerminalText(document.sourceSections.join(', ') || '(none)')}</Text>
        {visibleLines.map((line, index) => (
          <Text key={`${documentScroll + index}-${line}`}>{sanitizeTerminalText(line) || ' '}</Text>
        ))}
        <Text dimColor>↑/↓ or j/k scroll; b/Esc back to results.</Text>
      </Box>
    );
  }

  const windowStart = Math.min(
    Math.max(0, resultCursor - Math.floor(RESULT_WINDOW_SIZE / 2)),
    Math.max(0, results.length - RESULT_WINDOW_SIZE),
  );
  const visibleResults = results.slice(windowStart, windowStart + RESULT_WINDOW_SIZE);
  const selectedResult = results[resultCursor];

  return (
    <Box flexDirection="column">
      {projectSnapshot.error ? <Text>{projectSnapshot.error}</Text> : null}
      <Text>Query{focus === 'query' ? ' [focus]' : ''}: {sanitizeTerminalText(query) || '(type a query)'}</Text>
      <Text>Mode{focus === 'mode' ? ' [focus]' : ''}: {mode} | Project{focus === 'project' ? ' [focus]' : ''}: {project?.name ?? '(none)'}</Text>
      {results.length === 0 ? (
        <Text>{message ?? 'Enter a query to search the selected project.'}</Text>
      ) : (
        <>
          <Text bold>Results{focus === 'results' ? ' [focus]' : ''} ({windowStart + 1}-{windowStart + visibleResults.length} of {results.length}):</Text>
          {visibleResults.map((result, index) => {
            const absoluteIndex = windowStart + index;
            return (
              <Text key={`${result.documentId}-${absoluteIndex}`}>
                {absoluteIndex === resultCursor ? '› ' : '  '}{absoluteIndex + 1}. {sanitizeTerminalText(result.title)} ({sanitizeTerminalText(result.path)})
              </Text>
            );
          })}
          {selectedResult === undefined ? null : (
            <>
              <Text>Rank score (RRF, not probability): {selectedResult.score.toFixed(4)}</Text>
              <Text>Preview: {sanitizeTerminalText(selectedResult.snippet)}</Text>
              <Text>Sources: {sanitizeTerminalText(selectedResult.sourceIds.join(', ') || '(none)')}</Text>
              <Text>Matched sections: {sanitizeTerminalText(selectedResult.matchedSections.join(', ') || '(none)')}</Text>
            </>
          )}
        </>
      )}
      {message && results.length > 0 ? <Text>{message}</Text> : null}
      <Text dimColor>Tab focus query/mode/project/results; arrows edit selection; Enter search/open; Esc back; q quits outside query.</Text>
    </Box>
  );
}
