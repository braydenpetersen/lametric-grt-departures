import { DurableObject } from "cloudflare:workers";
import {
  fetchDepartures,
  transformToLaMetric,
  extractRouteIds,
  getMinutesUntil,
  departureGoalData,
  padForDisplay,
} from "./transit";
import { getActiveAlerts, formatAlertsForLaMetric } from "./alerts";
import {
  fetchGODepartures,
  fetchGOStopDepartures,
  transformGOToLaMetric,
  transformGONextServiceToLaMetric,
} from "./go";
import { TrackingSession, soonest } from "./tracking";
import { getNextScheduledDeparture, scheduleThrough } from "./schedule";
import stops from "../data/stops.json";

interface Env {
  TRACKING: DurableObjectNamespace<DepartureTracker>;
  GO_TRANSIT_API_KEY?: string;
  APP_TOKEN?: string;
  LAMETRIC_PUSH_URL?: string;
  LAMETRIC_PUSH_TOKEN?: string;
}
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const frame = (text: string, icon = "i555", status = 200) =>
  json({ frames: [{ text, icon }] }, status);
function parseStops(raw: string | null) {
  const ids = (raw ?? "").split(",").map((s) => s.trim());
  if (ids.length > 20 || ids.some((id) => !/^\d+$/.test(id)))
    throw new Error("Invalid stop parameter");
  return ids;
}
const trackingMethods: Record<string, string[]> = {
  "/track": ["GET"],
  "/track/status": ["GET"],
  "/track/start": ["POST"],
  "/track/stop": ["POST"],
  "/quick-view/toggle": ["GET", "POST"],
};
export class DepartureTracker extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  fetch(request: Request) {
    // Serialize operations across upstream awaits so a late poll cannot undo a stop.
    const result = this.queue.then(() =>
      new TrackingSession(this.ctx.storage).handle(request),
    );
    this.queue = result.catch(() => {});
    return result;
  }
}
async function pushConfirmation(body: any, env: Env) {
  if (!env.LAMETRIC_PUSH_URL || !env.LAMETRIC_PUSH_TOKEN) return;
  const url = new URL(env.LAMETRIC_PUSH_URL);
  if (url.protocol !== "https:" || url.hostname !== "developer.lametric.com")
    throw new Error("Invalid LaMetric push destination");
  const text =
    body.action === "stopped"
      ? "TRACKOFF"
      : body.action === "no_departures"
        ? "NO SVC"
        : padForDisplay(
            body.route,
            body.minutes <= 1 ? "Due" : `${body.minutes}'`,
          );
  const payload: Record<string, unknown> = {
    frames: [
      {
        text,
        icon: body.action === "stopped" ? "i24274" : "i24029",
        ...(body.route
          ? { goalData: departureGoalData(body.route, body.minutes) }
          : {}),
      },
    ],
    priority: body.minutes <= 5 ? "critical" : "info",
  };
  if (body.minutes <= 5)
    payload.sound = { category: "notifications", id: "bicycle", repeat: 1 };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LAMETRIC_PUSH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) console.warn("LaMetric push failed", response.status);
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname,
      q = url.searchParams;
    // Optional shared credential for a personal app. Never log its query string.
    if (
      env.APP_TOKEN &&
      path !== "/health" &&
      q.get("key") !== env.APP_TOKEN &&
      request.headers.get("Authorization") !== `Bearer ${env.APP_TOKEN}`
    )
      return frame("Unauthorized", "i555", 401);
    try {
      if (trackingMethods[path]) {
        if (!trackingMethods[path].includes(request.method))
          return frame("Method not allowed", "i555", 405);
        const response = await env.TRACKING.get(
          env.TRACKING.idFromName("personal-clock"),
        ).fetch(request);
        if (path === "/quick-view/toggle" && response.ok) {
          const body = await response.clone().json();
          ctx.waitUntil(
            pushConfirmation(body, env).catch(() =>
              console.warn("LaMetric push unavailable"),
            ),
          );
        }
        return response;
      }
      if (request.method !== "GET")
        return frame("Method not allowed", "i555", 405);
      if (path === "/health") return json({ status: "ok", scheduleThrough });
      if (path === "/")
        return json({
          name: "GRT & GO Transit LaMetric API",
          version: "3.0.0",
          hosting: "Cloudflare Workers",
          endpoints: [
            "/departures",
            "/stops",
            "/alerts",
            "/quick-view",
            "/quick-view/toggle",
            "/track",
            "/track/start",
            "/track/stop",
            "/track/status",
            "/go-departures",
            "/go-stop",
            "/health",
          ],
        });
      if (path === "/stops") return json({ data: stops });
      if (path === "/departures") {
        const raw = q.get("stop") || q.get("stops");
        if (!raw) return frame("Missing stop param", "i555", 400);
        const ids = parseStops(raw);
        let live;
        try {
          live = await fetchDepartures(ids);
        } catch {
          const next = getNextScheduledDeparture(ids);
          return next
            ? frame(padForDisplay(next.route, next.time), "i24274")
            : frame("LIVE ERROR");
        }
        const data = transformToLaMetric(live, ids);
        try {
          data.frames.push(
            ...formatAlertsForLaMetric(
              await getActiveAlerts(ids[0], extractRouteIds(live)),
            ),
          );
        } catch {
          /* Optional alerts must not prevent departure updates. */
        }
        return json(data);
      }
      if (path === "/alerts") {
        try {
          const alerts = formatAlertsForLaMetric(
            await getActiveAlerts(q.get("stop") ?? undefined),
          );
          return alerts.length
            ? json({ frames: alerts })
            : frame("No alerts", "i7473");
        } catch {
          return frame("Alerts unavailable");
        }
      }
      if (path === "/quick-view") {
        const stop = q.get("quickViewStop"),
          route = q.get("quickViewRoute");
        if (!stop || !route) return frame("Configure stop & route");
        const departure = soonest(
          await fetchDepartures(parseStops(stop)),
          route,
        );
        if (!departure) return frame(padForDisplay(route, "--"), "i24029");
        const minutes = getMinutesUntil(departure.departure);
        return json({
          frames: [
            {
              text: padForDisplay(route, minutes <= 1 ? "Due" : `${minutes}'`),
              icon: "i24029",
              goalData: departureGoalData(route, minutes),
            },
          ],
        });
      }
      if (path === "/go-departures" || path === "/go-stop") {
        if (!env.GO_TRANSIT_API_KEY) return frame("NO KEY");
        const filter = q
          .get("lines")
          ?.split(",")
          .map((s) => s.trim());
        if (path === "/go-departures")
          return json(
            transformGOToLaMetric(
              await fetchGODepartures(env.GO_TRANSIT_API_KEY),
              filter,
            ),
          );
        if (!q.get("stop"))
          return frame("Please input a GO Transit Stop # in the app");
        const codes = q
          .get("stop")!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (codes.length > 20 || codes.some((s) => !/^[a-zA-Z0-9]+$/.test(s)))
          return frame("Invalid stop", "i555", 400);
        const results = await Promise.all(
          codes.map((s) => fetchGOStopDepartures(s, env.GO_TRANSIT_API_KEY!)),
        );
        return json(transformGONextServiceToLaMetric(results.flat(), filter));
      }
      return frame("Not found", "i555", 404);
    } catch (error) {
      console.warn(
        "Request failed",
        path,
        error instanceof Error ? error.message : "Unknown error",
      );
      return frame(
        error instanceof Error && error.message === "Invalid stop parameter"
          ? "Invalid stop"
          : "Error",
        "i555",
        error instanceof Error && error.message === "Invalid stop parameter"
          ? 400
          : 500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
