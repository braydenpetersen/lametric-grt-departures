import {
  departureGoalData,
  fetchDepartures,
  getMinutesUntil,
  padForDisplay,
  type GRTStop,
  type LaMetricFrame,
} from "./transit";

export type Config = { stopId: string; route: string };
type Active = Config & {
  target: string;
  tripId?: string;
  startedAt: number;
  bracket: string;
};
type State = { config?: Config; active?: Active; last?: Config };
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
const idleIcon = "i24274",
  activeIcon = "i24029";
export function bracket(minutes: number): string {
  if (minutes <= 0) return "due";
  if (minutes <= 7) return `${minutes}m`;
  if (minutes <= 10) return "10m";
  return "tracking";
}
export function trackingFrame(active: Active): LaMetricFrame {
  if (active.bracket === "tracking")
    return {
      text: `Tracking route ${active.route} for stop ${active.stopId}`,
      icon: activeIcon,
    };
  const minutes = parseInt(active.bracket) || 0;
  return {
    text: padForDisplay(active.route, minutes ? `${minutes}'` : "Due"),
    icon: activeIcon,
    goalData: departureGoalData(active.route, minutes),
  };
}
function idleFrame(state: State): LaMetricFrame {
  return {
    text: state.last
      ? `Stopped tracking route ${state.last.route} for stop ${state.last.stopId}`
      : padForDisplay("", "IDLE"),
    icon: idleIcon,
  };
}
export function soonest(stops: GRTStop[], route: string) {
  return stops
    .flatMap((s) => s.arrivals)
    .filter(
      (a) =>
        (route === "all" || a.route.shortName === route) &&
        Date.parse(a.departure) >= Date.now() &&
        getMinutesUntil(a.departure) <= 120,
    )
    .sort((a, b) => Date.parse(a.departure) - Date.parse(b.departure))[0];
}
export class TrackingSession {
  constructor(
    private store: Store,
    private departures = fetchDepartures,
  ) {}
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url),
      q = url.searchParams,
      path = url.pathname;
    const state = (await this.store.get<State>("state")) ?? {};
    const before = JSON.stringify(state);
    const stop = () => {
      if (state.active)
        state.last = { stopId: state.active.stopId, route: state.active.route };
      delete state.active;
    };
    const reply = async (body: unknown, status = 200) => {
      if (JSON.stringify(state) !== before)
        await this.store.put("state", state);
      return Response.json(body, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    };
    if (path === "/track/stop") {
      stop();
      return reply({ success: true, action: "stopped" });
    }
    const toggle = path === "/quick-view/toggle";
    // Do not let an old, unpolled session make the next button press cancel a departed bus.
    if (
      state.active &&
      Date.parse(state.active.target) < Date.now() - 10 * 60_000
    )
      stop();
    if (toggle && state.active) {
      stop();
      return reply({ success: true, action: "stopped" });
    }
    if (path === "/track/start" || toggle) {
      const stopId =
        (toggle ? q.get("quickViewStop") : q.get("stop")) ||
        state.config?.stopId;
      const route =
        (toggle ? q.get("quickViewRoute") : q.get("route")) ||
        state.config?.route;
      if (!stopId || !route || !/^\d+$/.test(stopId))
        return reply({ error: "Missing or invalid stop/route" }, 400);
      const departure = soonest(await this.departures([stopId]), route);
      if (!departure) return reply({ success: true, action: "no_departures" });
      const minutes = getMinutesUntil(departure.departure);
      state.config = { stopId, route };
      state.active = {
        stopId,
        route: departure.route.shortName,
        target: departure.departure,
        tripId: departure.trip.id,
        startedAt: Date.now(),
        bracket: bracket(minutes),
      };
      return reply({
        success: true,
        action: toggle ? "tracking" : "started",
        route: departure.route.shortName,
        stopId,
        minutes,
        minutesUntilDeparture: minutes,
      });
    }
    if (q.get("stop") && q.get("route")) {
      if (!/^\d+$/.test(q.get("stop")!))
        return reply({ error: "Invalid stop" }, 400);
      state.config = { stopId: q.get("stop")!, route: q.get("route")! };
    }
    if (state.active) {
      const active = state.active;
      try {
        const stops = await this.departures([active.stopId]);
        const departure = stops
          .flatMap((s) => s.arrivals)
          .find(
            (a) =>
              a.route.shortName === active.route &&
              (active.tripId
                ? a.trip.id === active.tripId
                : a.departure === active.target),
          );
        if (departure) active.target = departure.departure;
      } catch {
        /* Keep the selected departure estimate if the feed is unavailable. */
      }
      if (
        Date.parse(active.target) < Date.now() ||
        Date.now() - active.startedAt > 3 * 60 * 60_000
      )
        stop();
      else active.bracket = bracket(getMinutesUntil(active.target));
    }
    if (path === "/track/status")
      return reply(
        state.active
          ? {
              active: true,
              route: state.active.route,
              stopId: state.active.stopId,
              minutes: getMinutesUntil(state.active.target),
              bracket: state.active.bracket,
            }
          : { active: false },
      );
    return reply({
      frames: [state.active ? trackingFrame(state.active) : idleFrame(state)],
    });
  }
}
