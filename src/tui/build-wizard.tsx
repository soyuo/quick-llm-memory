import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { extname } from 'node:path';
import { lstatSync } from 'node:fs';
import { loadMarkdownSources } from '../knowledge/source.js';
import { projectNameSchema } from '../projects/schema.js';

export type BuildWizardStep =
  | 'project'
  | 'sources'
  | 'provider'
  | 'model'
  | 'hierarchy'
  | 'document'
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
  theme: 'light' | 'dark';
}

const STEPS: Exclude<BuildWizardStep, 'complete'>[] = [
  'project', 'sources', 'provider', 'model', 'hierarchy', 'document',
];

const STEP_TITLES: Record<BuildWizardStep, string> = {
  project: '1/6 Project Name',
  sources: '2/6 Input Sources',
  provider: '3/6 AI Provider',
  model: '4/6 AI Model',
  hierarchy: '5/6 Hierarchy Settings',
  document: '6/6 Document Settings',
  complete: 'Setup Ready',
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
  theme: 'dark',
};

type TextField = 'projectName' | 'sourcePath' | 'model' | 'minDepth' | 'maxDepth' |
  'minTokens' | 'targetTokens' | 'maxTokens';

const STEP_FIELDS: Record<Exclude<BuildWizardStep, 'complete'>, readonly string[]> = {
  project: ['projectName'],
  sources: ['sourcePath'],
  provider: ['provider'],
  model: ['model'],
  hierarchy: ['minDepth', 'maxDepth', 'autoDepth'],
  document: [
    'minTokens', 'targetTokens', 'maxTokens', 'preserveCodeBlocks', 'preserveTables', 'theme',
  ],
};

export function validateBuildWizardStep(
  step: Exclude<BuildWizardStep, 'complete'>,
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
  onCancel: () => void;
}

export function BuildWizard({ onCancel }: BuildWizardProps): React.JSX.Element {
  const { exit } = useApp();
  const [step, setStep] = useState<BuildWizardStep>('project');
  const [draft, setDraft] = useState<BuildWizardDraft>(() => ({ ...DEFAULT_DRAFT }));
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string | undefined>();

  const updateTextField = (field: TextField, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(undefined);
  };

  const stepBack = (): void => {
    const currentIndex = STEPS.indexOf(step as Exclude<BuildWizardStep, 'complete'>);
    if (currentIndex <= 0) {
      onCancel();
      return;
    }
    setStep(STEPS[currentIndex - 1] ?? 'project');
    setFieldIndex(0);
    setError(undefined);
  };

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      exit();
      return;
    }
    if (key.escape || (key.ctrl && input.toLowerCase() === 'b')) {
      if (step === 'complete') onCancel();
      else stepBack();
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
      } else if (field === 'theme') {
        setDraft((current) => ({ ...current, theme: current.theme === 'dark' ? 'light' : 'dark' }));
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
      const nextIndex = STEPS.indexOf(step) + 1;
      setStep(STEPS[nextIndex] ?? 'complete');
      setFieldIndex(0);
      return;
    }
    if (field !== undefined && ['projectName', 'sourcePath', 'model', 'minDepth', 'maxDepth', 'minTokens', 'targetTokens', 'maxTokens'].includes(field) && input.length > 0 && !key.ctrl && !key.meta) {
      const textField = field as TextField;
      updateTextField(textField, draft[textField] + input);
    }
  });

  const activeField = step === 'complete' ? undefined : STEP_FIELDS[step][fieldIndex];
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
          <Text>{activeField === 'theme' ? '> ' : '  '}theme: {draft.theme}</Text>
        </>
      ) : null}
      {step === 'complete' ? (
        <>
          <Text>Project: {draft.projectName}</Text>
          <Text>Markdown source: {draft.sourcePath}</Text>
          <Text>AI: {draft.provider} / {draft.model}</Text>
          <Text>Hierarchy: depth {draft.minDepth}-{draft.maxDepth}, auto {draft.autoDepth ? 'on' : 'off'}</Text>
          <Text>Document: {draft.minTokens}/{draft.targetTokens}/{draft.maxTokens} tokens, theme {draft.theme}, preserve code/tables {draft.preserveCodeBlocks ? 'yes' : 'no'}/{draft.preserveTables ? 'yes' : 'no'}</Text>
          <Text>Setup validated. No project or settings files were changed; no build was started.</Text>
          <Text>Press Enter or Esc to return to navigation.</Text>
        </>
      ) : (
        <>
          {error === undefined ? null : <Text color="red">{error}</Text>}
          <Text>Tab changes field; arrows or Space change choices; Enter validates; Esc or Ctrl+B goes back.</Text>
        </>
      )}
    </Box>
  );
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
