import express, { Request, Response } from "express";
import { getStopsForLaMetric } from "./stops";
import { getActiveAlerts, formatAlertsForLaMetric } from "./alerts";

const app = express();
const PORT = process.env.PORT || 3000;

const GRT_GRAPHQL_URL = "https://grtivr-prod.regionofwaterloo.9802690.ca/vms/graphql";

interface GRTArrival {
    trip: {
        headsign: string;
    };
    route: {
        shortName: string;
    };
    arrival: string;
    departure: string;
}

interface GRTStop {
    id: string;
    platformCode: string | null;
    arrivals: GRTArrival[];
}

interface GRTResponse {
    data: {
        stops: GRTStop[];
    };
}

interface LaMetricFrame {
    text: string;
    icon?: string;
}

interface LaMetricResponse {
    frames: LaMetricFrame[];
}

// Calculate minutes until departure
function getMinutesUntil(departureTime: string): number {
    const now = new Date();
    const departure = new Date(departureTime);
    const diffMs = departure.getTime() - now.getTime();
    return Math.round(diffMs / 1000 / 60);
}

// Fetch departures from GRT GraphQL API
async function fetchDepartures(stopIds: string[]): Promise<GRTStop[]> {
    // Fetch more arrivals to get all routes serving this stop for alert filtering
    const query = `
    query GetDepartures {
      stops(filter: {idIn: [${stopIds.map((id) => `"${id}"`).join(", ")}]}) {
        id
        platformCode
        arrivals(limit: 10) {
          trip {
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
    });

    if (!response.ok) {
        throw new Error(`GRT API error: ${response.status}`);
    }

    const data = (await response.json()) as GRTResponse;
    return data.data.stops;
}

// Extract all unique route IDs from stops
function extractRouteIds(stops: GRTStop[]): string[] {
    const routeIds = new Set<string>();
    for (const stop of stops) {
        for (const arrival of stop.arrivals) {
            routeIds.add(arrival.route.shortName);
        }
    }
    return [...routeIds];
}

// Trim headsigns - remove "Station" and extra spaces
function trimHeadsign(headsign: string): string {
    return headsign
        .replace(/\s*Station\s*/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Get icon based on route type (ION tram vs bus)
function getRouteIcon(routeShortName: string): string {
    // ION Light Rail routes use tram icon
    if (routeShortName === "301" || routeShortName === "302") {
        return "i44539"; // Tram icon
    }
    return "i11999"; // Bus icon
}

// Transform GRT data to LaMetric format
function transformToLaMetric(stops: GRTStop[]): LaMetricResponse {
    const frames: LaMetricFrame[] = [];

    // Group departures by route + headsign, storing route name for icon lookup
    const grouped = new Map<string, { routeName: string; times: number[] }>();

    for (const stop of stops) {
        for (const arrival of stop.arrivals) {
            const minutes = getMinutesUntil(arrival.departure);

            // Skip departures that have already passed
            if (minutes < 0) continue;

            const routeName = arrival.route.shortName;
            const headsign = trimHeadsign(arrival.trip.headsign);
            const key = `${routeName}→${headsign}`;

            if (!grouped.has(key)) {
                grouped.set(key, { routeName, times: [] });
            }
            grouped.get(key)!.times.push(minutes);
        }
    }

    // Create frames for each route/headsign group (limit to 3 routes for display)
    let routeCount = 0;
    for (const [routeHeadsign, { routeName, times }] of grouped) {
        if (routeCount >= 3) break;
        routeCount++;

        // Sort times and take first 2
        times.sort((a, b) => a - b);
        const nextTimes = times.slice(0, 2);

        // Frame 1: Route → Headsign with appropriate icon
        frames.push({
            text: routeHeadsign,
            icon: getRouteIcon(routeName),
        });

        // Frame 2: Next departure times
        const timeText = nextTimes
            .map((t) => (t <= 0 ? "Now" : `${t}`))
            .join(", ");
        frames.push({
            text: `${timeText}m`,
        });
    }

    // If no departures found, show a message
    if (frames.length === 0) {
        frames.push({
            text: "No departures",
            icon: "i11999",
        });
    }

    return { frames };
}

// Main endpoint for LaMetric
app.get("/departures", async (req: Request, res: Response) => {
    try {
        // Accept stop ID as query parameter (single stop for LaMetric)
        const stopId = req.query.stop as string;
        // Also support legacy 'stops' param for backwards compatibility
        const stopIdsParam = req.query.stops as string;

        const stopIds = stopId
            ? [stopId]
            : stopIdsParam
                ? stopIdsParam.split(",").map((id) => id.trim())
                : null;

        if (!stopIds) {
            res.status(400).json({
                frames: [{ text: "Missing stop param", icon: "i555" }],
            });
            return;
        }

        const stops = await fetchDepartures(stopIds);

        // Extract all routes serving this stop for alert filtering
        const routeIds = extractRouteIds(stops);

        // Get relevant alerts (stop-specific, route-specific, system-wide)
        const alerts = await getActiveAlerts(stopIds[0], routeIds);
        const alertFrames = formatAlertsForLaMetric(alerts);

        // Build response: departures first, then alerts
        const laMetricData = transformToLaMetric(stops);

        // Append alerts if any
        if (alertFrames.length > 0) {
            laMetricData.frames.push(...alertFrames);
        }

        res.json(laMetricData);
    } catch (error) {
        console.error("Error fetching departures:", error);
        res.status(500).json({
            frames: [{ text: "Error", icon: "i555" }],
        });
    }
});

// Stops endpoint for LaMetric dropdown configuration
app.get("/stops", (_req: Request, res: Response) => {
    try {
        const stops = getStopsForLaMetric();
        res.json({ data: stops });
    } catch (error) {
        console.error("Error loading stops:", error);
        res.status(500).json({ error: "Failed to load stops" });
    }
});

// Alerts endpoint
app.get("/alerts", async (req: Request, res: Response) => {
    try {
        const stopId = req.query.stop as string | undefined;
        const alerts = await getActiveAlerts(stopId);
        const frames = formatAlertsForLaMetric(alerts);

        if (frames.length === 0) {
            res.json({
                frames: [{ text: "No alerts", icon: "i7473" }],
            });
        } else {
            res.json({ frames });
        }
    } catch (error) {
        console.error("Error loading alerts:", error);
        res.status(500).json({
            frames: [{ text: "Error", icon: "i555" }],
        });
    }
});

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
});

// Start server only when running locally (not on Vercel)
if (process.env.NODE_ENV !== "production") {
    app.listen(PORT, () => {
        console.log(`🚌 GRT LaMetric API running on port ${PORT}`);
    });
}

// Export for Vercel
export default app;
