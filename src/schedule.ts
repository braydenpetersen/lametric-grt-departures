import scheduleData from "../data/schedule.json";
import datesData from "../data/service-dates.json";

type Schedule = Record<string, Record<string, Record<string, string[]>>>;
const schedule = scheduleData as Schedule;
const dates = datesData as Record<string, string[]>;
export const scheduleThrough = Object.keys(dates).sort().at(-1);

// Construct a timezone-independent service date and wall-clock minute value.
export function easternDate(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    minutes: +parts.hour * 60 + +parts.minute,
  };
}
function shiftDate(date: string, days: number) {
  const d = new Date(
    Date.UTC(
      +date.slice(0, 4),
      +date.slice(4, 6) - 1,
      +date.slice(6, 8) + days,
    ),
  );
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}
export function getNextScheduledDeparture(
  stopIds: string[],
  now = new Date(),
  data = schedule,
  calendar = dates,
): { route: string; time: string } | null {
  const local = easternDate(now);
  let best: { route: string; minute: number } | undefined;
  // Yesterday's GTFS 24:xx departures belong to today's early morning.
  for (const offset of [-1, 0, 1]) {
    for (const service of calendar[shiftDate(local.date, offset)] ?? []) {
      for (const stop of stopIds) {
        for (const [route, times] of Object.entries(
          data[service]?.[stop] ?? {},
        )) {
          for (const time of times) {
            const [h, m] = time.split(":").map(Number);
            const minute = offset * 1440 + h * 60 + m;
            if (minute <= local.minutes) continue;
            if (!best || minute < best.minute) best = { route, minute };
            break;
          }
        }
      }
    }
  }
  if (!best) return null;
  const minute = ((best.minute % 1440) + 1440) % 1440;
  const h = Math.floor(minute / 60);
  return {
    route: best.route,
    time: `${h % 12 || 12}:${String(minute % 60).padStart(2, "0")}`,
  };
}
