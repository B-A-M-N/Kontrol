# Contributing

Use Node 22.19+, 24.x, or 26.x and install development dependencies with:

```bash
npm install --include=dev
```

Before submitting a change, run the focused tests for the affected area and,
when practical, the complete runtime gate:

```bash
npm run typecheck
npm test
```

Keep release artifacts immutable, preserve the root `AGENTS.md` contracts, and
do not commit state files, credentials, generated release directories, or
scratch probes. Changes affecting lifecycle, policy, authentication, or review
durability need regression tests and documentation updates.
