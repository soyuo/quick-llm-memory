import { describe, expect, it } from 'vitest';

describe('Vitest TypeScript setup', () => {
  it('runs TypeScript test files', () => {
    const values: number[] = [2, 3];
    const total: number = values.reduce((sum, value) => sum + value, 0);

    expect(total).toBe(5);
  });
});
