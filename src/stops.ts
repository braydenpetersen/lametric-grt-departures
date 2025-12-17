import fs from "fs";
import path from "path";

export interface Stop {
    id: string;
    code: string;
    name: string;
    lat: number;
    lon: number;
    locationType: number;
    parentStation: string | null;
}

// Parse the stops.txt GTFS file
export function loadStops(): Stop[] {
    const stopsPath = path.join(process.cwd(), "data", "GTFS", "stops.txt");
    const content = fs.readFileSync(stopsPath, "utf-8");
    const lines = content.trim().split("\n");

    // Skip header row
    const stops: Stop[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r/g, "");
        const parts = line.split(",");

        // stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station,wheelchair_boarding,platform_code
        const [
            stop_id,
            stop_code,
            stop_name,
            _stop_desc,
            stop_lat,
            stop_lon,
            _zone_id,
            _stop_url,
            location_type,
            parent_station,
        ] = parts;

        stops.push({
            id: stop_id,
            code: stop_code,
            name: stop_name,
            lat: parseFloat(stop_lat.trim()),
            lon: parseFloat(stop_lon.trim()),
            locationType: parseInt(location_type) || 0,
            parentStation: parent_station || null,
        });
    }

    return stops;
}

// Get stops formatted for LaMetric dropdown
export function getStopsForLaMetric(): { id: string; name: string }[] {
    const stops = loadStops();

    // Filter to only regular stops (locationType 0) and format for LaMetric
    // Format: "(1000) Stop Name" sorted by stop number
    return stops
        .filter((stop) => stop.locationType === 0)
        .map((stop) => ({
            id: stop.id,
            name: `(${stop.code}) ${stop.name}`,
        }))
        .sort((a, b) => parseInt(a.id) - parseInt(b.id));
}
