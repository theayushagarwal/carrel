import { describe, expect, it } from 'vitest';
import { contrastRatio, participantColors, readableTextOn } from './index.js';

describe('readableTextOn', () => {
  it('keeps all participant colors readable at WCAG AA contrast', () => {
    for (const color of participantColors) {
      const text = readableTextOn(color);
      expect(contrastRatio(text, color)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
