import { describe, it, expect } from 'vitest';
import { spawnAndDetect, killAndCleanup, suppressIo } from './harness.js';

describe('smoke', () => {
  it(
    'claude headless spawn — tracker matches ground truth',
    async () => {
      const run = await spawnAndDetect({ agent: 'claude' });
      suppressIo(run.proc);
      try {
        expect(run.truth, 'no Claude session file appeared (ground truth)').toBeTruthy();
        expect(run.detected.sessionId, 'tracker returned no sessionId').toBeTruthy();
        expect(
          run.matched,
          `mismatch — truth=${run.truth?.sessionId} detected=${run.detected.sessionId}`,
        ).toBe(true);
        expect(run.detected.latencyMs).toBeLessThan(15_000);
      } finally {
        await killAndCleanup(run);
      }
    },
    60_000,
  );
});
