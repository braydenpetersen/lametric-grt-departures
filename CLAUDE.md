# Project guidance

This project now targets Cloudflare Workers, not Vercel or Railway. Read README.md for account routing, deployment checks, endpoint configuration, and secrets.

- `src/worker.ts`: native Request/Response router and Durable Object binding.
- `src/transit.ts`: GRT GraphQL and LaMetric display formatting.
- `src/tracking.ts`: persistent single-clock tracking state machine.
- `src/go.ts`: optional GO Transit fetch and display functions.
- `src/schedule.ts`: Eastern-time static timetable fallback.
- `scripts/refresh-schedule.py`: rebuilds compact data from official GRT feeds.
- `tests/worker.test.ts`: tests in the Workers runtime.

Run `npm test`, `npm run typecheck`, and `npm run build` before deployment. Use the personal account only. Never print or commit secrets.
