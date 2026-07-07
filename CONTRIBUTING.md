# Contributing

Thanks for taking an interest in Replica. The project optimizes for smallness
and legibility — the whole backend should stay readable in one sitting.

## Ground rules

- **Zero runtime dependencies.** This is the project's core constraint. If a
  feature needs an npm package, the feature changes, not the constraint.
  Dev-time tooling is also stdlib-only today (`node --test`); keep it that way
  unless there's a very strong reason.
- **Node 18+ compatibility.** Use nothing newer than what Node 18 ships.
- **Vanilla frontend.** No frameworks, no build step. `public/` is served as-is.

## Getting set up

```bash
git clone https://github.com/21sean/replica.git
cd replica
npm run dev        # server with auto-restart on change
npm test           # full suite — must pass before you open a PR
```

You'll want Ollama running with a chat model for manual testing, but the test
suite itself mocks Ollama and runs anywhere.

## Making changes

- Match the existing style: 2-space indent, single quotes, semicolons,
  `'use strict'` CommonJS modules with a short header comment stating the
  module's responsibility.
- New behavior needs tests. The agent parser in particular has chunk-boundary
  tests that feed input one character at a time — if you touch the parser, keep
  those green and add cases for whatever you changed.
- Keep commits focused, in imperative mood, with a scope prefix when it helps:
  `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `ci:`, `chore:`.
- Update the relevant docs (`README.md`, `docs/`) in the same PR as the change.

## Reporting bugs

Open an issue with your OS, Node version, the model you were using, and — for
agent misbehavior — the contents of the project's `.replica/chat.json` if you
can share it.
