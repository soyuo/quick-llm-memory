import React, { useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { extname, join } from 'node:path';
import { lstatSync } from 'node:fs';
import { settingsSchema, type Settings } from '../config/schema.js';
import {
  BuildCancelledError,
  executePreparedKnowledgeBuild,
  prepareProjectKnowledgeBuild,
  type BuildProgressEvent,
  type BuildProjectKnowledgeOptions,
  type BuildProjectKnowledgeResult,
  type PreparedKnowledgeBuild,
} from '../knowledge/builder.js';
import { loadMarkdownSources } from '../knowledge/source.js';
import { createConfiguredBuildProvider } from '../providers/configured-build-provider.js';
import type { AIProvider } from '../providers/provider.js';
import { listProjects } from '../projects/manager.js';
import { projectNameSchema } from '../projects/schema.js';

type BuildWizardSetupStep = 'project' | 'sources' | 'provider' | 'model' | 'hierarchy' | 'document';

export type BuildWizardStep =
  | BuildWizardSetupStep
  | 'analysis'
  | 'preview'
  | 'confirmation'
  | 'generation'
  | 'validation'
  | 'failed'
  | 'complete';

export interface BuildWizardDraft {
  projectName: string;
  sourcePath: string;
  provider: 'openai' | 'openai-compatible';
  model: string;
  minDepth: string;
  maxDepth: string;
  autoDepth: boolean;
  minTokens: string;
  targetTokens: string;
  maxTokens: string;
  preserveCodeBlocks: boolean;
  preserveTables: boolean;
}

const STEPS: BuildWizardSetupStep[] = [
  'project', 'sources', 'provider', 'model', 'hierarchy', 'document',
];

const STEP_TITLES: Record<BuildWizardStep, string> = {
  project: '1/6 Project Name',
  sources: '2/6 Input Sources',
  provider: '3/6 AI Provider',
  model: '4/6 AI Model',
  hierarchy: '5/6 Hierarchy Settings',
  document: '6/6 Document Settings',
  analysis: '7/12 Analysis',
  preview: '8/12 Structure Preview',
  confirmation: '9/12 Confirmation',
  generation: '10/12 Generation',
  validation: '11/12 Validation',
  complete: '12/12 Complete',
  failed: 'Build Failed',
};

const DEFAULT_DRAFT: BuildWizardDraft = {
  projectName: '',
  sourcePath: '',
  provider: 'openai',
  model: '',
  minDepth: '1',
  maxDepth: '5',
  autoDepth: true,
  minTokens: '150',
  targetTokens: '1000',
  maxTokens: '2000',
  preserveCodeBlocks: true,
  preserveTables: true,
};

type TextField = 'projectName' | 'sourcePath' | 'model' | 'minDepth' | 'maxDepth' |
  'minTokens' | 'targetTokens' | 'maxTokens';

const STEP_FIELDS: Record<BuildWizardSetupStep, readonly string[]> = {
  project: ['projectName'],
  sources: ['sourcePath'],
  provider: ['provider'],
  model: ['model'],
  hierarchy: ['minDepth', 'maxDepth', 'autoDepth'],
  document: [
    'minTokens', 'targetTokens', 'maxTokens', 'preserveCodeBlocks', 'preserveTables',
  ],
};

export function validateBuildWizardStep(
  step: BuildWizardSetupStep,
  draft: BuildWizardDraft,
): string | undefined {
  if (step === 'project') {
    return projectNameSchema.safeParse(draft.projectName).success
      ? undefined
      : 'Use 1-64 lowercase letters, digits, and hyphens; start and end with a letter or digit.';
  }
  if (step === 'sources') {
    try {
      const info = lstatSync(draft.sourcePath);
      if (info.isSymbolicLink()) return 'Symbolic links cannot be used as source paths.';
      if (info.isFile() && !['.md', '.markdown'].includes(extname(draft.sourcePath).toLowerCase())) {
        return 'Choose a Markdown file or a directory containing Markdown files.';
      }
      if (!info.isFile() && !info.isDirectory()) {
        return 'Choose a regular Markdown file or directory.';
      }
      if (loadMarkdownSources(draft.sourcePath).length === 0) {
        return 'The source directory contains no Markdown files.';
      }
    } catch (error) {
      return error instanceof Error ? error.message : 'Unable to read the Markdown source.';
    }
    return undefined;
  }
  if (step === 'provider') {
    return ['openai', 'openai-compatible'].includes(draft.provider)
      ? undefined
      : 'Choose a supported AI provider.';
  }
  if (step === 'model') {
    return draft.model.trim().length > 0 ? undefined : 'Enter an AI model name.';
  }
  if (step === 'hierarchy') {
    const minimum = parsePositiveInteger(draft.minDepth);
    const maximum = parsePositiveInteger(draft.maxDepth);
    if (minimum === undefined || maximum === undefined) {
      return 'Minimum and maximum depth must be positive whole numbers.';
    }
    return maximum >= minimum ? undefined : 'Maximum depth must be at least the minimum depth.';
  }

  const minimum = parsePositiveInteger(draft.minTokens);
  const target = parsePositiveInteger(draft.targetTokens);
  const maximum = parsePositiveInteger(draft.maxTokens);
  if (minimum === undefined || target === undefined || maximum === undefined) {
    return 'Document token limits must be positive whole numbers.';
  }
  return minimum <= target && target <= maximum
    ? undefined
    : 'Token limits must satisfy minimum <= target <= maximum.';
}

export interface BuildWizardProps {
  dataRoot: string;
  onCancel: () => void;
  onBuildComplete: (projectName: string) => void;
  providerFactory?: (settings: Settings) => AIProvider;
}

export function BuildWizard({
  dataRoot,
  onCancel,
  onBuildComplete,
  providerFactory = createConfiguredBuildProvider,
}: BuildWizardProps): React.JSX.Element {
  const { exit } = useApp();
  const [step, setStep] = useState<BuildWizardStep>('project');
  const [draft, setDraft] = useState<BuildWizardDraft>(() => ({ ...DEFAULT_DRAFT }));
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [prepared, setPrepared] = useState<PreparedKnowledgeBuild | undefined>();
  const [progress, setProgress] = useState<BuildProgressEvent | undefined>();
  const [result, setResult] = useState<BuildProjectKnowledgeResult | undefined>();
  const controller = useRef<AbortController | undefined>(undefined);
  const options = useRef<BuildProjectKnowledgeOptions | undefined>(undefined);

  const updateTextField = (field: TextField, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(undefined);
  };

  const stepBack = (): void => {
    const currentIndex = STEPS.indexOf(step as BuildWizardSetupStep);
    if (currentIndex <= 0) {
      onCancel();
      return;
    }
    setStep(STEPS[currentIndex - 1] ?? 'project');
    setFieldIndex(0);
    setError(undefined);
  };

  const startAnalysis = async (): Promise<void> => {
    setError(undefined);
    setProgress(undefined);
    setPrepared(undefined);
    setResult(undefined);
    setStep('analysis');
    const analysisController = new AbortController();
    controller.current = analysisController;
    try {
      const project = listProjects(dataRoot).find(({ name }) => name === draft.projectName);
      if (project === undefined) {
        throw new Error(`Project not found: ${draft.projectName}. Create it from the Projects screen first.`);
      }
      const settings = settingsSchema.parse({
        ai: { provider: draft.provider, model: draft.model },
      });
      const provider = providerFactory(settings);
      const projectRoot = join(dataRoot, 'projects', project.name);
      const buildOptions: BuildProjectKnowledgeOptions = {
        sourcePath: draft.sourcePath,
        projectRoot,
        knowledgeRoot: join(projectRoot, 'knowledge'),
        project,
        provider,
        model: draft.model,
        hierarchySettings: {
          minDepth: Number(draft.minDepth),
          maxDepth: Number(draft.maxDepth),
          autoDepth: draft.autoDepth,
        },
        documentSettings: {
          minTokens: Number(draft.minTokens),
          targetTokens: Number(draft.targetTokens),
          maxTokens: Number(draft.maxTokens),
          preserveCodeBlocks: draft.preserveCodeBlocks,
          preserveTables: draft.preserveTables,
        },
        signal: analysisController.signal,
        onProgress: setProgress,
      };
      options.current = buildOptions;
      const preparedBuild = await prepareProjectKnowledgeBuild(buildOptions);
      setPrepared(preparedBuild);
      setStep('preview');
    } catch (cause) {
      setError(cause instanceof BuildCancelledError
        ? 'Analysis cancelled; no generated documents were written.'
        : getBuildErrorMessage(cause));
      setStep('failed');
    } finally {
      if (controller.current === analysisController) controller.current = undefined;
    }
  };

  const confirmBuild = async (): Promise<void> => {
    if (prepared === undefined || options.current === undefined) return;
    const buildController = new AbortController();
    controller.current = buildController;
    const buildOptions = { ...options.current, signal: buildController.signal };
    options.current = buildOptions;
    setError(undefined);
    setProgress(undefined);
    setStep('generation');
    buildOptions.onProgress = (event) => {
      setProgress(event);
      if (event.stage === 'verifying' || event.stage === 'committing' || event.stage === 'indexing') {
        setStep('validation');
      } else if (event.stage === 'generating') {
        setStep('generation');
      }
    };
    try {
      const buildResult = await executePreparedKnowledgeBuild(prepared, buildOptions);
      setResult(buildResult);
      setStep('complete');
      onBuildComplete(draft.projectName);
    } catch (cause) {
      setError(cause instanceof BuildCancelledError
        ? 'Build cancelled before commit; generated documents were not written.'
        : getBuildErrorMessage(cause));
      setStep('failed');
    } finally {
      controller.current = undefined;
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      if (controller.current !== undefined) controller.current.abort();
      else exit();
      return;
    }
    if (key.escape || (key.ctrl && input.toLowerCase() === 'b')) {
      if (step === 'complete') onCancel();
      else if (step === 'analysis') controller.current?.abort();
      else if (step === 'generation' || step === 'validation') {
        if (progress?.stage !== 'committing' && progress?.stage !== 'indexing') {
          controller.current?.abort();
        }
      } else if (step === 'preview') {
        setPrepared(undefined);
        setStep('document');
      } else if (step === 'confirmation') setStep('preview');
      else if (step === 'failed') {
        if (prepared !== undefined) setStep('preview');
        else setStep('document');
      } else stepBack();
      return;
    }
    if (step === 'complete') {
      if (input.toLowerCase() === 'q') {
        exit();
        return;
      }
      if (key.return) onCancel();
      return;
    }

    if (step === 'analysis' || step === 'generation' || step === 'validation') return;
    if (step === 'preview') {
      if (key.return) setStep('confirmation');
      return;
    }
    if (step === 'confirmation') {
      if (input.toLowerCase() === 'y') void confirmBuild();
      else if (input.toLowerCase() === 'n') setStep('preview');
      return;
    }
    if (step === 'failed') {
      if (key.return) {
        if (prepared !== undefined) setStep('preview');
        else setStep('document');
      }
      return;
    }

    const fields = STEP_FIELDS[step];
    const field = fields[fieldIndex] ?? fields[0];
    if (input.toLowerCase() === 'q' && !isTextField(field)) {
      exit();
      return;
    }
    if (key.tab) {
      setFieldIndex((index) => key.shift
        ? (index + fields.length - 1) % fields.length
        : (index + 1) % fields.length);
      return;
    }
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      if (field === 'provider') {
        setDraft((current) => ({
          ...current,
          provider: current.provider === 'openai' ? 'openai-compatible' : 'openai',
        }));
      } else if (field === 'autoDepth' || field === 'preserveCodeBlocks' || field === 'preserveTables') {
        setDraft((current) => ({ ...current, [field]: !current[field] }));
      }
      return;
    }
    if (input === ' ' && (field === 'autoDepth' || field === 'preserveCodeBlocks' || field === 'preserveTables')) {
      setDraft((current) => ({ ...current, [field]: !current[field] }));
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'u') {
      if (field !== undefined && ['projectName', 'sourcePath', 'model', 'minDepth', 'maxDepth', 'minTokens', 'targetTokens', 'maxTokens'].includes(field)) {
        updateTextField(field as TextField, '');
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (field !== undefined && ['projectName', 'sourcePath', 'model', 'minDepth', 'maxDepth', 'minTokens', 'targetTokens', 'maxTokens'].includes(field)) {
        updateTextField(field as TextField, draft[field as TextField].slice(0, -1));
      }
      return;
    }
    if (key.return) {
      const validationError = validateBuildWizardStep(step, draft);
      if (validationError !== undefined) {
        setError(validationError);
        return;
      }
      setError(undefined);
      if (step === 'document') {
        void startAnalysis();
        return;
      }
      const nextIndex = STEPS.indexOf(step) + 1;
      setStep(STEPS[nextIndex] ?? 'document');
      setFieldIndex(0);
      return;
    }
    if (field !== undefined && ['projectName', 'sourcePath', 'model', 'minDepth', 'maxDepth', 'minTokens', 'targetTokens', 'maxTokens'].includes(field) && input.length > 0 && !key.ctrl && !key.meta) {
      const textField = field as TextField;
      updateTextField(textField, draft[textField] + input);
    }
  });

  const activeField = STEPS.includes(step as (typeof STEPS)[number])
    ? STEP_FIELDS[step as (typeof STEPS)[number]][fieldIndex]
    : undefined;
  const field = (name: string, value: string): React.JSX.Element => (
    <Text key={name}>
      {activeField === name ? '> ' : '  '}{name}: {value || '(empty)'}{activeField === name ? '_' : ''}
    </Text>
  );
  const toggleField = (name: string, value: boolean): React.JSX.Element => (
    <Text key={name}>
      {activeField === name ? '> ' : '  '}{name}: {value ? 'yes' : 'no'}
    </Text>
  );

  return (
    <Box flexDirection="column">
      <Text bold>{STEP_TITLES[step]}</Text>
      {step === 'project' ? field('projectName', draft.projectName) : null}
      {step === 'sources' ? field('sourcePath', draft.sourcePath) : null}
      {step === 'provider' ? <Text>{activeField === 'provider' ? '> ' : '  '}provider: {draft.provider}</Text> : null}
      {step === 'model' ? field('model', draft.model) : null}
      {step === 'hierarchy' ? (
        <>
          {field('minDepth', draft.minDepth)}
          {field('maxDepth', draft.maxDepth)}
          {toggleField('autoDepth', draft.autoDepth)}
        </>
      ) : null}
      {step === 'document' ? (
        <>
          {field('minTokens', draft.minTokens)}
          {field('targetTokens', draft.targetTokens)}
          {field('maxTokens', draft.maxTokens)}
          {toggleField('preserveCodeBlocks', draft.preserveCodeBlocks)}
          {toggleField('preserveTables', draft.preserveTables)}
        </>
      ) : null}
      {step === 'complete' ? (
        <>
          <Text>Built project {draft.projectName}: {result?.sources ?? 0} source(s), {result?.sections ?? 0} section(s), {formatCount(result?.categories ?? 0, 'category')}, {result?.documents ?? 0} document(s).</Text>
          <Text>Index now contains {result?.index.documents ?? 0} document(s).</Text>
          <Text>Validation passed; the generated documents were committed and indexed.</Text>
          {result?.commit.created.map((path) => <Text key={`created-${path}`}>Created: {path}</Text>)}
          {result?.commit.updated.map((path) => <Text key={`updated-${path}`}>Updated: {path}</Text>)}
          {result?.commit.removed.map((path) => <Text key={`removed-${path}`}>Removed: {path}</Text>)}
          <Text>Press Enter to return to the dashboard.</Text>
        </>
      ) : (
        <>
          {step === 'preview' ? <HierarchyPreview prepared={prepared} /> : null}
          {step === 'confirmation' ? <Text>Generate documents and update the project? Press y to confirm or Esc to return to the preview.</Text> : null}
          {step === 'analysis' || step === 'generation' || step === 'validation' ? (
            <Text>{progress?.stage ?? (step === 'analysis' ? 'Preparing sources and hierarchy...' : 'Starting build...')}{progress?.completed === undefined ? '' : ` (${progress.completed}/${progress.total ?? '?'})`}{progress?.message ? `: ${progress.message}` : ''}</Text>
          ) : null}
          {step === 'failed' && error !== undefined ? <Text color="red">{error}{'\n'}Press Enter to return to the preview or setup.</Text> : null}
          {step !== 'failed' && error !== undefined ? <Text color="red">{error}</Text> : null}
          {STEPS.includes(step as (typeof STEPS)[number]) ? <Text>Tab changes field; arrows or Space change choices; Enter validates; Esc or Ctrl+B goes back.</Text> : null}
          {step === 'preview' ? <Text>Enter to review confirmation; Esc returns to setup.</Text> : null}
        </>
      )}
    </Box>
  );
}

function HierarchyPreview({ prepared }: { prepared: PreparedKnowledgeBuild | undefined }): React.JSX.Element {
  const lines = prepared === undefined ? [] : renderHierarchy(prepared.hierarchy);
  return (
    <Box flexDirection="column">
      <Text>{prepared?.sources.length ?? 0} source(s), {prepared?.sections.length ?? 0} section(s); proposed structure:</Text>
      {lines.length === 0 ? <Text>(no documents)</Text> : lines.map((line) => <Text key={line.key}>{line.text}</Text>)}
    </Box>
  );
}

function renderHierarchy(
  hierarchy: PreparedKnowledgeBuild['hierarchy'],
): Array<{ key: string; text: string }> {
  const lines: Array<{ key: string; text: string }> = [];
  const visit = (nodes: PreparedKnowledgeBuild['hierarchy'], depth: number): void => {
    for (const node of nodes) {
      lines.push({
        key: node.id,
        text: `${'  '.repeat(depth)}${node.type === 'category' ? '[Category]' : '[Document]'} ${node.name}${node.type === 'document' ? ` (${node.path})` : ''}`,
      });
      visit(node.children ?? [], depth + 1);
    }
  };
  visit(hierarchy, 0);
  return lines;
}

function getBuildErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The knowledge build failed unexpectedly.';
}

function formatCount(count: number, singular: string): string {
  const plural = singular.endsWith('y')
    ? `${singular.slice(0, -1)}ies`
    : `${singular}s`;
  return `${count} ${count === 1 ? singular : plural}`;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isTextField(field: string | undefined): field is TextField {
  return field !== undefined && [
    'projectName', 'sourcePath', 'model', 'minDepth', 'maxDepth', 'minTokens', 'targetTokens', 'maxTokens',
  ].includes(field);
}
