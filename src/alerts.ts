import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const GRT_ALERTS_URL =
    "https://webapps.regionofwaterloo.ca/api/grt-routes/api/alerts";

export interface Alert {
    id: string;
    headerText: string;
    descriptionText: string;
    affectedRoutes: string[];
    affectedStops: string[];
}

// Fetch and parse alerts from GRT live API
export async function fetchAlerts(): Promise<Alert[]> {
    try {
        const response = await fetch(GRT_ALERTS_URL);

        if (!response.ok) {
            console.error(`Failed to fetch alerts: ${response.status}`);
            return [];
        }

        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
            new Uint8Array(buffer)
        );

        const alerts: Alert[] = [];

        for (const entity of feed.entity) {
            if (entity.alert) {
                const alert = entity.alert;

                // Extract header text (first translation or empty)
                const headerText =
                    alert.headerText?.translation?.[0]?.text || "Service Alert";

                // Extract description text (first translation or empty)
                const descriptionText =
                    alert.descriptionText?.translation?.[0]?.text || "";

                // Extract affected routes
                const affectedRoutes: string[] = [];
                const affectedStops: string[] = [];

                if (alert.informedEntity) {
                    for (const informed of alert.informedEntity) {
                        if (informed.routeId) {
                            affectedRoutes.push(informed.routeId);
                        }
                        if (informed.stopId) {
                            affectedStops.push(informed.stopId);
                        }
                    }
                }

                alerts.push({
                    id: entity.id || "",
                    headerText,
                    descriptionText,
                    affectedRoutes: [...new Set(affectedRoutes)],
                    affectedStops: [...new Set(affectedStops)],
                });
            }
        }

        return alerts;
    } catch (error) {
        console.error("Error fetching alerts:", error);
        return [];
    }
}

// Check if there are any active alerts for a stop and its routes
export async function getActiveAlerts(
    stopId?: string,
    routeIds?: string[]
): Promise<Alert[]> {
    const alerts = await fetchAlerts();

    if (!stopId && (!routeIds || routeIds.length === 0)) {
        return alerts;
    }

    // Filter alerts that:
    // 1. Are system-wide (no specific stops or routes)
    // 2. Affect this specific stop
    // 3. Affect any of the routes serving this stop
    return alerts.filter((alert) => {
        const isSystemWide =
            alert.affectedStops.length === 0 && alert.affectedRoutes.length === 0;
        const affectsStop = stopId && alert.affectedStops.includes(stopId);
        const affectsRoutes =
            routeIds &&
            routeIds.some((routeId) => alert.affectedRoutes.includes(routeId));

        return isSystemWide || affectsStop || affectsRoutes;
    });
}

// Format alerts for LaMetric display
export function formatAlertsForLaMetric(
    alerts: Alert[]
): { text: string; icon: string }[] {
    const frames: { text: string; icon: string }[] = [];

    for (const alert of alerts) {
        // Clean up HTML from description
        const cleanDescription = alert.descriptionText
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        // Truncate if too long
        const shortDesc =
            cleanDescription.length > 50
                ? cleanDescription.substring(0, 47) + "..."
                : cleanDescription;

        frames.push({
            text: shortDesc || alert.headerText,
            icon: "a16701", // Animated warning icon
        });
    }

    return frames;
}
