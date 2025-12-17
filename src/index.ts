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
    const query = `
    query GetDepartures {
      stops(filter: {idIn: [${stopIds.map((id) => `"${id}"`).join(", ")}]}) {
        id
        platformCode
        arrivals(limit: 3) {
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

// Transform GRT data to LaMetric format
function transformToLaMetric(stops: GRTStop[]): LaMetricResponse {
    const frames: LaMetricFrame[] = [];

    // Group departures by route + headsign
    const grouped = new Map<string, number[]>();

    for (const stop of stops) {
        for (const arrival of stop.arrivals) {
            const minutes = getMinutesUntil(arrival.departure);

            // Skip departures that have already passed
            if (minutes < 0) continue;

            const routeName = arrival.route.shortName;
            const headsign = arrival.trip.headsign;
            const key = `${routeName}→${headsign}`;

            if (!grouped.has(key)) {
                grouped.set(key, []);
            }
            grouped.get(key)!.push(minutes);
        }
    }

    // Create frames for each route/headsign group
    for (const [routeHeadsign, times] of grouped) {
        // Sort times and take first 2
        times.sort((a, b) => a - b);
        const nextTimes = times.slice(0, 2);

        // Frame 1: Route → Headsign
        frames.push({
            text: routeHeadsign,
            icon: "i7473", // Bus icon
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
            icon: "i7473",
        });
    }

    return { frames };
}

// Main endpoint for LaMetric
app.get("/departures", async (req: Request, res: Response) => {
    try {
        // Accept stop IDs as comma-separated query parameter
        const stopIdsParam = req.query.stops as string;

        if (!stopIdsParam) {
            res.status(400).json({
                frames: [{ text: "Missing stops param", icon: "i555" }],
            });
            return;
        }

        const stopIds = stopIdsParam.split(",").map((id) => id.trim());
        const stops = await fetchDepartures(stopIds);
        const laMetricData = transformToLaMetric(stops);

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
app.get("/alerts", (req: Request, res: Response) => {
    try {
        const stopId = req.query.stop as string | undefined;
        const alerts = getActiveAlerts(stopId);
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

app.listen(PORT, () => {
    console.log(`🚌 GRT LaMetric API running on port ${PORT}`);
});
