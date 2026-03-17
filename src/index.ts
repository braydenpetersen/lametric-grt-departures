import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import express, { Request, Response } from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getStopsForLaMetric } from "./stops";
import { getActiveAlerts, formatAlertsForLaMetric, loadAlertsFromFile } from "./alerts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

const GRT_GRAPHQL_URL = "https://grtivr-prod.regionofwaterloo.9802690.ca/vms/graphql";

// Load pre-built GTFS schedule data
type Schedule = Record<string, Record<string, Record<string, string[]>>>;
type ServiceDates = Record<string, string>;

const schedule: Schedule = JSON.parse(readFileSync(join(__dirname, "..", "data", "schedule.json"), "utf-8"));
const serviceDates: ServiceDates = JSON.parse(readFileSync(join(__dirname, "..", "data", "service-dates.json"), "utf-8"));

// Get the next scheduled departure from GTFS static data for a stop
function getNextScheduledDeparture(stopIds: string[]): { route: string; time: string } | null {
    const now = new Date();
    const currentTimeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

    // Get today's service type, then try tomorrow if nothing found
    const today = now.toISOString().slice(0, 10).replace(/-/g, "");
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");

    for (const [date, searchFromMidnight] of [[today, false], [tomorrow, true]] as const) {
        const serviceType = serviceDates[date];
        if (!serviceType || !schedule[serviceType]) continue;

        const serviceSchedule = schedule[serviceType];
        let earliest: { route: string; time: string } | null = null;

        for (const stopId of stopIds) {
            const stopSchedule = serviceSchedule[stopId];
            if (!stopSchedule) continue;

            for (const [route, times] of Object.entries(stopSchedule)) {
                for (const time of times) {
                    // For today: find first departure after current time
                    // For tomorrow: find first departure of the day
                    if (!searchFromMidnight && time <= currentTimeStr) continue;

                    if (!earliest || time < earliest.time) {
                        earliest = { route, time };
                    }
                    break; // times are sorted, first match is earliest for this route
                }
            }
        }

        if (earliest) {
            // Format time as 5:54
            const [h, m] = earliest.time.split(":");
            const hour = parseInt(h);
            const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
            return { route: earliest.route, time: `${hour12}:${m}` };
        }
    }

    return null;
}

interface GRTArrival {
    trip: {
        headsign: string | null;
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
    goalData?: {
        start: number;
        current: number;
        end: number;
        unit: string;
    };
}

interface LaMetricResponse {
    frames: LaMetricFrame[];
}

// Pixel width of a string on the LaMetric display
// 1px: narrow chars, 3px: standard, 4px: n/N, 5px: m/M/w/W
// Plus 1px gap between each character
const NARROW_CHARS = new Set("'|:. !il;,");
const WIDE5_CHARS = new Set("mMwW");
const WIDE4_CHARS = new Set("nN");

function pxWidth(s: string): number {
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
function departureGoalData(route: string, minutes: number): LaMetricFrame["goalData"] {
    if (minutes <= 10) return { start: 0, current: 1, end: 1, unit: "" };
    // Scale by 2 to allow half-pixel precision (e.g. 7px route → 13/56 = 6.5/28)
    return { start: 0, current: pxWidth(route) * 2 - 1, end: 56, unit: "" };
}

// Build padded text for LaMetric display (27px wide)
// Invisible "|" chars (1px each) fill the gap between left and right text
function padForDisplay(left: string, right: string): string {
    const pipes = Math.max(0, Math.floor((26 - pxWidth(left) - pxWidth(right)) / 2));
    return `${left}${"|".repeat(pipes)}${right}`;
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
// One frame per departure: "ROUTE | TIME", top 3 soonest across all stops
function transformToLaMetric(stops: GRTStop[], stopIds: string[]): LaMetricResponse {
    const frames: LaMetricFrame[] = [];

    // Flatten all departures into individual { route, minutes } items
    const allDepartures: { route: string; minutes: number }[] = [];

    for (const stop of stops) {
        for (const arrival of stop.arrivals) {
            const minutes = getMinutesUntil(arrival.departure);

            // Skip departures that have already passed or are more than 2 hours away
            if (minutes < 0 || minutes > 120) continue;

            allDepartures.push({
                route: arrival.route.shortName,
                minutes,
            });
        }
    }

    // Sort by soonest, deduplicate by route, and take top 3 unique lines
    const seen = new Set<string>();
    const topDepartures = allDepartures
        .sort((a, b) => a.minutes - b.minutes)
        .filter(d => {
            if (seen.has(d.route)) return false;
            seen.add(d.route);
            return true;
        })
        .slice(0, 3);

    // Create one frame per departure
    for (const { route, minutes } of topDepartures) {
        const timeText = minutes <= 1 ? "Due" : `${minutes}'`;
        const icon = getRouteIcon(route);

        // Show goal bar highlighting route number when 3–10 min away
        const goalData = departureGoalData(route, minutes);

        frames.push({
            text: padForDisplay(route, timeText),
            icon,
            goalData,
        });
    }

    // No real-time departures — fall back to GTFS static schedule
    if (frames.length === 0) {
        const next = getNextScheduledDeparture(stopIds);
        if (next) {
            frames.push({
                text: padForDisplay(next.route, next.time),
                icon: getRouteIcon(next.route),
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

// Root endpoint - API information
app.get("/", (_req: Request, res: Response) => {
    res.json({
        name: "GRT & GO Transit LaMetric API",
        version: "2.0.0",
        endpoints: {
            "/departures": "GRT departures (top 3 soonest, compact) - ?stop=STOP_ID",
            "/stops": "List available GRT stops",
            "/alerts": "GRT alerts - ?stop=STOP_ID (optional)",
            "/go-departures": "GO Transit Union Station departures - ?lines=KI,LW (optional)",
            "/go-stop": "GO Transit stop-specific departures - ?stop=STOP_CODE",
            "/quick-view": "Quick view mode - ?quickViewStop=STOP_ID&quickViewRoute=ROUTE_NUM",
            "/quick-view/toggle": "Push notification (POST) - ?quickViewStop=STOP_ID&quickViewRoute=ROUTE_NUM",
            "/track/start": "Start/toggle departure tracking (POST) - ?stop=STOP_ID&route=ROUTE_NUM",
            "/track": "Departure tracking poll (App 2) - returns bracket-based frames",
            "/track/stop": "Cancel departure tracking (POST)",
            "/health": "Health check",
        },
    });
});

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
        const laMetricData = transformToLaMetric(stops, stopIds);

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

// ============================================
// GO Transit Union Station Departures
// ============================================

interface GOTrip {
    Info: string;
    TripNumber: string;
    Platform: string;
    Service: string;
    ServiceType: string;
    Time: string;
    Stops: { Name: string; Code: string }[];
}

interface GOResponse {
    Metadata: {
        TimeStamp: string;
        ErrorCode: string;
        ErrorMessage: string;
    };
    AllDepartures: {
        Trip: GOTrip[];
    };
}

const GO_TRANSIT_API_URL = "https://api.openmetrolinx.com/OpenDataAPI/api/V1/ServiceUpdate/UnionDepartures/All";

// Fetch departures from GO Transit API
async function fetchGODepartures(): Promise<GOTrip[]> {
    const apiKey = process.env.GO_TRANSIT_API_KEY;
    if (!apiKey) {
        throw new Error("GO_TRANSIT_API_KEY not configured");
    }

    const response = await fetch(`${GO_TRANSIT_API_URL}?key=${apiKey}`, {
        method: "GET",
        headers: {
            Accept: "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(`GO Transit API error: ${response.status}`);
    }

    const data = (await response.json()) as GOResponse;
    return data.AllDepartures?.Trip || [];
}

// Transform GO Transit data to LaMetric format
function transformGOToLaMetric(trips: GOTrip[], lineFilter?: string[]): LaMetricResponse {
    const frames: LaMetricFrame[] = [];

    // Filter to trains only (ServiceType is "T" for trains, "B" for buses)
    // Also filter out departures more than 3 hours away
    // Note: GO Transit API returns times in Eastern time without timezone info
    const now = new Date();
    const threeHoursMs = 3 * 60 * 60 * 1000;
    let trainTrips = trips.filter((trip) => {
        if (trip.ServiceType !== "T") return false;
        // Parse time as Eastern time (append timezone offset)
        // GO Transit times are in format "2025-12-17 14:34:00"
        const timeStr = trip.Time.replace(" ", "T") + "-05:00"; // EST offset
        const departureTime = new Date(timeStr);
        const diffMs = departureTime.getTime() - now.getTime();
        return diffMs >= 0 && diffMs <= threeHoursMs;
    });

    // Filter by specific lines if provided
    if (lineFilter && lineFilter.length > 0) {
        trainTrips = trainTrips.filter((trip) => {
            // Match against Service field (e.g., "Stouffville" matches "ST")
            const serviceLower = trip.Service.toLowerCase();
            return lineFilter.some((line) => {
                const lineLower = line.toLowerCase();
                // Common line codes: LW, LE, ST, RH, BA, MI, KI, UP
                const lineMap: Record<string, string[]> = {
                    lw: ["lakeshore west"],
                    le: ["lakeshore east"],
                    st: ["stouffville"],
                    rh: ["richmond hill"],
                    ba: ["barrie"],
                    mi: ["milton"],
                    ki: ["kitchener"],
                    up: ["up express", "union pearson"],
                };
                const matchTerms = lineMap[lineLower] || [lineLower];
                return matchTerms.some((term) => serviceLower.includes(term));
            });
        });
    }

    // Sort by departure time
    const sortedTrips = trainTrips.sort((a, b) =>
        new Date(a.Time).getTime() - new Date(b.Time).getTime()
    );

    // Take only one departure per line (first/soonest departure for each line)
    const seenLines = new Set<string>();
    const uniqueLineTrips = sortedTrips.filter((trip) => {
        const line = trip.Service.toLowerCase();
        if (seenLines.has(line)) return false;
        seenLines.add(line);
        return true;
    });

    // Take top 10 unique lines
    const topTrips = uniqueLineTrips.slice(0, 10);

    // GO Transit line icons
    const lineIcons: Record<string, string> = {
        milton: "i71730",
        "lakeshore west": "i71731",
        "lakeshore east": "i71732",
        kitchener: "i71733",
        "richmond hill": "i71734",
        barrie: "i71735",
        stouffville: "i71736",
    };

    // Zero-progress goal bar (visual indicator for platform frame)
    const platformGoalData = {
        start: 0,
        current: 0,
        end: 1,
        unit: "",
    };

    for (const trip of topTrips) {
        // Get icon for this line
        const serviceLower = trip.Service.toLowerCase();
        const icon = lineIcons[serviceLower];

        // Get destination (last stop)
        const destination = trip.Stops?.length > 0
            ? trip.Stops[trip.Stops.length - 1].Name
            : trip.Service;

        // Frame 1: Headsign/destination
        frames.push({
            text: destination,
            icon,
        });

        // Frame 2: Departure time in 24h format (extract from string to avoid timezone issues)
        // Time format is "2025-12-17 14:34:00" - extract HH:MM
        const timePart = trip.Time.split(" ")[1] || "";
        const [hours, mins] = timePart.split(":");
        frames.push({
            text: `${hours}:${mins}`,
            icon,
        });

        // Frame 3 (optional): Platform if assigned (skip if empty or "-")
        // Show zero-progress goal bar as visual indicator that platform is assigned
        if (trip.Platform && trip.Platform.trim() !== "" && trip.Platform.trim() !== "-") {
            // Reformat "5 & 6" to "5/6"
            const platform = trip.Platform.replace(/ & /g, "/");
            frames.push({
                text: `→ ${platform}`,
                icon,
                goalData: platformGoalData,
            });
        }
    }

    // If no departures found, show X icon
    if (frames.length === 0) {
        frames.push({
            text: "NO SVC",
            icon: "i270",
        });
    }

    return { frames };
}

// GO Transit departures endpoint
app.get("/go-departures", async (req: Request, res: Response) => {
    try {
        // Debug: check if API key is configured
        const apiKey = process.env.GO_TRANSIT_API_KEY;
        if (!apiKey) {
            res.json({
                frames: [{ text: "NO KEY", icon: "i555" }],
            });
            return;
        }

        // Optional line filter (e.g., ?lines=ST,LW)
        const linesParam = req.query.lines as string | undefined;
        const lineFilter = linesParam
            ? linesParam.split(",").map((l) => l.trim())
            : undefined;

        const trips = await fetchGODepartures();

        // Debug: if no trips returned
        if (trips.length === 0) {
            res.json({
                frames: [{ text: "0 TRIPS", icon: "i555" }],
            });
            return;
        }

        const laMetricData = transformGOToLaMetric(trips, lineFilter);

        res.json(laMetricData);
    } catch (error) {
        console.error("Error fetching GO departures:", error);
        const errorMsg = error instanceof Error ? error.message : "Unknown";
        // Show first 10 chars of error on LaMetric
        res.status(500).json({
            frames: [{ text: errorMsg.slice(0, 12), icon: "i555" }],
        });
    }
});

// ============================================
// GO Transit Stop-Specific Departures
// ============================================

interface GONextServiceLine {
    StopCode: string;
    LineCode: string;
    LineName: string;
    ServiceType: string;
    DirectionCode: string;
    DirectionName: string;
    ScheduledDepartureTime: string;
    ComputedDepartureTime: string;
    DepartureStatus: string;
    ScheduledPlatform: string;
    ActualPlatform: string;
    TripOrder: number;
    TripNumber: string;
    UpdateTime: string;
    Status: string;
    Latitude: number;
    Longitude: number;
}

interface GONextServiceResponse {
    Metadata: {
        TimeStamp: string;
        ErrorCode: string;
        ErrorMessage: string;
    };
    NextService: {
        Lines: GONextServiceLine[];
    };
}

const GO_TRANSIT_NEXT_SERVICE_API_URL = "https://api.openmetrolinx.com/OpenDataAPI/api/V1/Stop/NextService/";

// Fetch departures from GO Transit NextService API for a specific stop
async function fetchGOStopDepartures(stopCode: string): Promise<GONextServiceLine[]> {
    const apiKey = process.env.GO_TRANSIT_API_KEY;
    if (!apiKey) {
        throw new Error("GO_TRANSIT_API_KEY not configured");
    }

    const response = await fetch(`${GO_TRANSIT_NEXT_SERVICE_API_URL}?key=${apiKey}&StopCode=${stopCode}`, {
        method: "GET",
        headers: {
            Accept: "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(`GO Transit API error: ${response.status}`);
    }

    const data = (await response.json()) as GONextServiceResponse;
    
    // Check for API errors (204 is "No Content" which is valid - just means no service)
    if (data.Metadata.ErrorCode !== "200" && data.Metadata.ErrorCode !== "204") {
        throw new Error(data.Metadata.ErrorMessage || "GO Transit API error");
    }

    return data.NextService?.Lines || [];
}

// Transform GO Transit NextService data to LaMetric format
function transformGONextServiceToLaMetric(lines: GONextServiceLine[], lineFilter?: string[]): LaMetricResponse {
    const frames: LaMetricFrame[] = [];

    // Separate trains and buses
    // Get current time in Eastern timezone for accurate comparison
    const now = new Date();
    const threeHoursMs = 3 * 60 * 60 * 1000;
    
    // Filter and separate by service type
    const trains: GONextServiceLine[] = [];
    const buses: GONextServiceLine[] = [];
    
    for (const line of lines) {
        if (line.ServiceType !== "T" && line.ServiceType !== "B") continue;
        
        // Parse ComputedDepartureTime (format: "2026-01-04 15:00:00")
        // GO Transit times are in Eastern time - try EST first, then EDT if needed
        let timeStr = line.ComputedDepartureTime.replace(" ", "T") + "-05:00"; // EST offset
        let departureTime = new Date(timeStr);
        let diffMs = departureTime.getTime() - now.getTime();
        
        // If the time seems way off (more than 24 hours in the future), try EDT
        if (diffMs > 24 * 60 * 60 * 1000) {
            timeStr = line.ComputedDepartureTime.replace(" ", "T") + "-04:00";
            departureTime = new Date(timeStr);
            diffMs = departureTime.getTime() - now.getTime();
        }
        
        // For trains: filter out departures more than 3 hours away or in the past
        // For buses: allow up to 1 minute in the past (to show as "Due" for just-departed buses), filter out more than 3 hours away
        const oneMinuteMs = 60 * 1000;
        if (line.ServiceType === "T") {
            if (diffMs < 0 || diffMs > threeHoursMs) continue;
        } else {
            // Buses: allow slightly in the past (up to 1 minute) to show as "Due" - for buses that just left
            if (diffMs < -oneMinuteMs || diffMs > threeHoursMs) continue;
        }
        
        if (line.ServiceType === "T") {
            trains.push(line);
        } else {
            buses.push(line);
        }
    }

    // Filter by specific lines if provided
    if (lineFilter && lineFilter.length > 0) {
        const filteredTrains = trains.filter((line) => {
            const lineNameLower = line.LineName.toLowerCase();
            return lineFilter.some((filter) => {
                const filterLower = filter.toLowerCase();
                const lineMap: Record<string, string[]> = {
                    lw: ["lakeshore west"],
                    le: ["lakeshore east"],
                    st: ["stouffville"],
                    rh: ["richmond hill"],
                    ba: ["barrie"],
                    mi: ["milton"],
                    ki: ["kitchener"],
                    up: ["up express", "union pearson"],
                };
                const matchTerms = lineMap[filterLower] || [filterLower];
                return matchTerms.some((term) => lineNameLower.includes(term));
            });
        });
        trains.length = 0;
        trains.push(...filteredTrains);
    }

    // GO Transit logo icon for buses
    const GO_BUS_ICON = "i71737";

    // Process buses - group by bus number + headsign (like GRT)
    if (buses.length > 0) {
        const busGrouped = new Map<string, { busNumber: string; headsign: string; times: number[] }>();

        for (const bus of buses) {
            // Calculate minutes until departure
            // GO Transit times are in Eastern time - use same parsing as above
            let timeStr = bus.ComputedDepartureTime.replace(" ", "T") + "-05:00";
            let departureTime = new Date(timeStr);
            let minutes = Math.round((departureTime.getTime() - now.getTime()) / 1000 / 60);
            
            // If the time seems way off (more than 24 hours in the future), try EDT
            if (minutes > 1440) {
                timeStr = bus.ComputedDepartureTime.replace(" ", "T") + "-04:00";
                departureTime = new Date(timeStr);
                minutes = Math.round((departureTime.getTime() - now.getTime()) / 1000 / 60);
            }
            
            // Skip if more than 2 hours away (matching GRT behavior)
            // Allow buses up to 1 minute in the past to show as "Due" - for buses that just left
            if (minutes < -1 || minutes > 120) continue;

            // Get bus number with branch code (LineCode might be "30", DirectionCode might have "A")
            // Combine LineCode and DirectionCode to get full bus number like "30A"
            const busNumber = bus.LineCode.trim();
            const branchCode = bus.DirectionCode.trim().replace(busNumber, "").trim();
            const fullBusNumber = branchCode ? `${busNumber}${branchCode}` : busNumber;

            // Get destination from DirectionName (e.g., "GT - Union Station" -> "Union Station")
            const headsign = bus.DirectionName.includes(" - ")
                ? bus.DirectionName.split(" - ")[1]
                : bus.DirectionName;

            const key = `${fullBusNumber}|${headsign}`;

            if (!busGrouped.has(key)) {
                busGrouped.set(key, { busNumber: fullBusNumber, headsign, times: [] });
            }
            busGrouped.get(key)!.times.push(minutes);
        }

        // Get top buses sorted by soonest departure
        const sortedBuses = [...busGrouped.values()]
            .map((bus) => ({
                ...bus,
                minTime: Math.min(...bus.times),
            }))
            .sort((a, b) => a.minTime - b.minTime)
            .slice(0, 10);

        // Create frames for buses (GRT format)
        for (const { busNumber, headsign, times } of sortedBuses) {
            // Sort times and take first 2
            times.sort((a, b) => a - b);
            const nextTimes = times.slice(0, 2);

            // Frame 1: Bus number with branch code (e.g., "30A")
            frames.push({
                text: busNumber,
                icon: GO_BUS_ICON,
            });

            // Frame 2: Headsign (destination)
            frames.push({
                text: headsign,
                icon: GO_BUS_ICON,
            });

            // Frame 3: Next departure times (2 times)
            const isDueSoon = nextTimes[0] <= 1;
            const timeGoalData = isDueSoon ? {
                start: 0,
                current: 1,
                end: 1,
                unit: "",
            } : undefined;

            const timeText = nextTimes
                .map((t) => (t <= 1 ? "Due" : `${t}m`))
                .join(", ");
            frames.push({
                text: timeText,
                icon: GO_BUS_ICON,
                goalData: timeGoalData,
            });
        }
    }

    // Process trains - keep existing format
    if (trains.length > 0) {
        // Sort by departure time
        const sortedTrains = trains.sort((a, b) => {
            const timeA = new Date(a.ComputedDepartureTime.replace(" ", "T") + "-05:00");
            const timeB = new Date(b.ComputedDepartureTime.replace(" ", "T") + "-05:00");
            return timeA.getTime() - timeB.getTime();
        });

        // Take only one departure per line (first/soonest departure for each line)
        const seenLines = new Set<string>();
        const uniqueLineTrips = sortedTrains.filter((line) => {
            const lineKey = line.LineName.toLowerCase();
            if (seenLines.has(lineKey)) return false;
            seenLines.add(lineKey);
            return true;
        });

        // Take top 10 unique lines
        const topTrains = uniqueLineTrips.slice(0, 10);

        // GO Transit line icons (trains)
        const lineIcons: Record<string, string> = {
            milton: "i71730",
            "lakeshore west": "i71731",
            "lakeshore east": "i71732",
            kitchener: "i71733",
            "richmond hill": "i71734",
            barrie: "i71735",
            stouffville: "i71736",
        };

        // Zero-progress goal bar (visual indicator for platform frame)
        const platformGoalData = {
            start: 0,
            current: 0,
            end: 1,
            unit: "",
        };

        for (const train of topTrains) {
            // Get icon for this line
            const lineNameLower = train.LineName.toLowerCase();
            const icon = lineIcons[lineNameLower];

            // Get destination from DirectionName (e.g., "GT - Union Station" -> "Union Station")
            const destination = train.DirectionName.includes(" - ")
                ? train.DirectionName.split(" - ")[1]
                : train.DirectionName;

            // Frame 1: Headsign/destination
            frames.push({
                text: destination,
                icon,
            });

            // Frame 2: Departure time in 24h format (extract from ComputedDepartureTime)
            const timePart = train.ComputedDepartureTime.split(" ")[1] || "";
            const [hours, mins] = timePart.split(":");
            frames.push({
                text: `${hours}:${mins}`,
                icon,
            });

            // Frame 3 (optional): Platform if assigned
            const platform = train.ActualPlatform && train.ActualPlatform.trim() !== ""
                ? train.ActualPlatform
                : train.ScheduledPlatform && train.ScheduledPlatform.trim() !== "" && train.ScheduledPlatform.trim() !== "-"
                ? train.ScheduledPlatform
                : null;

            if (platform) {
                const platformFormatted = platform.replace(/ & /g, "/");
                frames.push({
                    text: `→ ${platformFormatted}`,
                    icon,
                    goalData: platformGoalData,
                });
            }
        }
    }

    // If no departures found, show X icon
    if (frames.length === 0) {
        frames.push({
            text: "NO SVC",
            icon: "i270",
        });
    }

    return { frames };
}

// GO Transit stop-specific departures endpoint (supports both trains and buses, multiple stops)
app.get("/go-stop", async (req: Request, res: Response) => {
    try {
        // Check if API key is configured
        const apiKey = process.env.GO_TRANSIT_API_KEY;
        if (!apiKey) {
            res.json({
                frames: [{ text: "NO KEY", icon: "i555" }],
            });
            return;
        }

        // Get stop code(s) from query parameter - supports comma-delimited values
        const stopParam = req.query.stop as string | undefined;
        if (!stopParam) {
            res.json({
                frames: [{ text: "Please input a GO Transit Stop # in the app", icon: "i555" }],
            });
            return;
        }

        // Parse multiple stop codes (comma-separated)
        const stopCodes = stopParam.split(",").map((code) => code.trim()).filter((code) => code.length > 0);

        // Optional line filter (e.g., ?stop=BE&lines=KI,LW)
        const linesParam = req.query.lines as string | undefined;
        const lineFilter = linesParam
            ? linesParam.split(",").map((l) => l.trim())
            : undefined;

        // Fetch departures for all stop codes
        const allLines: GONextServiceLine[] = [];
        for (const stopCode of stopCodes) {
            try {
                const lines = await fetchGOStopDepartures(stopCode);
                allLines.push(...lines);
            } catch (error) {
                console.error(`Error fetching departures for stop ${stopCode}:`, error);
                // Continue with other stops even if one fails
            }
        }

        // If no lines returned from any stop
        if (allLines.length === 0) {
            res.json({
                frames: [{ text: "NO SVC", icon: "i270" }],
            });
            return;
        }

        const laMetricData = transformGONextServiceToLaMetric(allLines, lineFilter);

        res.json(laMetricData);
    } catch (error) {
        console.error("Error fetching GO stop departures:", error);
        const errorMsg = error instanceof Error ? error.message : "Unknown";
        // Show first 12 chars of error on LaMetric
        res.status(500).json({
            frames: [{ text: errorMsg.slice(0, 12), icon: "i555" }],
        });
    }
});

// ============================================
// Quick View Mode - Single Frame Display
// ============================================

// Get departure info for a specific route at a stop
async function getQuickViewDeparture(stopId: string, routeFilter: string): Promise<{ minutes: number; route: string } | null> {
    const stops = await fetchDepartures([stopId]);

    let matchingDeparture: { minutes: number; route: string } | null = null;

    for (const stop of stops) {
        for (const arrival of stop.arrivals) {
            const minutes = getMinutesUntil(arrival.departure);

            if (minutes < 0 || minutes > 120) continue;

            if (arrival.route.shortName === routeFilter) {
                if (!matchingDeparture || minutes < matchingDeparture.minutes) {
                    matchingDeparture = {
                        minutes,
                        route: arrival.route.shortName,
                    };
                }
            }
        }
    }

    return matchingDeparture;
}

// Send a notification via LaMetric Cloud Push API
async function sendLaMetricNotification(
    frames: LaMetricFrame[],
    options?: {
        priority?: "info" | "warning" | "critical";
        sound?: { category: string; id: string; repeat?: number };
    }
): Promise<boolean> {
    const pushUrl = process.env.LAMETRIC_PUSH_URL;
    const pushToken = process.env.LAMETRIC_PUSH_TOKEN;

    if (!pushUrl || !pushToken) {
        console.error("LAMETRIC_PUSH_URL or LAMETRIC_PUSH_TOKEN not configured");
        return false;
    }

    try {
        const payload: Record<string, unknown> = {
            frames,
        };

        if (options?.priority) {
            payload.priority = options.priority;
        }
        if (options?.sound) {
            payload.sound = options.sound;
        }

        const response = await fetch(pushUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${pushToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        return response.ok;
    } catch (error) {
        console.error("Error sending LaMetric notification:", error);
        return false;
    }
}

// Quick view toggle endpoint - triggered by button press on App 1 (GET) or phone shortcut
// First hit: starts tracking → App 2 begins showing countdown brackets
// Second hit: stops tracking → App 2 goes back to IDLE
app.get("/quick-view/toggle", async (req: Request, res: Response) => {
    try {
        // Toggle off: if already tracking, cancel
        if (activeTracking) {
            clearTimeout(activeTracking.cleanupTimer);
            console.log(`Tracking stopped for route ${activeTracking.route}`);
            activeTracking = null;
            await sendLaMetricNotification(
                [{ text: "TRACKOFF", icon: TRACK_ICON_IDLE }],
                { priority: "info" }
            );
            res.json({ success: true, action: "stopped" });
            return;
        }

        // Toggle on: start tracking
        const stopId = (req.query.quickViewStop as string | undefined) || trackingConfig?.stopId;
        const routeFilter = (req.query.quickViewRoute as string | undefined) || trackingConfig?.route;

        if (!stopId || !routeFilter) {
            res.status(400).json({ error: "No stop/route configured — install and configure App 2 first" });
            return;
        }

        // Fetch departure
        const stops = await fetchDepartures([stopId]);
        let bestDeparture: { minutes: number; route: string; departureTime: string } | null = null;

        for (const stop of stops) {
            for (const arrival of stop.arrivals) {
                if (arrival.route.shortName !== routeFilter) continue;
                const minutes = getMinutesUntil(arrival.departure);
                if (minutes < 0 || minutes > 120) continue;
                if (!bestDeparture || minutes < bestDeparture.minutes) {
                    bestDeparture = { minutes, route: arrival.route.shortName, departureTime: arrival.departure };
                }
            }
        }

        if (!bestDeparture) {
            await sendLaMetricNotification(
                [{ text: padForDisplay(routeFilter, "--"), icon: TRACK_ICON_ACTIVE }],
                { priority: "info" }
            );
            res.json({ success: true, message: "No departures found" });
            return;
        }

        startTracking(stopId, routeFilter, bestDeparture.departureTime, bestDeparture.minutes);

        // Push confirmation notification to App 1
        const timeText = bestDeparture.minutes <= 1 ? "Due" : `${bestDeparture.minutes}'`;
        const goalData = departureGoalData(bestDeparture.route, bestDeparture.minutes);
        const icon = bestDeparture.minutes <= 10 ? TRACK_ICON_NEAR : TRACK_ICON_ACTIVE;
        const frame: LaMetricFrame = { text: padForDisplay(bestDeparture.route, timeText), icon, goalData };

        if (bestDeparture.minutes <= 5) {
            await sendLaMetricNotification([frame], {
                priority: "critical",
                sound: { category: "notifications", id: "bicycle", repeat: 1 },
            });
        } else {
            await sendLaMetricNotification([frame], { priority: "info" });
        }

        res.json({ success: true, action: "tracking", route: bestDeparture.route, minutes: bestDeparture.minutes });
    } catch (error) {
        console.error("Error in quick-view toggle:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Quick view endpoint - indicator app polls this for updates
// Shows goal bar at 5 minutes or less
app.get("/quick-view", async (req: Request, res: Response) => {
    try {
        const stopId = req.query.quickViewStop as string | undefined;
        const routeFilter = req.query.quickViewRoute as string | undefined;

        if (!stopId || !routeFilter) {
            res.json({
                frames: [{ text: "Configure stop & route", icon: "i555" }],
            });
            return;
        }

        const departure = await getQuickViewDeparture(stopId, routeFilter);

        if (!departure) {
            res.json({
                frames: [{
                    text: padForDisplay(routeFilter, "--"),
                    icon: TRACK_ICON_ACTIVE,
                }],
            });
            return;
        }

        const timeText = departure.minutes <= 1 ? "Due" : `${departure.minutes}'`;

        const goalData = departureGoalData(departure.route, departure.minutes);
        res.json({
            frames: [{
                text: padForDisplay(departure.route, timeText),
                icon: departure.minutes <= 10 ? TRACK_ICON_NEAR : TRACK_ICON_ACTIVE,
                goalData,
            }],
        });
    } catch (error) {
        console.error("Error fetching quick view:", error);
        res.status(500).json({
            frames: [{ text: "Error", icon: "i555" }],
        });
    }
});

// ============================================
// Departure Tracking (App 2 - "GRT Departure Alert")
// Poll-only: bracket changes trigger LaMetric notifications
// ============================================

interface TrackingState {
    stopId: string;
    route: string;
    targetDepartureTime: string; // ISO-8601 from GRT API
    startedAt: number;
    lastBracket: string; // "idle"|"tracking"|"10m"|"7m"|"6m"|"5m"
    cleanupTimer: NodeJS.Timeout;
}

let activeTracking: TrackingState | null = null;

// Stored config from App 2's poll params — used by quick-view/toggle
let trackingConfig: { stopId: string; route: string } | null = null;

const TRACK_ICON_IDLE = "i24274";  // orange — idle
const TRACK_ICON_ACTIVE = "i24029"; // blue — tracking (>10 min)
const TRACK_ICON_NEAR = "i24030";   // animated — ≤10 min

const IDLE_TRACKING_FRAME: LaMetricFrame = { text: padForDisplay("", "IDLE"), icon: TRACK_ICON_IDLE };

// Start (or restart) tracking for a stop+route. Bus departing auto-clears.
function startTracking(stopId: string, route: string, departureTime: string, minutesLeft: number): void {
    // Clear any existing tracking
    if (activeTracking) {
        clearTimeout(activeTracking.cleanupTimer);
    }

    // Schedule cleanup at departure time
    const cleanupTimer = setTimeout(() => {
        activeTracking = null;
        console.log(`Tracking for route ${route} at stop ${stopId} auto-cleared (departed)`);
    }, minutesLeft * 60 * 1000);

    const bracket = getMilestoneBracket(minutesLeft);
    activeTracking = {
        stopId,
        route,
        targetDepartureTime: departureTime,
        startedAt: Date.now(),
        lastBracket: bracket,
        cleanupTimer,
    };

    console.log(`Tracking started: route ${route} at stop ${stopId}, ${minutesLeft} min, bracket ${bracket}`);
}

function getMilestoneBracket(minutes: number): string {
    if (minutes <= 0) return "arrived";
    if (minutes === 1) return "1m";
    if (minutes === 2) return "2m";
    if (minutes === 3) return "3m";
    if (minutes === 4) return "4m";
    if (minutes === 5) return "5m";
    if (minutes === 6) return "6m";
    if (minutes === 7) return "7m";
    if (minutes <= 10) return "10m";
    return "tracking";
}

function getTrackingFrame(route: string, bracket: string): LaMetricFrame {
    let timeText: string;
    let goalData: LaMetricFrame["goalData"] | undefined;

    switch (bracket) {
        case "tracking":
            timeText = "SOON";
            goalData = departureGoalData(route, 15);
            break;
        case "10m":
            timeText = "10'";
            goalData = departureGoalData(route, 10);
            break;
        case "7m":
            timeText = "7'";
            goalData = departureGoalData(route, 7);
            break;
        case "6m":
            timeText = "6'";
            goalData = departureGoalData(route, 6);
            break;
        case "5m":
            timeText = "5'";
            goalData = departureGoalData(route, 5);
            break;
        case "4m":
            timeText = "4'";
            goalData = departureGoalData(route, 4);
            break;
        case "3m":
            timeText = "3'";
            goalData = departureGoalData(route, 3);
            break;
        case "2m":
            timeText = "2'";
            goalData = departureGoalData(route, 2);
            break;
        case "1m":
            timeText = "1'";
            goalData = departureGoalData(route, 1);
            break;
        default:
            timeText = "--";
    }

    const icon = bracket === "tracking" ? TRACK_ICON_ACTIVE : TRACK_ICON_NEAR;

    return {
        text: padForDisplay(route, timeText),
        icon,
        goalData,
    };
}

// Start/toggle tracking — standalone endpoint (alternative to quick-view/toggle)
app.post("/track/start", async (req: Request, res: Response) => {
    try {
        const stopId = req.query.stop as string;
        const route = req.query.route as string;

        if (!stopId || !route) {
            res.status(400).json({ error: "Missing stop or route" });
            return;
        }

        // Fetch live departures and find soonest for this route
        const stops = await fetchDepartures([stopId]);
        let bestDeparture: { minutes: number; route: string; departureTime: string } | null = null;

        for (const stop of stops) {
            for (const arrival of stop.arrivals) {
                if (arrival.route.shortName !== route) continue;
                const minutes = getMinutesUntil(arrival.departure);
                if (minutes < 0 || minutes > 120) continue;
                if (!bestDeparture || minutes < bestDeparture.minutes) {
                    bestDeparture = { minutes, route: arrival.route.shortName, departureTime: arrival.departure };
                }
            }
        }

        if (!bestDeparture) {
            res.json({ success: true, action: "no_departures" });
            return;
        }

        startTracking(stopId, route, bestDeparture.departureTime, bestDeparture.minutes);
        res.json({
            success: true,
            action: "started",
            route,
            stopId,
            minutesUntilDeparture: bestDeparture.minutes,
        });
    } catch (error) {
        console.error("Error in track/start:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Poll endpoint for App 2 — returns bracket-based frames
// Response only changes at milestone boundaries → LaMetric auto-notifies on change
// Also stores stop/route params so quick-view/toggle can use them
app.get("/track", async (req: Request, res: Response) => {
    try {
        // Store config from App 2's poll params
        const pollStop = req.query.stop as string | undefined;
        const pollRoute = req.query.route as string | undefined;
        if (pollStop && pollRoute) {
            trackingConfig = { stopId: pollStop, route: pollRoute };
        }

        if (!activeTracking) {
            res.json({ frames: [IDLE_TRACKING_FRAME] });
            return;
        }

        const { stopId, route } = activeTracking;

        // Re-fetch live departure from GRT API
        let minutesLeft: number;
        try {
            const departure = await getQuickViewDeparture(stopId, route);
            if (departure) {
                minutesLeft = departure.minutes;
            } else {
                // No live data — estimate from stored target time
                minutesLeft = getMinutesUntil(activeTracking.targetDepartureTime);
            }
        } catch {
            // API failure — use stored target time estimate to avoid false notification
            minutesLeft = getMinutesUntil(activeTracking.targetDepartureTime);
        }

        // Cleanup if departed
        if (minutesLeft <= 0) {
            clearTimeout(activeTracking.cleanupTimer);
            activeTracking = null;
            res.json({ frames: [IDLE_TRACKING_FRAME] });
            return;
        }

        // Determine bracket and update state
        const bracket = getMilestoneBracket(minutesLeft);
        activeTracking.lastBracket = bracket;

        res.json({ frames: [getTrackingFrame(route, bracket)] });
    } catch (error) {
        console.error("Error in track poll:", error);
        // On error, return last known bracket frame to prevent false notification from data change
        if (activeTracking) {
            res.json({ frames: [getTrackingFrame(activeTracking.route, activeTracking.lastBracket)] });
        } else {
            res.json({ frames: [IDLE_TRACKING_FRAME] });
        }
    }
});

// Explicit cancel — App 2 button press
app.post("/track/stop", (_req: Request, res: Response) => {
    if (activeTracking) {
        clearTimeout(activeTracking.cleanupTimer);
        const route = activeTracking.route;
        activeTracking = null;
        console.log(`Tracking stopped for route ${route}`);
    }

    res.json({ success: true, action: "stopped" });
});

// Tracking status — for iPhone Shortcuts
app.get("/track/status", (_req: Request, res: Response) => {
    if (activeTracking) {
        const minutes = getMinutesUntil(activeTracking.targetDepartureTime);
        res.json({
            active: true,
            route: activeTracking.route,
            stopId: activeTracking.stopId,
            minutes,
            bracket: activeTracking.lastBracket,
        });
    } else {
        res.json({ active: false });
    }
});

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
});

app.listen(PORT, () => {
    console.log(`🚌 GRT LaMetric API running on port ${PORT}`);
});
