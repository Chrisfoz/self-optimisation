/**
 * Mobile control usability — on a phone-sized touch screen, mid-game, are
 * the things a child has to hit big enough to hit, and do they sit on top of
 * each other?
 *
 * 44×44 CSS px is the common minimum tap target (Apple HIG; WCAG 2.5.5's AAA
 * target is 44 too). Measured from the real rendered layout in Chromium, at
 * 390×844 with touch — not from the source, which says what was intended.
 * Deterministic for a given tree. Also hands back a screenshot of that
 * mid-game layout, which is what "visual clarity" can honestly be here: a
 * picture for a model or a person to judge, not a number.
 *
 * Never gating.
 */

import path from 'node:path';
import { openGame, startLevel } from './_browser.mjs';

const MIN = 44;

export async function evaluate({ repoRoot, artifactsDir }) {
  const { page, close } = await openGame(repoRoot);
  try {
    await startLevel(page, 'easy');
    const targets = await page.evaluate(() => {
      const sel = 'button, [role="button"], a[href], input, select, #joystickBase, #shootButton, #pauseButtonMobile';
      return [...document.querySelectorAll(sel)]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
          return { id: el.id || el.textContent.trim().slice(0, 20) || el.tagName.toLowerCase(), x: r.x, y: r.y, w: r.width, h: r.height, visible };
        })
        .filter((t) => t.visible);
    });
    const small = targets.filter((t) => Math.min(t.w, t.h) < MIN);
    let overlaps = 0;
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i]; const b = targets[j];
        const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ix > 4 && iy > 4) overlaps += 1;
      }
    }
    const smallest = targets.length ? Math.min(...targets.map((t) => Math.min(t.w, t.h))) : null;

    const artifacts = [];
    if (artifactsDir) {
      await page.screenshot({ path: path.join(artifactsDir, 'phone-midgame.png') });
      artifacts.push({ kind: 'image', file: 'phone-midgame.png', label: 'Germ Fighter mid-game at 390×844 (touch)' });
    }

    return {
      metrics: [
        { name: `tap targets under ${MIN}px (mid-game, phone)`, value: small.length, direction: 'lower', detail: small.length ? small.map((t) => `${t.id} ${Math.round(t.w)}×${Math.round(t.h)}`).join('; ').slice(0, 400) : `all ${targets.length} visible targets are at least ${MIN}px` },
        ...(smallest !== null ? [{ name: 'smallest tap target (mid-game, phone)', value: Math.round(smallest), unit: 'px', direction: 'higher' }] : []),
        { name: 'overlapping tap targets (mid-game, phone)', value: overlaps, direction: 'lower' },
      ],
      artifacts,
    };
  } finally {
    await close();
  }
}

export default { name: 'mobile-controls', evaluate };
