## Summary

<!-- What changed and why. Link issues. -->

## How it was tested

<!-- Commands run, new tests, manual checks. -->

## Checklist (see CONTRIBUTING.md)

- [ ] Bug fixes include a regression test that fails without the fix
- [ ] New routes / pages / workers / flows have tests and `docs/TEST_MATRIX.md` is updated
- [ ] New tests passed twice locally; any skip has a reason
- [ ] Security-relevant change? `docs/SECURITY_REVIEW.md` updated (or N/A)
- [ ] New dependencies are pinned exactly and justified (or N/A)
- [ ] User/operator docs updated (README, DEPLOYMENT, INTEGRATIONS_SETUP) (or N/A)
- [ ] `npx tsc --build tsconfig.json && npm run lint && node scripts/check-standards.mjs` pass locally
