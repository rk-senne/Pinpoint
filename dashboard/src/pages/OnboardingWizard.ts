/**
 * OnboardingWizard — guides new users through their first annotation.
 *
 * Steps:
 *   1. Welcome — explains what Pinpoint does
 *   2. Install Extension — link to Chrome Web Store / local dev instructions
 *   3. Create Project — inline form to create first project
 *   4. Make Annotation — explains how to click on a website to annotate
 *   5. Done — celebration + link to dashboard
 *
 * Persists completion state in localStorage. If complete, redirects to '/'.
 * Exposed as `mountOnboardingWizard` matching the RouteHandler shape.
 */

import { navigate } from '../lib/router';
import { apiFetch } from '../lib/api';

const ONBOARDING_COMPLETE_KEY = 'pinpoint_onboarding_complete';

interface WizardStep {
  title: string;
  body: string;
  action?: { label: string; handler: (ctx: WizardContext) => Promise<void> | void };
}

interface WizardContext {
  container: HTMLElement;
  next: () => void;
  projectNameInput?: HTMLInputElement;
}

const steps: WizardStep[] = [
  {
    title: 'Welcome to Pinpoint 👋',
    body: 'Pinpoint lets your team annotate live websites with feedback pins. Let\'s get you set up in under 2 minutes.',
  },
  {
    title: 'Install the Extension',
    body: 'Install the Pinpoint browser extension to start annotating websites. Once installed, you\'ll see the Pinpoint icon in your toolbar.',
    action: {
      label: 'I\'ve installed it',
      handler: (ctx) => ctx.next(),
    },
  },
  {
    title: 'Create Your First Project',
    body: 'A project groups feedback for a website. Enter your site\'s URL to get started.',
    action: {
      label: 'Create Project',
      handler: async (ctx) => {
        const input = ctx.container.querySelector<HTMLInputElement>('#onboarding-project-name');
        const urlInput = ctx.container.querySelector<HTMLInputElement>('#onboarding-project-url');
        if (!input?.value.trim() || !urlInput?.value.trim()) return;
        try {
          await apiFetch('/projects', {
            method: 'POST',
            body: JSON.stringify({ name: input.value.trim(), urls: [urlInput.value.trim()] }),
          });
          ctx.next();
        } catch { /* validation errors handled by API */ }
      },
    },
  },
  {
    title: 'Make Your First Annotation',
    body: 'Navigate to your project\'s website with the extension active. Click anywhere on the page to drop a pin and leave feedback. Try it now!',
    action: { label: 'I\'ve made one!', handler: (ctx) => ctx.next() },
  },
  {
    title: 'You\'re all set! 🎉',
    body: 'Your team can now collaborate on website feedback in real-time. Invite teammates from Settings to get the full experience.',
    action: {
      label: 'Go to Dashboard',
      handler: () => {
        localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
        navigate('/');
      },
    },
  },
];

export function mountOnboardingWizard(container: HTMLElement): () => void {
  if (localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true') {
    navigate('/');
    return () => {};
  }

  let currentStep = 0;

  function render(): void {
    const step = steps[currentStep]!;
    container.innerHTML = `
      <div class="onboarding-wizard" style="max-width:480px;margin:80px auto;padding:32px;text-align:center;">
        <div class="onboarding-progress" style="display:flex;gap:6px;justify-content:center;margin-bottom:32px;">
          ${steps.map((_, i) => `<div style="width:32px;height:4px;border-radius:2px;background:${i <= currentStep ? 'var(--color-primary,#4f46e5)' : '#e5e7eb'}"></div>`).join('')}
        </div>
        <h1 style="font-size:1.5rem;margin-bottom:12px;">${step.title}</h1>
        <p style="color:#6b7280;margin-bottom:24px;">${step.body}</p>
        ${currentStep === 2 ? `
          <input id="onboarding-project-name" type="text" placeholder="Project name" style="display:block;width:100%;padding:8px 12px;margin-bottom:8px;border:1px solid #d1d5db;border-radius:6px;">
          <input id="onboarding-project-url" type="url" placeholder="https://your-site.com" style="display:block;width:100%;padding:8px 12px;margin-bottom:16px;border:1px solid #d1d5db;border-radius:6px;">
        ` : ''}
        <div style="display:flex;gap:12px;justify-content:center;">
          ${currentStep > 0 && currentStep < steps.length - 1 ? `<button class="onboarding-back" style="padding:8px 20px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">Back</button>` : ''}
          <button class="onboarding-next" style="padding:8px 20px;background:var(--color-primary,#4f46e5);color:white;border:none;border-radius:6px;cursor:pointer;">
            ${step.action?.label ?? 'Next'}
          </button>
        </div>
        ${currentStep < steps.length - 1 ? `<button class="onboarding-skip" style="margin-top:16px;background:none;border:none;color:#9ca3af;cursor:pointer;font-size:0.875rem;">Skip setup</button>` : ''}
      </div>
    `;

    container.querySelector('.onboarding-next')?.addEventListener('click', async () => {
      const ctx: WizardContext = { container, next: () => { currentStep++; render(); } };
      if (step.action?.handler) {
        await step.action.handler(ctx);
      } else {
        ctx.next();
      }
    });

    container.querySelector('.onboarding-back')?.addEventListener('click', () => {
      currentStep--;
      render();
    });

    container.querySelector('.onboarding-skip')?.addEventListener('click', () => {
      localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
      navigate('/');
    });
  }

  render();
  return () => { container.innerHTML = ''; };
}

export function isOnboardingComplete(): boolean {
  return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true';
}
