// @vitest-environment jsdom
/**
 * ReplayPlayer.test.ts — Mission B4/GAP-8. Verifies click-ripple styling
 * reads the shared brand token instead of a hardcoded indigo literal, plus
 * basic playback rendering over a sample ReplayEvent[].
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReplayEvent } from '@pinpoint/shared';
import { BRAND_COLORS } from '@pinpoint/shared';
import { mountReplayPlayer } from './ReplayPlayer';

const TEMPLATE = `
  <div data-role="root">
    <div data-role="replay-viewport" style="position:relative;">
      <div data-role="replay-cursor" hidden></div>
      <div data-role="replay-scroll" hidden></div>
    </div>
    <button data-role="replay-play">▶</button>
    <input type="range" data-role="replay-scrubber" />
    <span data-role="replay-time"></span>
  </div>`;

function installTemplate(): void {
  const tpl = document.createElement('template');
  tpl.id = 'replay-player';
  tpl.innerHTML = TEMPLATE;
  document.body.appendChild(tpl);
}

beforeEach(() => {
  document.body.innerHTML = '';
  installTemplate();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function events(): ReplayEvent[] {
  return [
    { type: 'mousemove', timestamp: 0, data: { x: 10, y: 10 } },
    { type: 'click', timestamp: 100, data: { x: 20, y: 30 } },
  ] as unknown as ReplayEvent[];
}

describe('ReplayPlayer', () => {
  it('shows an empty message when there is no replay data', () => {
    const container = document.createElement('div');
    const teardown = mountReplayPlayer(container, []);
    expect(container.textContent).toContain('No replay data available.');
    teardown();
  });

  it('renders a click ripple styled with the brand token (no hardcoded hex)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const teardown = mountReplayPlayer(container, events());

    // Scrub to just after the click so its ripple is "recent".
    const scrubber = container.querySelector<HTMLInputElement>('[data-role="replay-scrubber"]')!;
    scrubber.value = '120';
    scrubber.dispatchEvent(new Event('input'));

    const ripple = container.querySelector('.replay-click-ripple') as HTMLElement | null;
    expect(ripple).not.toBeNull();
    const probe = document.createElement('div');
    probe.style.borderColor = BRAND_COLORS.primary;
    expect(ripple!.style.borderColor).toBe(probe.style.borderColor);
    expect(ripple!.style.cssText).not.toContain('#4f46e5');
    teardown();
  });

  it('drives playback over a sample ReplayEvent[] moving the cursor + scrubber', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const sample: ReplayEvent[] = [
      { type: 'mousemove', timestamp: 0, data: { x: 5, y: 5 } },
      { type: 'mousemove', timestamp: 500, data: { x: 150, y: 90 } },
      { type: 'scroll', timestamp: 800, data: { x: 0, y: 200 } },
      { type: 'click', timestamp: 1000, data: { x: 150, y: 90 } },
    ] as unknown as ReplayEvent[];

    const teardown = mountReplayPlayer(container, sample);

    const cursor = container.querySelector<HTMLElement>('[data-role="replay-cursor"]')!;
    const scrubber = container.querySelector<HTMLInputElement>('[data-role="replay-scrubber"]')!;
    const timeLabel = container.querySelector<HTMLElement>('[data-role="replay-time"]')!;

    // Total duration is last - first = 1000 ms.
    expect(scrubber.max).toBe('1000');

    // Scrub to the first frame: cursor should sit at the first mousemove.
    scrubber.value = '0';
    scrubber.dispatchEvent(new Event('input'));
    expect(cursor.hidden).toBe(false);
    expect(cursor.style.left).toBe('5px');
    expect(cursor.style.top).toBe('5px');

    // Scrub to 600 ms: cursor should track the later mousemove.
    scrubber.value = '600';
    scrubber.dispatchEvent(new Event('input'));
    expect(cursor.style.left).toBe('150px');
    expect(cursor.style.top).toBe('90px');
    expect(scrubber.value).toBe('600');
    expect(timeLabel.textContent).toContain('/ 1.0s');

    teardown();
  });

  it('play button toggles the play/pause glyph', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const teardown = mountReplayPlayer(container, events());
    const playBtn = container.querySelector<HTMLButtonElement>('[data-role="replay-play"]')!;
    expect(playBtn.textContent).toBe('▶');
    playBtn.click();
    expect(playBtn.textContent).toBe('⏸');
    playBtn.click();
    expect(playBtn.textContent).toBe('▶');
    teardown();
  });
});
