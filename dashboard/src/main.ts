// Dashboard entry point — vanilla TypeScript (Requirement 31.1, task 18.14).
//
// Every dashboard route is now mounted via the History-API router in
// `lib/router.ts`. React, ReactDOM, and react-router-dom have been removed
// along with the legacy `App.tsx` fallback.

import { themeCss } from '@pinpoint/shared';
import { defineRoute, start } from './lib/router';
import { mountAuthPage } from './pages/AuthPage';
import { mountDashboardHome } from './pages/DashboardHome';
import { mountProjectView } from './pages/ProjectView';
import { mountSettingsPage } from './pages/SettingsPage';
import { mountSharedProjectView } from './pages/SharedProjectView';
import { mountVerifyEmailPage } from './pages/VerifyEmailPage';

// Populate the `<style id="fl-theme">` tag declared in `index.html` with the
// shared Severity_Colors / Status_Labels custom properties (Requirement 26.3,
// task 18.13). Done once at boot so every route picks up `--fl-severity-*`
// and `--fl-status-*` from a single source of truth.
const themeStyle = document.getElementById('fl-theme');
if (themeStyle && !themeStyle.textContent) {
  themeStyle.textContent = themeCss();
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
start(root);
