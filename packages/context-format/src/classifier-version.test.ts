import { describe, expect, it } from 'vitest';
import { CLASSIFIER_VERSION } from './classifier-version';

describe('CLASSIFIER_VERSION', () => {
  // Pinned deliberately: context-sync stamps this onto every snapshot, so a
  // bump re-classifies existing mirrors on next sync. Changing it is a
  // migration decision, not an incidental edit — this test forces the intent.
  it('is 3', () => {
    expect(CLASSIFIER_VERSION).toBe(3);
  });
});
