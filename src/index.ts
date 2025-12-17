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
const ION_ICON = "data:image/gif;base64,R0lGODlhCAAIAIEAAAAAAACUzwC0/BX/ACH/C05FVFNDQVBFMi4wAwECAAAh+QQAMgAAACwAAAAACAAIAAAIKAABDBgAoGCAAAIJAjiIsKBBhAIEPCwYcSKAigsRBojIUONFiRkDBAQAIfkEAQUABQAsAAAAAAgACACBAJTPAAAAALT8Ff8ACCMABxQIUKAAgIICCR4syNDgwIMKBzqMSHHiwoUPCwiQuDBAQAAh+QQBBQAFACwAAAAACAAIAIEAlM8AAAAV/wAAtPwIIAALBChQAADBgQMNElxYUKDBhAIbQpwo8aFChxEhRgwIACH5BAEFAAQALAAAAAAIAAgAgQCUzwAAAAC0/AAAAAgjAAMQIABgYAAAAgsOXEiQwEGHDRNCLCixIkWGDwMIkAhRQEAAIfkEAQUABAAsAAAAAAgACACBAJTPAAAAALT8AAAACCcACRAAIDAAAAEDBSoUSNAggQACGiaEKLFhxIcSEWJ8qJHgQwIIAwIAIfkEAQUABAAsAAAAAAgACACBAJTPAAAAALT8AAAACCgACQAgQCAAAAECCSokIGCgwYIICyYMEDHAxIoOGRJ8SLHgQIkIAwQEACH5BAEFAAQALAAAAAAIAAgAgQAAAACUzwC0/AAAAAgoAAMQIAAggACCAxMSEACAoEAABwE0fBhxIsGKDxcSLHgR4cCGEQkEBAAh+QQBBQAEACwAAAAABwAIAIEAAAAAlM8AtPwAAAAIIwAJEAAQQMBAgQgFACA40CAAAgEaHowIwCFFAhYlPjzokEBAACH5BAEFAAQALAAAAAAGAAgAgQAAAAC0/ACUzwAAAAgeAAkAEBBAIIGDBAIMFFhwIYCGAhgaBJBwYkODFwMCACH5BAEFAAQALAAAAAAIAAgAgQAAAAC0/ACUzwAAAAgiAAEICEAAAIGDCAMYJEAQQEOEBR8yjFgQoUGJCiUmrIgwIAAh+QQBBQAEACwAAAAABwAIAIEAAAAAtPwAlM8AAAAIIAAFBCAAgIBBgwEKEkg4UCHBhggBQDw4McBEhAQPEggIACH5BAEFAAQALAAAAAAIAAgAgQAAAAC0/ACUzwAAAAghAAMQAECgoMEABAkIVDjQoEKBCRdCdBhgIsOCCR021BgQACH5BAEFAAIALAAAAAAIAAgAgQAAAAC0/AAAAAAAAAghAAUAEECwYICBAgIQHIiQ4EGBDhdCNMgwosCGBSdmFBAQACH5BAEFAAIALAAAAAAIAAYAgQAAAAC0/AAAAAAAAAgeAAEIGEhQgEABAQYCCHBwIEOGDhVCJPjwYEKDAQICACH5BAEFAAIALAIAAQAGAAUAgQAAAAC0/AAAAAAAAAgUAAMIEABA4MAABQsOTHgwoUGFAQEAIfkEAQUAAgAsAQABAAcABQCBAAAAALT8AAAAAAAACBYAAwgQAEDgQAEBChY0qNBgwocMDQYEACH5BAEFAAIALAAAAQAIAAUAgQAAAAC0/AAAAAAAAAgWAAMIEABAIMGBAQoqNLgQAMKGDBkGBAAh+QQBBQACACwBAAEABwAFAIEAAAAAtPwAAAAAAAAIFwAFAAggQKCAAAMTElQI4CDDggMhBggIACH5BAEFAAIALAAAAQAIAAUAgQAAAAC0/AAAAAAAAAgbAAUACCBAoIAAAQYqJCgwYcKDDhUebFhwoICAACH5BAEFAAIALAAAAQAIAAUAgQAAAAC0/AAAAAAAAAgbAAEEECAAgIAAAAQqHJgQIcKDDRVCFEiQooCAACH5BAEyAAIALAAAAQAIAAUAgQAAAAC0/AAAAAAAAAgZAAMIEABAQICCBxMSNAjgIEOGDiMObDgxIAA7";

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

    // Group departures by route + headsign, storing route name for icon lookup
    const grouped = new Map<string, { routeName: string; headsign: string; times: number[] }>();

    for (const stop of stops) {
        for (const arrival of stop.arrivals) {
            const minutes = getMinutesUntil(arrival.departure);

            // Skip departures that have already passed or are more than 2 hours away
            if (minutes < 0 || minutes > 120) continue;

            const routeName = arrival.route.shortName;
            const headsign = trimHeadsign(arrival.trip.headsign);
            const key = `${routeName}|${headsign}`;

            if (!grouped.has(key)) {
                grouped.set(key, { routeName, headsign, times: [] });
            }
            grouped.get(key)!.times.push(minutes);
        }
    }

    // Create frames for each route/headsign group (limit to 3 routes for display)
    let routeCount = 0;
    for (const [_key, { routeName, headsign, times }] of grouped) {
        if (routeCount >= 3) break;
        routeCount++;

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
