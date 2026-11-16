import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { getTuiLayout, launchTui, TuiApp } from '../src/tui/app.js';

describe('TUI shell', () => {
  it('renders keyboard navigation and selectable screens', async () => {
    const app = render(<TuiApp columns={120} rows={30} />);

    expect(app.lastFrame()).toContain('› Dashboard [selected]');
    expect(app.lastFrame()).toContain('Navigation');
    expect(app.lastFrame()).toContain('↑/↓ Navigate');

    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('› Projects [selected]');

    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Projects screen is not available yet.');

    app.stdin.write('\u001b');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('› Projects [selected]');

    app.unmount();
  });

  it('switches pane focus with Tab', async () => {
    const app = render(<TuiApp columns={120} rows={30} />);

    await flushInkEffects();
    app.stdin.write('\t');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Quick LLM Memory [focus]');
    expect(app.lastFrame()).toContain('Navigation');
    app.unmount();
  });

  it('selects split, compact, and too-small layouts from terminal dimensions', () => {
    expect(getTuiLayout(120, 30)).toBe('wide');
    expect(getTuiLayout(80, 20)).toBe('compact');
    expect(getTuiLayout(59, 24)).toBe('too-small');
    expect(getTuiLayout(80, 15)).toBe('too-small');

    const app = render(<TuiApp columns={120} rows={30} />);
    expect(app.lastFrame()).toContain('Navigation');
    app.rerender(<TuiApp columns={80} rows={20} />);
    expect(app.lastFrame()).toContain('Projects');
    app.rerender(<TuiApp columns={50} rows={12} />);
    expect(app.lastFrame()).toContain('minimum is 60x16');
    app.unmount();
  });

  it('exits when q is pressed', async () => {
    const onExit = vi.fn();
    const app = render(<TuiApp onExit={onExit} />);

    await flushInkEffects();
    app.stdin.write('q');
    await flushInkEffects();

    expect(onExit).toHaveBeenCalledOnce();
    app.unmount();
  });

  it('explains that the default command requires a terminal', async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return;
    }

    await expect(launchTui()).rejects.toMatchObject({
      message: 'The interactive TUI requires a terminal.',
    });
  });
});

function flushInkEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
