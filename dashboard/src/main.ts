// Dashboard entry point — vanilla TypeScript (Requirement 31.1, task 18.14).
//
// Every dashboard route is now mounted via the History-API router in
// `lib/router.ts`. React, ReactDOM, and react-router-dom have been removed
// along with the legacy `App.tsx` fallback.

import './styles/theme.css';
import './styles/a11y.css';
import './styles/accessibility.css';
import './styles/responsive.css';
import './styles/skeleton.css';
import './styles/toast.css';
import './styles/empty-state.css';
import './styles/polish.css';
import './styles/diagnostics.css';
import { themeCss } from '@pinpoint/shared';
import { defineRoute, lazyRoute, setFallback, start } from './lib/router';
import { mountAuthPage } from './pages/AuthPage';
import { mountDashboardHome } from './pages/DashboardHome';
import { mountNotFoundPage } from './pages/NotFoundPage';
import { mountProjectView } from './pages/ProjectView';
import { mountSettingsPage } from './pages/SettingsPage';
import { mountVerifyEmailPage } from './pages/VerifyEmailPage';
import { mountOnboardingWizard } from './pages/OnboardingWizard';
import { mountCommandPalette } from './components/CommandPalette';
import { initToastContainer } from './components/Toast';

// Populate the `<style id="fl-theme">` tag declared in `index.html` with the
// shared Severity_Colors / Status_Labels custom properties (Requirement 26.3,
// task 18.13). Done once at boot so every route picks up `--fl-severity-*`
// and `--fl-status-*` from a single source of truth.
const themeStyle = document.getElementById('fl-theme');
if (themeStyle && !themeStyle.textContent) {
  themeStyle.textContent = themeCss();
}


// Apply the user's stored theme preference (B5 Dark Mode). If the user
// previously selected 'light' or 'dark' explicitly, we honour that choice
// by setting `data-theme` on `<html>`. If 'system' (or no value), we remove
// the attribute so the CSS `@media (prefers-color-scheme: dark)` rule takes
// effect naturally.
type ThemePreference = 'light' | 'dark' | 'system';
const storedTheme = localStorage.getItem('pinpoint_theme') as ThemePreference | null;

function applyTheme(preference: ThemePreference | null): void {
  if (preference === 'light' || preference === 'dark') {
    document.documentElement.setAttribute('data-theme', preference);
  } else {
    // 'system' or null — remove attribute so @media prefers-color-scheme drives it
    document.documentElement.removeAttribute('data-theme');
  }
}

applyTheme(storedTheme);

// Listen for system theme changes so UI updates live when preference is 'system'
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const current = localStorage.getItem('pinpoint_theme') as ThemePreference | null;
  if (!current || current === 'system') {
    // No data-theme attribute needed; CSS @media handles it. But we
    // re-confirm removal in case something else set it.
    document.documentElement.removeAttribute('data-theme');
  }
});
const root = document.getElementById('root');
if (!root) {
  throw new Error('Dashboard root element (#root) not found in index.html');
}

// `/auth` is registered alongside `/login` so the existing logout flow in
// `AppLayout.ts` (which navigates to `/auth`) keeps landing on the vanilla
// AuthPage.
// Low-traffic routes are code-split: their page module AND their <template>
// markup (pages/*.templates.html) load on first visit.
defineRoute('/', mountDashboardHome);
defineRoute('/login', mountAuthPage);
defineRoute('/auth', mountAuthPage);
defineRoute('/projects/:id', mountProjectView);
defineRoute('/settings', mountSettingsPage);
defineRoute('/shared/:linkId', lazyRoute(() => import('./pages/SharedProjectView').then((m) => m.mountSharedProjectView)));
defineRoute('/review/:linkId', lazyRoute(() => import('./pages/ReviewLinkPage').then((m) => m.mountReviewLinkPage)));
defineRoute('/verify-email/:token', mountVerifyEmailPage);
defineRoute('/reset-password', lazyRoute(() => import('./pages/ResetPasswordPage').then((m) => m.mountResetPasswordPage)));
defineRoute('/reset-password/:token', lazyRoute(() => import('./pages/ResetPasswordPage').then((m) => m.mountResetPasswordPage)));
defineRoute('/developer', lazyRoute(() => import('./pages/DeveloperPage').then((m) => m.mountDeveloperPage)));
defineRoute('/onboarding', mountOnboardingWizard);
defineRoute('/reports', lazyRoute(() => import('./pages/ReportingPage').then((m) => m.mountReportingPage)));
defineRoute('/workflows', lazyRoute(() => import('./pages/WorkflowsPage').then((m) => m.mountWorkflowsPage)));
defineRoute('/integrations', lazyRoute(() => import('./pages/IntegrationsPage').then((m) => m.mountIntegrationsPage)));
defineRoute('/portals', lazyRoute(() => import('./pages/ClientPortalPage').then((m) => m.mountClientPortalPage)));
defineRoute('/portal/:slug', lazyRoute(() => import('./pages/PortalGuestPage').then((m) => m.mountPortalGuestPage)));
defineRoute('/invitations/accept', lazyRoute(() => import('./pages/AcceptInvitationPage').then((m) => m.mountAcceptInvitationPage)));
defineRoute('/legal', lazyRoute(() => import('./pages/LegalPage').then((m) => m.mountLegalPage)));
defineRoute('/legal/:doc', lazyRoute(() => import('./pages/LegalPage').then((m) => m.mountLegalPage)));
setFallback(mountNotFoundPage);
start(root);

// Mount the global command palette (Ctrl+K / Cmd+K) — always available
// regardless of route.
mountCommandPalette(document.body);

// Initialize the toast notification container (B6). Always available so any
// page or module can fire feedback toasts via `showToast()`.
initToastContainer();
