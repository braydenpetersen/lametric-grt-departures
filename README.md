# LaMetric GRT departures on Cloudflare

A personal LaMetric TIME backend for live GRT departures and optional GO Transit data.
The Worker runs on Workers Free; `DepartureTracker` uses SQLite-backed Durable Object storage.
Tracking survives Worker restarts and follows the selected trip rather than switching to the next bus.

## Local development

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run build
```

The local server uses port 8787 by default. Example: `/departures?stop=1000`.
`npm test` runs mocked integration tests in Cloudflare's Workers runtime, including a Durable Object restart.
No live clock notifications are sent by the tests.

## Deployment

Use the personal account owning `braydenpetersen/lametric-grt-departures`.
Verify `npx wrangler whoami` against the personal Cloudflare account and pin its ID in `wrangler.jsonc`.
Run the user's required account preflight before deployment. The existing preflight currently assumes Vercel;
Cloudflare deployment requires an explicit exception until a Cloudflare preflight is integrated.
After preflight, run `npx wrangler deploy` (Workers Free, no custom domain required).
Never use temporary preview accounts or substitute another account.

The same Worker name is updated on later deployments. Do not create replacement apps to work around access failures.

## LaMetric settings

Replace only the old Railway origin with the deployed `https://lametric-grt-departures.<personal-subdomain>.workers.dev` origin.
Preserve the device's existing stop and route parameters, polling intervals, icons and notification settings.

| Use | Endpoint |
| --- | --- |
| Departures poll | `GET /departures?stop=<id>` (comma-separated IDs supported) |
| Stop dropdown | `GET /stops` |
| Quick view | `GET /quick-view?quickViewStop=<id>&quickViewRoute=<route>` |
| Main app button | `GET /quick-view/toggle?quickViewStop=<id>&quickViewRoute=<route>` |
| Tracking app poll | `GET /track?stop=<id>&route=<route>` |
| Start tracking | `POST /track/start?stop=<id>&route=<route>` |
| Cancel tracking | `POST /track/stop` |
| Tracking status | `GET /track/status` |
| Alerts | `GET /alerts?stop=<id>` |
| GO Union departures | `GET /go-departures?lines=KI,LW` |
| GO stop departures | `GET /go-stop?stop=<code>` |
| Health | `GET /health` |

This retains the original app's single personal-clock tracking session. It is not a multi-user service.
Tracking expires on the next poll after departure; no continuously running timer or paid scheduler is needed.

## Optional secrets

Set values with `npx wrangler secret put NAME`; never commit them.
For local use place them in ignored `.dev.vars`.

- `GO_TRANSIT_API_KEY`: required only for GO Transit.
- `LAMETRIC_PUSH_URL` and `LAMETRIC_PUSH_TOKEN`: optional button confirmation push, separate from polling notifications.
- `APP_TOKEN`: optional personal app credential. If set, all endpoints except `/health` require `?key=<token>` or a Bearer header. Update every LaMetric URL accordingly before enabling it.

## Timetable maintenance

Run `npm run refresh-schedule` to download and rebuild both official GRT feeds.
Review, test and deploy the generated JSON changes. The raw historical `data/GTFS` files are retained as source history;
they are not bundled into the Worker. `data/stops.json`, `schedule.json` and `service-dates.json` are the active data.
Service IDs and GTFS times after 24:00 are preserved. A feed refresh refuses wholly expired data.

Live departures fall back to the static schedule if the feed fails (orange icon), and show `LIVE ERROR` if no fallback exists.
The GRT alerts server may have TLS problems; optional alerts never prevent bus updates, and `/alerts` reports unavailable honestly.

## Rollback

Keep the Railway app intact until the clock is verified against Cloudflare.
To roll back Cloudflare code, use the previous Worker version after the same account checks.
The old Railway code remains in Git history at `9f25080`.
