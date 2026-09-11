/**
 * Level completion — can a simple, fixed autoplayer clear Germ Fighter's
 * first easy level, across several seeds?
 *
 * Runs the game's real rules headlessly through tests/game-logic's harness
 * (seeded Math.random, fake clock), so it is deterministic: the same tree
 * gives the same numbers every time, and a change in the numbers is a change
 * in the game. The bot is deliberately dumb and deliberately frozen — steer
 * under the nearest germ, hold fire — because the question is "did the game
 * get harder or easier to finish", not "how good is the bot".
 *
 * Never gating (harness/plugins/evaluators/README.md).
 */

import path from 'node:path';
import { createRequire } from 'node:module';

const FRAME_MS = 16;

function playOnce(loadGermFighter, seed, maxSeconds) {
  const g = loadGermFighter(seed);
  g.api.startGame('easy');
  const steps = Math.round((maxSeconds * 1000) / FRAME_MS);
  let livesLost = 0;
  let lastLives = g.api.state().lives;
  for (let i = 0; i < steps; i++) {
    const s = g.api.state();
    if (s.levelCompleted) return { cleared: true, seconds: (i * FRAME_MS) / 1000, livesLost };
    if (!s.gameRunning || s.lives <= 0) return { cleared: false, seconds: (i * FRAME_MS) / 1000, livesLost, died: true };
    // Steer under the germ closest to the bottom of the screen; hold fire.
    const target = s.germs.reduce((best, germ) => (!best || germ.y > best.y ? germ : best), null);
    const px = s.player.x + (s.player.width ?? 0) / 2;
    s.keys.ArrowLeft = Boolean(target && target.x + (target.size ?? 0) / 2 < px - 8);
    s.keys.ArrowRight = Boolean(target && target.x + (target.size ?? 0) / 2 > px + 8);
    s.keys[' '] = true;
    g.tick(FRAME_MS);
    g.api.update();
    if (s.lives < lastLives) livesLost += lastLives - s.lives;
    lastLives = g.api.state().lives;
  }
  return { cleared: false, seconds: maxSeconds, livesLost, timedOut: true };
}

/**
 * A scenario the autoplayer never produces, because it never gets touched:
 * three germs landing on the player in the same frame. Added after
 * generation 001 changed exactly this and every metric here reported "no
 * change" — the measurement was blind to the dimension the change improved.
 */
function stackedContact(loadGermFighter) {
  const g = loadGermFighter(1);
  g.api.startGame('easy');
  const s = g.api.state();
  const germ = () => ({ x: s.player.x, y: s.player.y, size: 40, speed: 0, points: 10, health: 1, currentHealth: 1, pattern: 'fall', fromWave: false, hitFlash: 0 });
  g.api.set({ germs: [germ(), germ(), germ()], bullets: [], powerups: [], particles: [] });
  const before = g.api.state().lives;
  g.tick(FRAME_MS);
  g.api.update();
  return before - g.api.state().lives;
}

export async function evaluate({ repoRoot, config = {} }) {
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const { loadGermFighter } = require(path.join(repoRoot, 'tests/game-logic/germ-harness.js'));
  const seeds = config.seeds ?? [1, 2, 3, 4, 5];
  const maxSeconds = config.maxSeconds ?? 240;

  const runs = seeds.map((seed) => ({ seed, ...playOnce(loadGermFighter, seed, maxSeconds) }));
  const cleared = runs.filter((r) => r.cleared);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const metrics = [
    {
      name: 'autoplayer clears of easy level 1',
      value: cleared.length,
      unit: `of ${seeds.length} seeds`,
      direction: 'higher',
      detail: runs.map((r) => `seed ${r.seed}: ${r.cleared ? `cleared in ${r.seconds.toFixed(1)}s` : r.died ? `died at ${r.seconds.toFixed(1)}s` : 'ran out of time'}`).join('; '),
    },
    {
      name: 'autoplayer lives lost per run',
      value: Number(mean(runs.map((r) => r.livesLost)).toFixed(2)),
      direction: 'lower',
    },
    {
      name: 'lives lost when three germs land at once',
      value: stackedContact(loadGermFighter),
      direction: 'lower',
      detail: 'one frame, three stationary germs placed on the player, shield off',
    },
  ];
  if (cleared.length) {
    metrics.push({ name: 'autoplayer seconds to clear', value: Number(mean(cleared.map((r) => r.seconds)).toFixed(1)), unit: 's', detail: 'mean over the seeds that cleared; no direction — faster is not obviously better for a child' });
  }
  return metrics;
}

export default { name: 'level-completion', evaluate };
