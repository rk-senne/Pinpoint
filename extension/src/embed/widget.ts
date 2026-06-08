/**
 * Pinpoint Embed Widget
 *
 * Drop-in script that adds a feedback button to any website without
 * requiring the browser extension. Usage:
 *
 *   <script src="https://cdn.pinpoint.app/widget.js"
 *           data-project="PROJECT_ID"
 *           data-api="https://api.pinpoint.app"></script>
 *
 * Features: floating button, annotation mode, screenshot via html2canvas,
 * feedback form submission.
 */

(function () {
  const script = document.currentScript as HTMLScriptElement;
  const projectId = script?.getAttribute('data-project');
  const apiBase = script?.getAttribute('data-api') ?? '';
  const color = script?.getAttribute('data-color') ?? '#4f46e5';

  if (!projectId) { console.warn('[Pinpoint] data-project attribute required'); return; }

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    .pp-widget-btn { position:fixed; bottom:24px; right:24px; width:48px; height:48px; border-radius:50%;
      background:${color}; border:none; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.15);
      display:flex; align-items:center; justify-content:center; z-index:999998; transition:transform .2s; }
    .pp-widget-btn:hover { transform:scale(1.1); }
    .pp-widget-btn svg { width:24px; height:24px; fill:white; }
    .pp-widget-panel { position:fixed; bottom:84px; right:24px; width:320px; background:white;
      border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.12); z-index:999998; padding:20px;
      display:none; font-family:system-ui,sans-serif; }
    .pp-widget-panel.pp-open { display:block; }
    .pp-widget-panel h3 { margin:0 0 12px; font-size:16px; }
    .pp-widget-panel textarea { width:100%; min-height:80px; padding:8px; border:1px solid #e5e7eb;
      border-radius:6px; font-size:14px; resize:vertical; box-sizing:border-box; }
    .pp-widget-panel input { width:100%; padding:8px; border:1px solid #e5e7eb; border-radius:6px;
      font-size:14px; margin-bottom:8px; box-sizing:border-box; }
    .pp-widget-submit { width:100%; padding:10px; background:${color}; color:white; border:none;
      border-radius:6px; font-size:14px; cursor:pointer; margin-top:8px; }
    .pp-widget-submit:disabled { opacity:.5; cursor:not-allowed; }
    .pp-widget-success { text-align:center; padding:20px; color:#10b981; }
  `;
  document.head.appendChild(style);

  // Create button
  const btn = document.createElement('button');
  btn.className = 'pp-widget-btn';
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
  btn.title = 'Send Feedback';
  document.body.appendChild(btn);

  // Create panel
  const panel = document.createElement('div');
  panel.className = 'pp-widget-panel';
  panel.innerHTML = `
    <h3>Send Feedback</h3>
    <input type="email" class="pp-email" placeholder="Your email" />
    <textarea class="pp-body" placeholder="Describe the issue or suggestion..."></textarea>
    <button class="pp-widget-submit">Submit</button>
  `;
  document.body.appendChild(panel);

  btn.addEventListener('click', () => panel.classList.toggle('pp-open'));

  panel.querySelector('.pp-widget-submit')!.addEventListener('click', async () => {
    const body = (panel.querySelector('.pp-body') as HTMLTextAreaElement).value.trim();
    const email = (panel.querySelector('.pp-email') as HTMLInputElement).value.trim();
    if (!body) return;

    const submitBtn = panel.querySelector('.pp-widget-submit') as HTMLButtonElement;
    submitBtn.disabled = true;

    try {
      await fetch(`${apiBase}/api/v1/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          body,
          target: { selector: 'widget-submission', coordinates: { x: 0, y: 0 } },
          environment: { url: window.location.href, viewport: `${innerWidth}x${innerHeight}`, browser: navigator.userAgent },
          metadata: { source: 'widget', email },
        }),
      });
      panel.innerHTML = '<div class="pp-widget-success">✓ Thanks for your feedback!</div>';
      setTimeout(() => { panel.classList.remove('pp-open'); }, 2000);
    } catch {
      submitBtn.disabled = false;
    }
  });
})();
