# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LaMetric Time app backend that displays real-time Grand River Transit (GRT) bus departures and GO Transit train departures for the Waterloo Region. Deployed as a Vercel serverless function.

## Commands

- **Dev server:** `npm run dev` (tsx watch with hot reload)
- **Start:** `npm start` (tsx, no watch)
- **No test suite or linter configured.**

## Architecture

Single Express app (`src/index.ts`) deployed via Vercel (`vercel.json` routes all requests to it). Three source files:

- **`src/index.ts`** — Express server with all endpoints. Contains GRT GraphQL client, GO Transit API client, LaMetric response formatting, and quick-view toggle logic.
- **`src/stops.ts`** — Parses static GTFS `data/GTFS/stops.txt` to provide stop listings for the LaMetric app's dropdown configuration.
- **`src/alerts.ts`** — Fetches GRT service alerts via GTFS-realtime protobuf feed, with a file-based fallback (`data/Alerts.pb`) for testing.

### Key API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /departures?stop=<id>` | GRT departures formatted for LaMetric (main endpoint) |
| `GET /go-departures?stop=<name>&direction=<dir>` | GO Transit departures for LaMetric |
| `GET /go-stop?stop=<name>` | Full GO Transit stop info (all lines/directions) |
| `GET /stops` | List all GRT stops for LaMetric dropdown config |
| `GET /alerts?stop=<id>` | GRT service alerts for a stop |
| `POST /quick-view/toggle` | Toggle quick-view tracking for a LaMetric device |
| `GET /quick-view` | Quick-view departure data for tracked devices |

### External APIs

- **GRT GraphQL:** `https://grtivr-prod.regionofwaterloo.9802690.ca/vms/graphql` — real-time departures
- **GRT Alerts:** `https://webapps.regionofwaterloo.ca/api/grt-routes/api/alerts` — GTFS-realtime protobuf
- **GO Transit:** `https://api.openmetrolinx.com/OpenDataAPI/api/V1/` — requires `GO_TRANSIT_API_KEY` in `.env.local`

### LaMetric Response Format

All departure endpoints return `{ frames: LaMetricFrame[] }` where each frame has `text`, optional `icon`, and optional `goalData` (used for countdown bars when a bus is ≤5 min away).

## Data

`data/GTFS/` contains static GTFS schedule files (stops, routes, trips, etc.). `data/Alerts.pb` is a protobuf snapshot for testing alerts offline.

## Environment

- **`.env.local`** — contains `GO_TRANSIT_API_KEY` (loaded via dotenv)
- TypeScript executed directly via `tsx` (no compile step, no `tsconfig.json`)
