import { SELF, env, reset, abortAllDurableObjects } from "cloudflare:test";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { getNextScheduledDeparture, easternDate } from "../src/schedule";
const endpoint = "https://clock.test";
let arrivals: any[] = [];
function bus(minutes: number, id = "trip-one", route = "7") {
  return {
    trip: { id, headsign: "Test" },
    route: { shortName: route },
    arrival: new Date(Date.now() + minutes * 60_000).toISOString(),
    departure: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
}
async function call(path: string, method = "GET") {
  const response = await SELF.fetch(endpoint + path, { method });
  return { status: response.status, body: (await response.json()) as any };
}
beforeEach(async () => {
  await reset();
  arrivals = [bus(6)];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/vms/graphql"))
      return Response.json({
        data: { stops: [{ id: "1000", platformCode: null, arrivals }] },
      });
    if (url.includes("/api/alerts")) throw new Error("Upstream TLS failure");
    throw new Error("Unexpected fetch " + url);
  });
});
afterEach(() => vi.restoreAllMocks());
describe("Worker and durable tracking", () => {
  it("returns formatted departures despite an unavailable alerts feed", async () => {
    const r = await call("/departures?stop=1000");
    expect(r.status).toBe(200);
    expect(r.body.frames[0].text).toContain("6'");
    expect(r.body.frames[0].icon).toBe("i11999");
  });
  it("validates stop IDs before upstream requests", async () => {
    expect((await call("/departures?stop=oops")).status).toBe(400);
    expect((await call("/departures")).status).toBe(400);
    expect((await call("/track/start?stop=oops&route=7", "POST")).status).toBe(
      400,
    );
  });
  it("preserves tracking and button configuration across Durable Object eviction", async () => {
    await call("/track?stop=1000&route=7");
    expect((await call("/quick-view/toggle")).body.action).toBe("tracking");
    const stub = (env as any).TRACKING.get(
      (env as any).TRACKING.idFromName("personal-clock"),
    );
    await abortAllDurableObjects();
    expect((await call("/track/status")).body.active).toBe(true);
    expect((await call("/track")).body.frames[0].text).toContain("6'");
    expect((await call("/track/stop", "POST")).body.action).toBe("stopped");
    await abortAllDurableObjects();
    expect((await call("/track/status")).body.active).toBe(false);
    expect((await call("/quick-view/toggle")).body.action).toBe("tracking");
  });
  it("tracks the chosen trip when a different bus becomes sooner", async () => {
    await call("/track/start?stop=1000&route=7", "POST");
    arrivals = [bus(2, "another-trip"), bus(9)];
    expect((await call("/track/status")).body.minutes).toBe(9);
  });
  it("selects the next bus across routes and preserves all-route preference", async () => {
    arrivals = [bus(8, "a", "19"), bus(3, "b", "29"), bus(6, "c", "12")];
    expect(
      (await call("/track/start?stop=2674&route=all", "POST")).body.route,
    ).toBe("29");
    arrivals = [bus(1, "a", "19"), bus(4, "b", "29")];
    expect((await call("/track/status")).body.route).toBe("29");
    await call("/track/stop", "POST");
    expect((await call("/quick-view/toggle")).body.route).toBe("19");
  });
  it("keeps the selected estimate if the trip temporarily disappears", async () => {
    await call("/track/start?stop=1000&route=7", "POST");
    arrivals = [bus(30, "another-trip")];
    expect((await call("/track/status")).body.minutes).toBe(6);
  });
  it("ends tracking when the selected trip departs without jumping to the next one", async () => {
    await call("/track/start?stop=1000&route=7", "POST");
    arrivals = [bus(-1), bus(15, "another-trip")];
    expect((await call("/track/status")).body.active).toBe(false);
  });
  it("rejects unsupported mutation methods", async () => {
    expect((await call("/track/stop")).status).toBe(405);
  });
  it("reports alert failure honestly instead of claiming no alerts", async () => {
    expect((await call("/alerts")).body.frames[0].text).toBe(
      "Alerts unavailable",
    );
  });
});
describe("GTFS calendar", () => {
  it("uses the Eastern date across UTC midnight", () => {
    expect(easternDate(new Date("2026-09-13T02:00:00Z"))).toEqual({
      date: "20260912",
      minutes: 1320,
    });
  });
  it("includes previous service day departures after 24:00", () => {
    const data = { friday: { "1000": { "7": ["24:30"] } } },
      calendar = { "20260911": ["friday"] };
    expect(
      getNextScheduledDeparture(
        ["1000"],
        new Date("2026-09-12T04:10:00Z"),
        data,
        calendar,
      ),
    ).toEqual({ route: "7", time: "12:30" });
  });
  it("keeps distinct service IDs on the same date", () => {
    const data = {
        a: { "1000": { "7": ["09:00"] } },
        b: { "1000": { "8": ["08:30"] } },
      },
      calendar = { "20260912": ["a", "b"] };
    expect(
      getNextScheduledDeparture(
        ["1000"],
        new Date("2026-09-12T12:00:00Z"),
        data,
        calendar,
      )?.route,
    ).toBe("8");
  });
});
