/**
 * Frame-time stability — mid-game, on a CPU throttled 4× (roughly a low-end
 * tablet), how long does a frame take at the 95th percentile, and what share
 * of frames miss 30fps?
 *
 * Timing in a headless browser is noisy, so both metrics declare a tolerance
 * (harness/lib/measure.mjs): a before/after difference inside it is reported
 * as no change rather than as a regression that is really jitter.
 *
 * Never gating.
 */

import { openGame, startLevel } from './_browser.mjs';

export async function evaluate({ repoRoot, config = {} }) {
  const seconds = config.seconds ?? 4;
  const { page, close } = await openGame(repoRoot, { cpuThrottle: config.cpuThrottle ?? 4 });
  try {
    await startLevel(page, 'easy');
    const deltas = await page.evaluate((ms) => new Promise((resolve) => {
      const out = [];
      let last = performance.now();
      const end = last + ms;
      const step = (t) => {
        out.push(t - last);
        last = t;
        if (t < end) requestAnimationFrame(step); else resolve(out.slice(1));
      };
      requestAnimationFrame(step);
    }), seconds * 1000);
    const sorted = [...deltas].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? null;
    const long = deltas.filter((d) => d > 33.4).length;
    return [
      { name: 'frame time p95 (4× CPU throttle)', value: p95 === null ? 'no frames' : Number(p95.toFixed(1)), unit: 'ms', direction: 'lower', tolerance: 4, detail: `${deltas.length} frames over ${seconds}s` },
      { name: 'frames slower than 30fps (4× CPU throttle)', value: deltas.length ? Number(((long / deltas.length) * 100).toFixed(1)) : 0, unit: '%', direction: 'lower', tolerance: 3 },
    ];
  } finally {
    await close();
  }
}

export default { name: 'frame-time', evaluate };
