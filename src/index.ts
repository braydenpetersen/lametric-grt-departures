import express, { Request, Response } from "express";
import { getStopsForLaMetric } from "./stops";
import { getActiveAlerts, formatAlertsForLaMetric, loadAlertsFromFile } from "./alerts";

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

// Custom animated ION icon (base64 encoded GIF)
// Custom animated ION icon (base64 encoded GIF - loops infinitely)
const ION_ICON = "data:image/gif;base64,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";

// Check if route is ION (light rail)
function isIONRoute(routeShortName: string): boolean {
    return routeShortName === "301" || routeShortName === "302";
}

// Get icon based on route type (ION tram vs bus)
function getRouteIcon(routeShortName: string): string {
    if (isIONRoute(routeShortName)) {
        return ION_ICON; // Custom animated ION icon
    }
    return "i11999"; // Bus icon (static)
}

// Transform GRT data to LaMetric format
function transformToLaMetric(stops: GRTStop[]): LaMetricResponse {
    const frames: LaMetricFrame[] = [];

    // Track the earliest future departure (even if beyond 2 hours) for "CLOSED" display
    let nextDepartureTime: Date | null = null;

    // Process each stop separately to get its top 3 routes
    const allRoutes: { routeName: string; headsign: string; times: number[]; minTime: number }[] = [];

    for (const stop of stops) {
        // Group departures by route + headsign for THIS stop
        const stopGrouped = new Map<string, { routeName: string; headsign: string; times: number[] }>();

        for (const arrival of stop.arrivals) {
            const minutes = getMinutesUntil(arrival.departure);
            const departureDate = new Date(arrival.departure);

            // Track next departure for "CLOSED" message
            if (minutes >= 0) {
                if (!nextDepartureTime || departureDate < nextDepartureTime) {
                    nextDepartureTime = departureDate;
                }
            }

            // Skip departures that have already passed or are more than 2 hours away
            if (minutes < 0 || minutes > 120) continue;

            const routeName = arrival.route.shortName;
            const headsign = trimHeadsign(arrival.trip.headsign);
            const key = `${routeName}|${headsign}`;

            if (!stopGrouped.has(key)) {
                stopGrouped.set(key, { routeName, headsign, times: [] });
            }
            stopGrouped.get(key)!.times.push(minutes);
        }

        // Get top 3 routes for this stop
        const stopRoutes = [...stopGrouped.values()]
            .map((route) => ({
                ...route,
                minTime: Math.min(...route.times),
            }))
            .sort((a, b) => a.minTime - b.minTime)
            .slice(0, 3);

        allRoutes.push(...stopRoutes);
    }

    // Sort all routes by soonest departure time
    const sortedRoutes = allRoutes.sort((a, b) => a.minTime - b.minTime);

    // Create frames for each route/headsign group
    for (const { routeName, headsign, times } of sortedRoutes) {

        // Sort times and take first 2
        times.sort((a, b) => a - b);
        const nextTimes = times.slice(0, 2);

        // ION gets special treatment: icon + headsign in one frame
        if (isIONRoute(routeName)) {
            // Frame 1: Headsign with ION icon
            frames.push({
                text: headsign,
                icon: ION_ICON,
            });
        } else {
            // Frame 1: Route number with bus icon
            frames.push({
                text: routeName,
                icon: getRouteIcon(routeName),
            });

            // Frame 2: Headsign (destination)
            frames.push({
                text: headsign,
            });
        }

        // Final frame: Next departure times
        const timeText = nextTimes
            .map((t) => (t <= 1 ? "Due" : `${t}m`))
            .join(", ");
        frames.push({
            text: timeText,
        });
    }

    // If no departures found within 2 hours, show CLOSED with next departure time
    if (frames.length === 0) {
        frames.push({
            text: "CLOSED",
            icon: "i270",
        });

        // Show when the next departure is (if available)
        if (nextDepartureTime) {
            const hours = nextDepartureTime.getHours().toString().padStart(2, "0");
            const mins = nextDepartureTime.getMinutes().toString().padStart(2, "0");
            frames.push({
                text: `→ ${hours}:${mins}`,
            });
        }
    }

    return { frames };
}

// Main endpoint for LaMetric
app.get("/departures", async (req: Request, res: Response) => {
    try {
        // Accept stop ID(s) as query parameter - supports comma-delimited values
        const stopId = req.query.stop as string;
        // Also support legacy 'stops' param for backwards compatibility
        const stopIdsParam = req.query.stops as string;

        const stopIds = stopId
            ? stopId.split(",").map((id) => id.trim())
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

// Test endpoint - loads alerts from static file
app.get("/test-alerts", (_req: Request, res: Response) => {
    try {
        const alerts = loadAlertsFromFile();
        const frames = formatAlertsForLaMetric(alerts);

        if (frames.length === 0) {
            res.json({
                frames: [{ text: "No test alerts", icon: "i7473" }],
            });
        } else {
            res.json({ frames, raw: alerts });
        }
    } catch (error) {
        console.error("Error loading test alerts:", error);
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
