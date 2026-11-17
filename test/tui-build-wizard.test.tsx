import React from 'react';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { listProjects } from '../src/projects/manager.js';
import { TuiApp } from '../src/tui/app.js';
import { validateBuildWizardStep, type BuildWizardDraft } from '../src/tui/build-wizard.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TUI knowledge build setup wizard', () => {
  it('validates hierarchy and document setting relationships', () => {
    const draft: BuildWizardDraft = {
      projectName: 'valid-project',
      sourcePath: 'unused',
      provider: 'openai',
      model: 'test-model',
      minDepth: '3',
      maxDepth: '2',
      autoDepth: true,
      minTokens: '150',
      targetTokens: '1000',
      maxTokens: '2000',
      preserveCodeBlocks: true,
      preserveTables: true,
      theme: 'dark',
    };
    expect(validateBuildWizardStep('hierarchy', draft))
      .toBe('Maximum depth must be at least the minimum depth.');
    expect(validateBuildWizardStep('document', { ...draft, maxTokens: '900' }))
      .toBe('Token limits must satisfy minimum <= target <= maximum.');
    expect(validateBuildWizardStep('document', draft)).toBeUndefined();
  });

  it('validates each step, preserves earlier values, and completes without starting a build', async () => {
    const dataRoot = createTemporaryRoot('qlm-wizard-data-');
    const sourceRoot = createTemporaryRoot('qlm-wizard-source-');
    const sourceFile = join(sourceRoot, 'notes.md');
    writeFileSync(sourceFile, '# Notes\n\nSource material.\n');
    const settingsFile = join(dataRoot, 'config', 'config.yaml');
    mkdirSync(join(dataRoot, 'config'));
    writeFileSync(settingsFile, 'logging:\n  level: info\n');

    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await openBuild(app);
    expect(app.lastFrame()).toContain('1/6 Project Name');

    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('lowercase letters');
    app.stdin.write('q');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('projectName: q_');
    app.stdin.write('uick-llm');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('2/6 Input Sources');

    app.stdin.write(sourceFile);
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('3/6 AI Provider');
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('4/6 AI Model');

    app.stdin.write('test-model');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('5/6 Hierarchy Settings');
    app.stdin.write('\t');
    await flushInkEffects();
    app.stdin.write('\x15');
    await flushInkEffects();
    app.stdin.write('4');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('6/6 Document Settings');
    app.stdin.write('\x02');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('maxDepth: 4');
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Setup Ready');
    expect(app.lastFrame()).toContain('Project: quick-llm');
    expect(app.lastFrame()).toContain('Setup validated.');
    expect(app.lastFrame()).toContain('no build was');
    expect(listProjects(dataRoot)).toEqual([]);
    expect(readFileSync(settingsFile, 'utf8')).toBe('logging:\n  level: info\n');
    app.unmount();
  });

  it('blocks invalid source paths at the source step', async () => {
    const dataRoot = createTemporaryRoot('qlm-wizard-invalid-');
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await openBuild(app);
    app.stdin.write('valid-project');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('missing-source');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('2/6 Input Sources');
    expect(app.lastFrame()).toContain('ENOENT');
    expect(listProjects(dataRoot)).toEqual([]);
    app.unmount();
  });
});

function createTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function flushInkEffects(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function openBuild(app: ReturnType<typeof render>): Promise<void> {
  app.stdin.write('\u001b[B');
  await flushInkEffects();
  app.stdin.write('\u001b[B');
  await flushInkEffects();
  app.stdin.write('\r');
  await flushInkEffects();
}
