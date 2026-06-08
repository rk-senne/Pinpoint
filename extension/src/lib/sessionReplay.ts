/**
 * SessionReplay — lightweight DOM event recorder that captures the last
 * N seconds before an annotation is created. Stored alongside the
 * annotation for playback in the dashboard.
 *
 * Records: mouse moves (throttled), clicks, scrolls, input changes,
 * and DOM mutations (via MutationObserver). Circular buffer keeps
 * memory bounded.
 */

export interface ReplayEvent {
  type: 'mousemove' | 'click' | 'scroll' | 'input' | 'mutation' | 'resize';
  timestamp: number;
  data: unknown;
}

const MAX_BUFFER_SECONDS = 10;
const THROTTLE_MS = 50;

export class SessionReplayRecorder {
  private events: ReplayEvent[] = [];
  private observer: MutationObserver | null = null;
  private listeners: Array<[string, EventListener]> = [];
  private recording = false;
  private lastMouseMove = 0;

  start(): void {
    if (this.recording) return;
    this.recording = true;
    this.events = [];

    const push = (evt: ReplayEvent) => {
      evt.timestamp = Date.now();
      this.events.push(evt);
      this.prune();
    };

    const onMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - this.lastMouseMove < THROTTLE_MS) return;
      this.lastMouseMove = now;
      push({ type: 'mousemove', timestamp: 0, data: { x: e.clientX, y: e.clientY } });
    };

    const onClick = (e: MouseEvent) => {
      push({ type: 'click', timestamp: 0, data: { x: e.clientX, y: e.clientY, target: cssPath(e.target as Element) } });
    };

    const onScroll = () => {
      push({ type: 'scroll', timestamp: 0, data: { x: window.scrollX, y: window.scrollY } });
    };

    const onInput = (e: Event) => {
      const target = e.target as HTMLInputElement;
      push({ type: 'input', timestamp: 0, data: { selector: cssPath(target), value: target.value?.slice(0, 100) } });
    };

    const onResize = () => {
      push({ type: 'resize', timestamp: 0, data: { w: window.innerWidth, h: window.innerHeight } });
    };

    this.addListener('mousemove', onMouseMove as EventListener);
    this.addListener('click', onClick as EventListener);
    this.addListener('scroll', onScroll);
    this.addListener('input', onInput);
    this.addListener('resize', onResize);

    this.observer = new MutationObserver((mutations) => {
      const summary = mutations.slice(0, 5).map((m) => ({
        type: m.type,
        target: cssPath(m.target as Element),
        added: m.addedNodes.length,
        removed: m.removedNodes.length,
      }));
      push({ type: 'mutation', timestamp: 0, data: summary });
    });
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }

  stop(): void {
    this.recording = false;
    for (const [event, listener] of this.listeners) {
      document.removeEventListener(event, listener, true);
    }
    this.listeners = [];
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Get the last N seconds of recorded events. */
  getSnapshot(seconds = MAX_BUFFER_SECONDS): ReplayEvent[] {
    const cutoff = Date.now() - seconds * 1000;
    return this.events.filter((e) => e.timestamp >= cutoff);
  }

  private addListener(event: string, listener: EventListener): void {
    document.addEventListener(event, listener, true);
    this.listeners.push([event, listener]);
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_BUFFER_SECONDS * 1000;
    const idx = this.events.findIndex((e) => e.timestamp >= cutoff);
    if (idx > 0) this.events.splice(0, idx);
  }
}

function cssPath(el: Element | null): string {
  if (!el || el === document.body) return 'body';
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  return `${tag}${id}${cls}`;
}
