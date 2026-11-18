import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { ConfigurationError } from '../config/error.js';
import type { SettingsPaths } from '../config/paths.js';
import { loadSettings } from '../config/settings.js';
import { settingsSchema, type Settings } from '../config/schema.js';
import { updateSettings, type EditableSettingsValues } from '../config/settings-editor.js';
import { sanitizeTerminalText } from './terminal-text.js';

const PROVIDERS = ['openai', 'openai-compatible', 'codex-cli', 'claude-code'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
const FIELD_NAMES = ['Provider', 'Model', 'Embedding model', 'Logging level', 'Generation response cache'] as const;

export interface SettingsScreenProps {
  paths: SettingsPaths;
  onBack?: () => void;
  onExit?: () => void;
}

export function SettingsScreen({ paths, onBack, onExit }: SettingsScreenProps): React.JSX.Element {
  const { exit } = useApp();
  const [loaded, setLoaded] = useState(() => readInitialSettings(paths));
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editingModel, setEditingModel] = useState<'model' | 'embeddingModel'>();
  const [modelDraft, setModelDraft] = useState(loaded.values?.model ?? '');
  const [message, setMessage] = useState(loaded.error);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(loaded.values));
  const [discardArmed, setDiscardArmed] = useState(false);
  const values = loaded.values;
  const dirty = values !== undefined && JSON.stringify(values) !== savedSnapshot;

  useInput((input, key) => {
    if ((input.toLowerCase() === 'q' && !editingModel) || (key.ctrl && input.toLowerCase() === 'c')) {
      onExit?.();
      exit();
      return;
    }
    if (key.escape) {
      if (editingModel) {
        setEditingModel(undefined);
        setModelDraft(values?.[editingModel] ?? '');
      } else if (dirty && !discardArmed) {
        setDiscardArmed(true);
        setMessage('Unsaved changes. Press s to save, or Esc again to discard them.');
      } else {
        onBack?.();
      }
      return;
    }
    if (discardArmed) {
      setDiscardArmed(false);
    }
    if (values === undefined) {
      return;
    }

    if (editingModel) {
      if (key.return) {
        setEditingModel(undefined);
        setLoaded({ values: { ...values, [editingModel]: modelDraft.trim() } });
        setMessage(undefined);
      } else if (key.backspace || input === '\u007f' || input === '\b') {
        setModelDraft((draft) => draft.slice(0, -1));
      } else if (input.length > 0 && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f-\u009f]/.test(input)) {
        setModelDraft((draft) => draft + input);
      }
      return;
    }

    if (key.upArrow) {
      setFieldIndex((index) => (index + FIELD_NAMES.length - 1) % FIELD_NAMES.length);
    } else if (key.downArrow) {
      setFieldIndex((index) => (index + 1) % FIELD_NAMES.length);
    } else if (fieldIndex === 0 && (key.leftArrow || key.rightArrow)) {
      const direction = key.rightArrow ? 1 : -1;
      setLoaded({ values: { ...values, provider: cycleValue(PROVIDERS, values.provider, direction) } });
      setMessage(undefined);
    } else if (fieldIndex === 3 && (key.leftArrow || key.rightArrow)) {
      const direction = key.rightArrow ? 1 : -1;
      setLoaded({ values: { ...values, loggingLevel: cycleValue(LOG_LEVELS, values.loggingLevel, direction) } });
      setMessage(undefined);
    } else if (fieldIndex === 4 && (key.leftArrow || key.rightArrow)) {
      setLoaded({ values: { ...values, cacheGeneration: !values.cacheGeneration } });
      setMessage(undefined);
    } else if ((fieldIndex === 1 || fieldIndex === 2) && key.return) {
      const modelField = fieldIndex === 1 ? 'model' : 'embeddingModel';
      setModelDraft(values[modelField]);
      setEditingModel(modelField);
      setMessage('Edit the model, press Enter to keep it, or Esc to discard the edit.');
    } else if (input.toLowerCase() === 's') {
      try {
        const parsed = settingsSchema.parse({
          ai: {
            provider: values.provider,
            cache_generation: values.cacheGeneration,
            embedding_model: values.embeddingModel,
            ...(values.model.length > 0 ? { model: values.model } : {}),
          },
          logging: { level: values.loggingLevel },
        });
        const saved = updateSettings(toEditableSettings(parsed), { paths });
        const nextValues = toEditableSettings(saved);
        setLoaded({ values: nextValues });
        setModelDraft(nextValues.model);
        setSavedSnapshot(JSON.stringify(nextValues));
        setMessage('Settings saved to config.yaml.');
      } catch (error) {
        setMessage(error instanceof ConfigurationError
          ? 'Settings were not saved. Check config.yaml syntax and permissions; keep credentials in environment variables.'
          : 'Invalid settings; the existing config.yaml was left unchanged.');
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Settings{dirty ? ' (unsaved changes)' : ''}</Text>
      <Text>Only settings supported by the application are editable. Provider credentials stay in environment variables.</Text>
      {values === undefined ? (
        <Text>{loaded.error ?? 'Settings could not be loaded.'}</Text>
      ) : (
        <>
          <Text>{fieldIndex === 0 ? '›' : ' '} AI Provider: {sanitizeTerminalText(values.provider)}</Text>
          <Text>{fieldIndex === 1 ? '›' : ' '} AI Model: {sanitizeTerminalText(editingModel === 'model' ? `${modelDraft}▏` : (values.model || '(not set)'))}</Text>
          <Text>{fieldIndex === 2 ? '›' : ' '} Embedding model: {sanitizeTerminalText(editingModel === 'embeddingModel' ? `${modelDraft}▏` : values.embeddingModel)}</Text>
          <Text>{fieldIndex === 3 ? '›' : ' '} Logging level: {sanitizeTerminalText(values.loggingLevel)}</Text>
          <Text>{fieldIndex === 4 ? '›' : ' '} Generation response cache: {values.cacheGeneration ? 'Enabled' : 'Disabled'}</Text>
          {values.provider === 'codex-cli' || values.provider === 'claude-code' ? (
            <Text>Uses your {values.provider === 'codex-cli' ? 'Codex (ChatGPT)' : 'Claude Code'} subscription login; run qlm auth login {values.provider === 'codex-cli' ? 'codex' : 'claude'}. Embeddings still need an OpenAI key.</Text>
          ) : null}
          <Text>Disable generation caching when working with sensitive source documents.</Text>
          <Text>Press s to validate and save; Left/Right changes provider, logging level, or cache setting.</Text>
        </>
      )}
      {message ? <Text>{sanitizeTerminalText(message)}</Text> : null}
      <Text>Up/Down selects a setting, Enter edits a model, s saves, Esc returns, q quits.</Text>
    </Box>
  );
}

function readInitialSettings(paths: SettingsPaths): { values?: EditableSettingsValues; error?: string } {
  try {
    return { values: toEditableSettings(loadSettings({ paths })) };
  } catch {
    return { error: 'Settings could not be loaded. Check config.yaml syntax and values.' };
  }
}

function toEditableSettings(settings: Settings): EditableSettingsValues {
  return {
    provider: settings.ai?.provider ?? 'openai',
    model: settings.ai?.model ?? '',
    embeddingModel: settings.ai?.embedding_model ?? 'text-embedding-3-small',
    cacheGeneration: settings.ai?.cache_generation ?? true,
    loggingLevel: settings.logging.level,
  };
}

function cycleValue<T extends string>(values: readonly T[], current: T, direction: number): T {
  const index = values.indexOf(current);
  const nextIndex = (index + direction + values.length) % values.length;
  return values[nextIndex] ?? values[0] as T;
}
