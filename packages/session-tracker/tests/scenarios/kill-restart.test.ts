import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { spawnAndDetect, killAndCleanup, suppressIo, type SpawnRun } from '../harness.js';

const ITERATIONS = Number(process.env.KILL_RESTART_ITERATIONS ?? 10);

interface Sample {
  iter: number;
  first: { truth: string | null; detected: string | null; matched: boolean };
  second: { truth: string | null; detected: string | null; matched: boolean };
  newSessionWon: boolean; // second.detected !== first.detected (we picked up the NEW session)
  latencyMs: number;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe(`kill-restart × ${ITERATIONS}`, () => {
  it(
    'second spawn in same cwd produces a different session id, and tracker picks the new one',
    async () => {
      const samples: Sample[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        let runA: SpawnRun | undefined;
        let runB: SpawnRun | undefined;
        try {
          // First spawn.
          runA = await spawnAndDetect({ agent: 'claude' });
          suppressIo(runA.proc);
          const cwd = runA.cwd; // reuse so the second spawn is "same workspace"

          // Kill the first agent, wait briefly for state-dir settle.
          // killAndCleanup removes the tmp cwd, so recreate it before reuse —
          // Node's spawn() returns ENOENT when cwd doesn't exist.
          await killAndCleanup(runA);
          await fs.promises.mkdir(cwd, { recursive: true });
          await new Promise((r) => setTimeout(r, 500));

          // Second spawn in the SAME cwd. The state-file path will be a NEW
          // pid; the workspace will have a NEW .jsonl. If the tracker were
          // confused by the leftover first-run state, it would return the
          // OLD session id. We assert it does not.
          runB = await spawnAndDetect({ agent: 'claude', cwd });
          suppressIo(runB.proc);

          const newSessionWon =
            runA.truth !== null &&
            runB.truth !== null &&
            runA.truth.sessionId !== runB.truth.sessionId &&
            runB.detected.sessionId === runB.truth.sessionId;

          samples.push({
            iter: i,
            first: {
              truth: runA.truth?.sessionId ?? null,
              detected: runA.detected.sessionId,
              matched: runA.matched,
            },
            second: {
              truth: runB.truth?.sessionId ?? null,
              detected: runB.detected.sessionId,
              matched: runB.matched,
            },
            newSessionWon,
            latencyMs: runB.detected.latencyMs,
          });
        } catch (err) {
          console.error(`iter ${i} threw:`, (err as Error).message);
          samples.push({
            iter: i,
            first: { truth: null, detected: null, matched: false },
            second: { truth: null, detected: null, matched: false },
            newSessionWon: false,
            latencyMs: -1,
          });
        } finally {
          if (runB) await killAndCleanup(runB);
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      const newWon = samples.filter((s) => s.newSessionWon).length;
      const lats = samples.filter((s) => s.newSessionWon).map((s) => s.latencyMs);
      const newWonRate = newWon / ITERATIONS;

      console.log('');
      console.log('=== kill-restart report (claude) ===');
      console.log(`iterations:        ${ITERATIONS}`);
      console.log(`new-session-won:   ${newWon} (${(newWonRate * 100).toFixed(1)}%)`);
      console.log(
        `tracker p50/p95/p99 ms: ${percentile(lats, 50)} / ${percentile(lats, 95)} / ${percentile(lats, 99)}`,
      );
      const failures = samples.filter((s) => !s.newSessionWon);
      if (failures.length > 0) {
        console.log(`failures (${failures.length}):`);
        for (const f of failures.slice(0, 5)) {
          console.log(
            `  iter ${f.iter}: first.truth=${f.first.truth} second.truth=${f.second.truth} second.detected=${f.second.detected}`,
          );
        }
      }
      console.log('');

      expect(newWonRate, `new-session-won rate ${(newWonRate * 100).toFixed(1)}% below 95%`).toBeGreaterThanOrEqual(
        0.95,
      );
    },
    ITERATIONS * 45_000,
  );
});
