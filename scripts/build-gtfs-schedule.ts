/**
 * Pre-builds a compact JSON schedule from GTFS static data.
 *
 * Output: data/schedule.json
 * Structure: { [serviceType]: { [stopId]: { [routeShortName]: ["05:54", "06:24", ...] } } }
 *
 * Also outputs data/service-dates.json:
 * Structure: { [YYYYMMDD]: serviceType }
 *
 * Service types: "Weekday", "Saturday", "Sunday", "Holiday"
 * (Holiday variants Holiday1/Holiday2/Holiday3 are merged into "Holiday")
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data", "GTFS");
const OUT_DIR = join(__dirname, "..", "data");

function parseCsv(filename: string): Record<string, string>[] {
    const content = readFileSync(join(DATA_DIR, filename), "utf-8");
    const lines = content.trim().split("\n");
    const headers = lines[0].split(",");
    return lines.slice(1).map((line) => {
        const values = line.split(",");
        const row: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
            row[headers[i].trim()] = (values[i] || "").trim();
        }
        return row;
    });
}

// Parse service type from service_id (e.g. "31-Weekday-2-2026_1-1111100" -> "Weekday")
function getServiceType(serviceId: string): string {
    const match = serviceId.match(/-(Weekday|Saturday|Sunday|Holiday\d?)-/);
    if (!match) return "Unknown";
    const type = match[1];
    // Merge Holiday variants
    if (type.startsWith("Holiday")) return "Holiday";
    return type;
}

console.log("Parsing GTFS data...");

// 1. Build service_id -> serviceType mapping and date -> serviceType mapping
const calendarDates = parseCsv("calendar_dates.txt");
const serviceTypeMap = new Map<string, string>(); // service_id -> serviceType
const serviceDates: Record<string, string> = {}; // YYYYMMDD -> serviceType

for (const row of calendarDates) {
    if (row.exception_type !== "1") continue; // Only added services
    const serviceId = row.service_id;
    const serviceType = getServiceType(serviceId);
    serviceTypeMap.set(serviceId, serviceType);

    // Map date to service type (last one wins, but they should all agree for a given date)
    serviceDates[row.date] = serviceType;
}

console.log(`Found ${serviceTypeMap.size} service IDs, ${Object.keys(serviceDates).length} dates`);

// 2. Build trip_id -> { route_id, service_id } mapping
const trips = parseCsv("trips.txt");
const tripMap = new Map<string, { routeId: string; serviceType: string }>();

for (const row of trips) {
    const serviceType = serviceTypeMap.get(row.service_id);
    if (!serviceType) continue;
    tripMap.set(row.trip_id, { routeId: row.route_id, serviceType });
}

console.log(`Mapped ${tripMap.size} trips`);

// 3. Build route_id -> route_short_name mapping
const routes = parseCsv("routes.txt");
const routeNameMap = new Map<string, string>();
for (const row of routes) {
    routeNameMap.set(row.route_id, row.route_short_name);
}

// 4. Process stop_times - build the schedule
// Structure: { [serviceType]: { [stopId]: { [routeShortName]: Set<time> } } }
type ScheduleBuilder = Map<string, Map<string, Map<string, Set<string>>>>;
const schedule: ScheduleBuilder = new Map();

console.log("Processing stop_times (this may take a moment)...");

const stopTimesContent = readFileSync(join(DATA_DIR, "stop_times.txt"), "utf-8");
const stopTimesLines = stopTimesContent.trim().split("\n");

for (let i = 1; i < stopTimesLines.length; i++) {
    const parts = stopTimesLines[i].split(",");
    const tripId = parts[0];
    const departureTime = parts[2]; // HH:MM:SS
    const stopId = parts[3];

    const tripInfo = tripMap.get(tripId);
    if (!tripInfo) continue;

    const routeName = routeNameMap.get(tripInfo.routeId) || tripInfo.routeId;
    const serviceType = tripInfo.serviceType;

    // Format time as HH:MM (drop seconds), handle times >= 24:00 (GTFS convention for next-day)
    const [h, m] = departureTime.split(":");
    const hour = parseInt(h);
    const normalizedHour = hour % 24;
    const timeStr = `${normalizedHour.toString().padStart(2, "0")}:${m}`;

    if (!schedule.has(serviceType)) schedule.set(serviceType, new Map());
    const serviceSchedule = schedule.get(serviceType)!;
    if (!serviceSchedule.has(stopId)) serviceSchedule.set(stopId, new Map());
    const stopSchedule = serviceSchedule.get(stopId)!;
    if (!stopSchedule.has(routeName)) stopSchedule.set(routeName, new Set());
    stopSchedule.get(routeName)!.add(timeStr);
}

// 5. Convert to plain JSON with sorted times
const output: Record<string, Record<string, Record<string, string[]>>> = {};

for (const [serviceType, stops] of schedule) {
    output[serviceType] = {};
    for (const [stopId, routes] of stops) {
        output[serviceType][stopId] = {};
        for (const [routeName, times] of routes) {
            output[serviceType][stopId][routeName] = [...times].sort();
        }
    }
}

// Write schedule
const schedulePath = join(OUT_DIR, "schedule.json");
writeFileSync(schedulePath, JSON.stringify(output));
const scheduleSizeMB = (Buffer.byteLength(JSON.stringify(output)) / 1024 / 1024).toFixed(1);
console.log(`Wrote ${schedulePath} (${scheduleSizeMB} MB)`);

// Write service dates
const serviceDatesPath = join(OUT_DIR, "service-dates.json");
writeFileSync(serviceDatesPath, JSON.stringify(serviceDates));
console.log(`Wrote ${serviceDatesPath}`);

console.log("Done!");
