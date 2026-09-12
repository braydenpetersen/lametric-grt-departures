import type { LaMetricFrame, LaMetricResponse } from "./transit";
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

const GO_TRANSIT_API_URL =
  "https://api.openmetrolinx.com/OpenDataAPI/api/V1/ServiceUpdate/UnionDepartures/All";

// Fetch departures from GO Transit API
export async function fetchGODepartures(apiKey: string): Promise<GOTrip[]> {
  if (!apiKey) {
    throw new Error("GO_TRANSIT_API_KEY not configured");
  }

  const response = await fetch(`${GO_TRANSIT_API_URL}?key=${apiKey}`, {
    method: "GET",
    signal: AbortSignal.timeout(8000),
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
export function transformGOToLaMetric(
  trips: GOTrip[],
  lineFilter?: string[],
): LaMetricResponse {
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
  const sortedTrips = trainTrips.sort(
    (a, b) => new Date(a.Time).getTime() - new Date(b.Time).getTime(),
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
    const destination =
      trip.Stops?.length > 0
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
    if (
      trip.Platform &&
      trip.Platform.trim() !== "" &&
      trip.Platform.trim() !== "-"
    ) {
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

const GO_TRANSIT_NEXT_SERVICE_API_URL =
  "https://api.openmetrolinx.com/OpenDataAPI/api/V1/Stop/NextService/";

// Fetch departures from GO Transit NextService API for a specific stop
export async function fetchGOStopDepartures(
  stopCode: string,
  apiKey: string,
): Promise<GONextServiceLine[]> {
  if (!apiKey) {
    throw new Error("GO_TRANSIT_API_KEY not configured");
  }

  const response = await fetch(
    `${GO_TRANSIT_NEXT_SERVICE_API_URL}?key=${apiKey}&StopCode=${stopCode}`,
    {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: "application/json",
      },
    },
  );

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
export function transformGONextServiceToLaMetric(
  lines: GONextServiceLine[],
  lineFilter?: string[],
): LaMetricResponse {
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
    const busGrouped = new Map<
      string,
      { busNumber: string; headsign: string; times: number[] }
    >();

    for (const bus of buses) {
      // Calculate minutes until departure
      // GO Transit times are in Eastern time - use same parsing as above
      let timeStr = bus.ComputedDepartureTime.replace(" ", "T") + "-05:00";
      let departureTime = new Date(timeStr);
      let minutes = Math.round(
        (departureTime.getTime() - now.getTime()) / 1000 / 60,
      );

      // If the time seems way off (more than 24 hours in the future), try EDT
      if (minutes > 1440) {
        timeStr = bus.ComputedDepartureTime.replace(" ", "T") + "-04:00";
        departureTime = new Date(timeStr);
        minutes = Math.round(
          (departureTime.getTime() - now.getTime()) / 1000 / 60,
        );
      }

      // Skip if more than 2 hours away (matching GRT behavior)
      // Allow buses up to 1 minute in the past to show as "Due" - for buses that just left
      if (minutes < -1 || minutes > 120) continue;

      // Get bus number with branch code (LineCode might be "30", DirectionCode might have "A")
      // Combine LineCode and DirectionCode to get full bus number like "30A"
      const busNumber = bus.LineCode.trim();
      const branchCode = bus.DirectionCode.trim().replace(busNumber, "").trim();
      const fullBusNumber = branchCode
        ? `${busNumber}${branchCode}`
        : busNumber;

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
      const timeGoalData = isDueSoon
        ? {
            start: 0,
            current: 1,
            end: 1,
            unit: "",
          }
        : undefined;

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
      const timeA = new Date(
        a.ComputedDepartureTime.replace(" ", "T") + "-05:00",
      );
      const timeB = new Date(
        b.ComputedDepartureTime.replace(" ", "T") + "-05:00",
      );
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
      const platform =
        train.ActualPlatform && train.ActualPlatform.trim() !== ""
          ? train.ActualPlatform
          : train.ScheduledPlatform &&
              train.ScheduledPlatform.trim() !== "" &&
              train.ScheduledPlatform.trim() !== "-"
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
