import { describe, it, expect } from 'vitest';
import { spawnAndDetect, killAndCleanup, suppressIo, type SpawnRun } from '../harness.js';

const ITERATIONS = Number(process.env.COLD_SPAWN_ITERATIONS ?? 20);

interface Sample {
  iter: number;
  truth: string | null;
  detected: string | null;
  matched: boolean;
  latencyMs: number;
  method: string | null;
  truthLatencyMs: number;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe(`cold-spawn × ${ITERATIONS}`, () => {
  it(
    'detection rate and latency for sequential Claude cold spawns',
    async () => {
      const samples: Sample[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        let run: SpawnRun | undefined;
        try {
          run = await spawnAndDetect({ agent: 'claude' });
          suppressIo(run.proc);
          samples.push({
            iter: i,
            truth: run.truth?.sessionId ?? null,
            detected: run.detected.sessionId,
            matched: run.matched,
            latencyMs: run.detected.latencyMs,
            method: run.detected.method,
            truthLatencyMs: run.truth?.latencyMs ?? -1,
          });
        } catch (err) {
          samples.push({
            iter: i,
            truth: null,
            detected: null,
            matched: false,
            latencyMs: -1,
            method: null,
            truthLatencyMs: -1,
          });
          console.error(`iter ${i} threw:`, (err as Error).message);
        } finally {
          if (run) await killAndCleanup(run);
        }
        // brief breather so STATE_DIR isn't hammered
        await new Promise((r) => setTimeout(r, 200));
      }

      const detected = samples.filter((s) => s.detected !== null).length;
      const truthFound = samples.filter((s) => s.truth !== null).length;
      const matched = samples.filter((s) => s.matched).length;
      const lats = samples.filter((s) => s.matched).map((s) => s.latencyMs);
      const truthLats = samples.filter((s) => s.truth).map((s) => s.truthLatencyMs);
      const methods = samples.reduce<Record<string, number>>((acc, s) => {
        const k = s.method ?? 'none';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});

      const matchRate = matched / ITERATIONS;
      const detectRate = detected / ITERATIONS;
      const truthRate = truthFound / ITERATIONS;

      console.log('');
      console.log('=== cold-spawn report (claude) ===');
      console.log(`iterations:    ${ITERATIONS}`);
      console.log(`truth found:   ${truthFound} (${(truthRate * 100).toFixed(1)}%)`);
      console.log(`detected:      ${detected} (${(detectRate * 100).toFixed(1)}%)`);
      console.log(`matched:       ${matched} (${(matchRate * 100).toFixed(1)}%)`);
      console.log(
        `tracker p50/p95/p99 ms: ${percentile(lats, 50)} / ${percentile(lats, 95)} / ${percentile(lats, 99)} (max ${Math.max(0, ...lats)})`,
      );
      console.log(
        `truth   p50/p95/p99 ms: ${percentile(truthLats, 50)} / ${percentile(truthLats, 95)} / ${percentile(truthLats, 99)} (max ${Math.max(0, ...truthLats)})`,
      );
      console.log(`methods: ${JSON.stringify(methods)}`);
      const failures = samples.filter((s) => !s.matched);
      if (failures.length > 0) {
        console.log(`failures (${failures.length}):`);
        for (const f of failures.slice(0, 5)) {
          console.log(`  iter ${f.iter}: truth=${f.truth} detected=${f.detected} method=${f.method}`);
        }
      }
      console.log('');

      // Phase-1 reliability gate.
      expect(matchRate, `match rate ${(matchRate * 100).toFixed(1)}% below 95%`).toBeGreaterThanOrEqual(0.95);
      expect(percentile(lats, 95), `p95 latency ${percentile(lats, 95)}ms above 10s`).toBeLessThanOrEqual(10_000);
    },
    // 30s per iteration headroom (real ~6s + 200ms breather + cleanup overhead).
    ITERATIONS * 30_000,
  );
});
