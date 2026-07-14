// Dashboard entry point — vanilla TypeScript (Requirement 31.1, task 18.14).
//
// Every dashboard route is now mounted via the History-API router in
// `lib/router.ts`. React, ReactDOM, and react-router-dom have been removed
// along with the legacy `App.tsx` fallback.

import './styles/theme.css';
import './styles/a11y.css';
import './styles/responsive.css';
import './styles/skeleton.css';
import './styles/toast.css';
import { themeCss } from '@pinpoint/shared';
import { defineRoute, setFallback, start } from './lib/router';
import { mountAuthPage } from './pages/AuthPage';
import { mountClientPortalPage } from './pages/ClientPortalPage';
import { mountDashboardHome } from './pages/DashboardHome';
import { mountNotFoundPage } from './pages/NotFoundPage';
import { mountProjectView } from './pages/ProjectView';
import { mountSettingsPage } from './pages/SettingsPage';
import { mountSharedProjectView } from './pages/SharedProjectView';
import { mountVerifyEmailPage } from './pages/VerifyEmailPage';
import { mountOnboardingWizard } from './pages/OnboardingWizard';
import { mountReportingPage } from './pages/ReportingPage';
import { mountWorkflowsPage } from './pages/WorkflowsPage';
import { mountIntegrationsPage } from './pages/IntegrationsPage';
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
const storedTheme = localStorage.getItem('pp-theme');
if (storedTheme === 'light' || storedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', storedTheme);
} else {
  document.documentElement.removeAttribute('data-theme');
}
const root = document.getElementById('root');
if (!root) {
  throw new Error('Dashboard root element (#root) not found in index.html');
}

// `/auth` is registered alongside `/login` so the existing logout flow in
// `AppLayout.ts` (which navigates to `/auth`) keeps landing on the vanilla
// AuthPage.
defineRoute('/', mountDashboardHome);
defineRoute('/login', mountAuthPage);
defineRoute('/auth', mountAuthPage);
defineRoute('/projects/:id', mountProjectView);
defineRoute('/settings', mountSettingsPage);
defineRoute('/shared/:linkId', mountSharedProjectView);
defineRoute('/verify-email/:token', mountVerifyEmailPage);
defineRoute('/onboarding', mountOnboardingWizard);
defineRoute('/reports', mountReportingPage);
defineRoute('/workflows', mountWorkflowsPage);
defineRoute('/integrations', mountIntegrationsPage);
defineRoute('/portals', mountClientPortalPage);
setFallback(mountNotFoundPage);
start(root);

// Mount the global command palette (Ctrl+K / Cmd+K) — always available
// regardless of route.
mountCommandPalette(document.body);

// Initialize the toast notification container (B6). Always available so any
// page or module can fire feedback toasts via `showToast()`.
initToastContainer();
