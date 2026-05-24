# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security
- Added `helmet.js` for HTTP security headers
- Removed committed `.env` file, added `.env.example`
- Added `.gitignore` to prevent secrets from being committed

### Added
- Deep health check (`/health`, `/api/v1/health`) — verifies DB connectivity, returns 503 if degraded
- Test coverage enforcement (70% lines/functions/statements, 65% branches)
- Prettier configuration for consistent code formatting
- `npm run format` and `npm run format:check` scripts
- `npm run test:coverage` script

### Changed
- Database pool config: production uses 5-20 connections with timeouts
- Health endpoint returns `{ status, checks, uptime }` instead of just `{ status: 'ok' }`

### Removed
- Python `.venv` directory (unused)
- Committed `dist/` folders (now in `.gitignore`, built in CI)
