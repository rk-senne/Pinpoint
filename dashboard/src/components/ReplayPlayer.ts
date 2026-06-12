/**
 * ReplayPlayer — session replay playback component.
 *
 * Renders a playback area that visualises recorded DOM events (mouse moves,
 * clicks, scrolls, resizes) captured by the extension's SessionReplayRecorder.
 * Uses requestAnimationFrame for smooth playback.
 */

import type { ReplayEvent } from '@pinpoint/shared';
import { cloneTemplate } from '../lib/render';

export function mountReplayPlayer(
  container: HTMLElement,
  replayData: ReplayEvent[],
): () => void {
  if (replayData.length === 0) {
    container.textContent = 'No replay data available.';
    return () => { container.replaceChildren(); };
  }

  const fragment = cloneTemplate('replay-player');
  const root = fragment.firstElementChild as HTMLElement;
  container.appendChild(root);

  const viewport = root.querySelector<HTMLElement>('[data-role="replay-viewport"]')!;
  const cursor = root.querySelector<HTMLElement>('[data-role="replay-cursor"]')!;
  const scrollIndicator = root.querySelector<HTMLElement>('[data-role="replay-scroll"]')!;
  const playBtn = root.querySelector<HTMLButtonElement>('[data-role="replay-play"]')!;
  const scrubber = root.querySelector<HTMLInputElement>('[data-role="replay-scrubber"]')!;
  const timeLabel = root.querySelector<HTMLElement>('[data-role="replay-time"]')!;

  const startTime = replayData[0].timestamp;
  const endTime = replayData[replayData.length - 1].timestamp;
  const duration = endTime - startTime || 1;

  let playing = false;
  let playbackStart = 0;
  let currentOffset = 0;
  let rafId = 0;

  scrubber.max = String(duration);
  scrubber.value = '0';

  function formatTime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const frac = Math.floor((ms % 1000) / 100);
    return `${s}.${frac}s`;
  }

  function getEventsUpTo(offset: number): ReplayEvent[] {
    const cutoff = startTime + offset;
    return replayData.filter((e) => e.timestamp <= cutoff);
  }

  function renderFrame(offset: number): void {
    const events = getEventsUpTo(offset);
    // Find last mousemove
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'mousemove') {
        const d = events[i].data as { x: number; y: number };
        cursor.style.left = `${d.x}px`;
        cursor.style.top = `${d.y}px`;
        cursor.hidden = false;
        break;
      }
    }

    // Show scroll indicator for recent scroll events
    const recentScroll = events.filter(
      (e) => e.type === 'scroll' && startTime + offset - e.timestamp < 500,
    );
    scrollIndicator.hidden = recentScroll.length === 0;

    // Show click ripple for recent clicks
    const recentClicks = events.filter(
      (e) => e.type === 'click' && startTime + offset - e.timestamp < 400,
    );
    // Remove old ripples
    viewport.querySelectorAll('.replay-click-ripple').forEach((el) => el.remove());
    for (const click of recentClicks) {
      const d = click.data as { x: number; y: number };
      const age = startTime + offset - click.timestamp;
      const ripple = document.createElement('div');
      ripple.className = 'replay-click-ripple';
      const size = 12 + age * 0.08;
      const opacity = Math.max(0, 1 - age / 400);
      ripple.style.cssText = `position:absolute;left:${d.x}px;top:${d.y}px;width:${size}px;height:${size}px;border-radius:50%;border:2px solid #4f46e5;opacity:${opacity};transform:translate(-50%,-50%);pointer-events:none;`;
      viewport.appendChild(ripple);
    }

    scrubber.value = String(Math.min(offset, duration));
    timeLabel.textContent = `${formatTime(offset)} / ${formatTime(duration)}`;
  }

  function tick(): void {
    if (!playing) return;
    const elapsed = performance.now() - playbackStart;
    currentOffset = Math.min(elapsed, duration);
    renderFrame(currentOffset);
    if (currentOffset >= duration) {
      playing = false;
      playBtn.textContent = '▶';
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function togglePlay(): void {
    if (playing) {
      playing = false;
      cancelAnimationFrame(rafId);
      playBtn.textContent = '▶';
    } else {
      if (currentOffset >= duration) currentOffset = 0;
      playing = true;
      playbackStart = performance.now() - currentOffset;
      playBtn.textContent = '⏸';
      rafId = requestAnimationFrame(tick);
    }
  }

  function onScrub(): void {
    const wasPlaying = playing;
    if (playing) {
      playing = false;
      cancelAnimationFrame(rafId);
    }
    currentOffset = Number(scrubber.value);
    renderFrame(currentOffset);
    if (wasPlaying) {
      playing = true;
      playbackStart = performance.now() - currentOffset;
      rafId = requestAnimationFrame(tick);
    }
  }

  playBtn.addEventListener('click', togglePlay);
  scrubber.addEventListener('input', onScrub);

  // Initial render at t=0
  renderFrame(0);

  return () => {
    playing = false;
    cancelAnimationFrame(rafId);
    playBtn.removeEventListener('click', togglePlay);
    scrubber.removeEventListener('input', onScrub);
    root.remove();
  };
}
