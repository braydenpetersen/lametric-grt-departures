import { getNextScheduledDeparture } from "./schedule";
const GRT_GRAPHQL_URL =
  "https://grtivr-prod.regionofwaterloo.9802690.ca/vms/graphql";
export interface GRTArrival {
  trip: {
    id?: string;
    headsign: string | null;
  };
  route: {
    shortName: string;
  };
  arrival: string;
  departure: string;
}

export interface GRTStop {
  id: string;
  platformCode: string | null;
  arrivals: GRTArrival[];
}

export interface GRTResponse {
  data: {
    stops: GRTStop[];
  };
}

export interface LaMetricFrame {
  text: string;
  icon?: string;
  goalData?: {
    start: number;
    current: number;
    end: number;
    unit: string;
  };
}

export interface LaMetricResponse {
  frames: LaMetricFrame[];
}

// Pixel width of a string on the LaMetric display
// 1px: narrow chars, 3px: standard, 4px: n/N, 5px: m/M/w/W
// Plus 1px gap between each character
const NARROW_CHARS = new Set("'|:. !il;,");
const WIDE5_CHARS = new Set("mMwW");
const WIDE4_CHARS = new Set("nN");

export function pxWidth(s: string): number {
  if (s.length === 0) return 0;
  let w = 0;
  for (const ch of s) {
    if (NARROW_CHARS.has(ch)) w += 1;
    else if (WIDE5_CHARS.has(ch)) w += 5;
    else if (WIDE4_CHARS.has(ch)) w += 4;
    else w += 3;
  }
  return w + (s.length - 1); // 1px inter-character gap
}

// Goal bar: full when ≤10 min, otherwise just highlights the route number
export function departureGoalData(
  route: string,
  minutes: number,
): LaMetricFrame["goalData"] {
  if (minutes <= 10) return { start: 0, current: 1, end: 1, unit: "" };
  // Scale by 2 to allow half-pixel precision (e.g. 7px route → 13/56 = 6.5/28)
  return { start: 0, current: pxWidth(route) * 2 - 1, end: 56, unit: "" };
}

// Build padded text for LaMetric display (27px wide)
// Invisible "|" chars (1px each) fill the gap between left and right text
export function padForDisplay(left: string, right: string): string {
  const pipes = Math.max(
    0,
    Math.floor((26 - pxWidth(left) - pxWidth(right)) / 2),
  );
  return `${left}${"|".repeat(pipes)}${right}`;
}

// Calculate minutes until departure
export function getMinutesUntil(departureTime: string): number {
  const now = new Date();
  const departure = new Date(departureTime);
  const diffMs = departure.getTime() - now.getTime();
  return Math.round(diffMs / 1000 / 60);
}

// Fetch departures from GRT GraphQL API
export async function fetchDepartures(stopIds: string[]): Promise<GRTStop[]> {
  // Fetch more arrivals to get all routes serving this stop for alert filtering
  if (stopIds.length > 20 || stopIds.some((id) => !/^\d+$/.test(id)))
    throw new Error("Invalid stop IDs");
  const query = `
    query GetDepartures {
      stops(filter: {idIn: [${stopIds.map((id) => `"${id}"`).join(", ")}]}) {
        id
        platformCode
        arrivals(limit: 10) {
          trip {
            id
            headsign
          }
          route {
            shortName
          }
          arrival
          departure
        }
      }
    }
  `;

  const response = await fetch(GRT_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`GRT API error: ${response.status}`);
  }

  const data = (await response.json()) as GRTResponse;
  if (!Array.isArray(data.data?.stops)) throw new Error("Invalid GRT response");
  return data.data.stops;
}

// Extract all unique route IDs from stops
export function extractRouteIds(stops: GRTStop[]): string[] {
  const routeIds = new Set<string>();
  for (const stop of stops) {
    for (const arrival of stop.arrivals) {
      routeIds.add(arrival.route.shortName);
    }
  }
  return [...routeIds];
}

// Check if route is ION (light rail)
export function isIONRoute(routeShortName: string): boolean {
  return routeShortName === "301" || routeShortName === "302";
}

// Get icon based on route type (ION tram vs bus)
export function getRouteIcon(routeShortName: string): string {
  if (isIONRoute(routeShortName)) {
    return "i12738";
  }
  return "i11999"; // Bus icon (static)
}

// Transform GRT data to LaMetric format
// One frame per departure: "ROUTE | TIME", top 3 soonest across all stops
export function transformToLaMetric(
  stops: GRTStop[],
  stopIds: string[],
): LaMetricResponse {
  const frames: LaMetricFrame[] = [];

  // Flatten all departures into individual { route, minutes, departureTime } items
  const allDepartures: {
    route: string;
    minutes: number;
    departureTime: string;
  }[] = [];

  for (const stop of stops) {
    for (const arrival of stop.arrivals) {
      const minutes = getMinutesUntil(arrival.departure);

      // Skip departures that have already passed or are more than 2 hours away
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120) continue;

      allDepartures.push({
        route: arrival.route.shortName,
        minutes,
        departureTime: arrival.departure,
      });
    }
  }

  // Sort by soonest, deduplicate by route, and take top 3 unique lines
  const seen = new Set<string>();
  const topDepartures = allDepartures
    .sort((a, b) => a.minutes - b.minutes)
    .filter((d) => {
      if (seen.has(d.route)) return false;
      seen.add(d.route);
      return true;
    })
    .slice(0, 3);

  // Create frames per departure
  // ≤60 min: show countdown (e.g. "45'"), >60 min: show clock time (e.g. "5:54")
  // First departure gets a bonus frame with clock time if it showed countdown
  for (let i = 0; i < topDepartures.length; i++) {
    const { route, minutes, departureTime } = topDepartures[i];
    const icon = getRouteIcon(route);
    const goalData = departureGoalData(route, minutes);

    // Format departure as 12h clock time in Eastern
    const dep = new Date(departureTime);
    const eastern = new Date(
      dep.toLocaleString("en-US", { timeZone: "America/Toronto" }),
    );
    const h = eastern.getHours();
    const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const clockTime = `${hour12}:${eastern.getMinutes().toString().padStart(2, "0")}`;

    if (minutes <= 1) {
      frames.push({ text: padForDisplay(route, "Due"), icon, goalData });
      if (i === 0) {
        frames.push({ text: padForDisplay(route, clockTime), icon, goalData });
      }
    } else if (minutes <= 60) {
      frames.push({
        text: padForDisplay(route, `${minutes}'`),
        icon,
        goalData,
      });
      if (i === 0) {
        frames.push({ text: padForDisplay(route, clockTime), icon, goalData });
      }
    } else {
      frames.push({ text: padForDisplay(route, clockTime), icon, goalData });
    }
  }

  // No real-time departures — fall back to GTFS static schedule
  if (frames.length === 0) {
    const next = getNextScheduledDeparture(stopIds);
    if (next) {
      frames.push({
        text: padForDisplay(next.route, next.time),
        icon: "i24274", // orange — scheduled (not live)
      });
    } else {
      frames.push({
        text: "NO SVC",
        icon: "i270",
      });
    }
  }

  return { frames };
}
