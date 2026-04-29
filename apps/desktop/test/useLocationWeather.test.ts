import { describe, it, expect } from "bun:test";
import {
  parseCityFromTimezone,
  iconForWeatherCode,
  geocodeCity,
  ipLocation,
  resolveLocationFresh,
  fetchWeatherIconFresh,
} from "../src/renderer/shared/useLocationWeather";

type FetchCall = { url: string };

function mockFetcher(responses: Record<string, { ok?: boolean; body?: unknown } | Error>): {
  fetcher: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    for (const [key, value] of Object.entries(responses)) {
      if (url.includes(key)) {
        if (value instanceof Error) throw value;
        return new Response(JSON.stringify(value.body ?? {}), {
          status: value.ok === false ? 500 : 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("parseCityFromTimezone", () => {
  it("extracts the city from a region/city tz", () => {
    expect(parseCityFromTimezone("America/New_York")).toBe("New York");
    expect(parseCityFromTimezone("Europe/Berlin")).toBe("Berlin");
    expect(parseCityFromTimezone("Pacific/Honolulu")).toBe("Honolulu");
  });

  it("replaces underscores with spaces", () => {
    expect(parseCityFromTimezone("America/Los_Angeles")).toBe("Los Angeles");
    expect(parseCityFromTimezone("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
  });

  it("rejects zones without a city component", () => {
    expect(parseCityFromTimezone("UTC")).toBeNull();
    expect(parseCityFromTimezone("Etc/UTC")).toBeNull();
    expect(parseCityFromTimezone("Etc/GMT+5")).toBeNull();
  });

  it("rejects empty or falsy input", () => {
    expect(parseCityFromTimezone(null)).toBeNull();
    expect(parseCityFromTimezone(undefined)).toBeNull();
    expect(parseCityFromTimezone("")).toBeNull();
  });
});

describe("iconForWeatherCode", () => {
  it("picks sun or moon for clear skies", () => {
    expect(iconForWeatherCode(0, true)).toBe("☀️");
    expect(iconForWeatherCode(0, false)).toBe("🌙");
  });

  it("picks partly-cloudy day vs cloudy night for codes 1-2", () => {
    expect(iconForWeatherCode(1, true)).toBe("🌤️");
    expect(iconForWeatherCode(2, true)).toBe("🌤️");
    expect(iconForWeatherCode(1, false)).toBe("☁️");
  });

  it("maps overcast and fog", () => {
    expect(iconForWeatherCode(3, true)).toBe("☁️");
    expect(iconForWeatherCode(45, true)).toBe("🌫️");
    expect(iconForWeatherCode(48, true)).toBe("🌫️");
  });

  it("maps drizzle, rain, and showers", () => {
    expect(iconForWeatherCode(51, true)).toBe("🌦️");
    expect(iconForWeatherCode(57, true)).toBe("🌦️");
    expect(iconForWeatherCode(63, true)).toBe("🌧️");
    expect(iconForWeatherCode(81, true)).toBe("🌧️");
  });

  it("maps snow and thunderstorms", () => {
    expect(iconForWeatherCode(73, true)).toBe("🌨️");
    expect(iconForWeatherCode(86, true)).toBe("🌨️");
    expect(iconForWeatherCode(95, true)).toBe("⛈️");
    expect(iconForWeatherCode(99, true)).toBe("⛈️");
  });

  it("falls back to a thermometer for unknown codes", () => {
    expect(iconForWeatherCode(-1, true)).toBe("🌡️");
    expect(iconForWeatherCode(50, true)).toBe("🌡️");
    expect(iconForWeatherCode(90, true)).toBe("🌡️");
  });
});

describe("geocodeCity", () => {
  it("returns coords from the first result", async () => {
    const { fetcher, calls } = mockFetcher({
      "geocoding-api.open-meteo.com": {
        body: { results: [{ name: "New York", latitude: 40.71, longitude: -74.0 }] },
      },
    });
    const r = await geocodeCity("New York", fetcher);
    expect(r).toEqual({ city: "New York", lat: 40.71, lon: -74.0 });
    expect(calls[0]?.url).toContain("name=New%20York");
  });

  it("returns null when the API returns no results", async () => {
    const { fetcher } = mockFetcher({
      "geocoding-api.open-meteo.com": { body: { results: [] } },
    });
    expect(await geocodeCity("Nowhere", fetcher)).toBeNull();
  });

  it("returns null on http failure or network error", async () => {
    const { fetcher: err } = mockFetcher({
      "geocoding-api.open-meteo.com": new Error("offline"),
    });
    expect(await geocodeCity("New York", err)).toBeNull();

    const { fetcher: bad } = mockFetcher({
      "geocoding-api.open-meteo.com": { ok: false, body: {} },
    });
    expect(await geocodeCity("New York", bad)).toBeNull();
  });
});

describe("ipLocation", () => {
  it("returns coords from ipapi payload", async () => {
    const { fetcher } = mockFetcher({
      "ipapi.co": { body: { city: "Paris", latitude: 48.85, longitude: 2.35 } },
    });
    expect(await ipLocation(fetcher)).toEqual({ city: "Paris", lat: 48.85, lon: 2.35 });
  });

  it("returns null when ipapi signals an error", async () => {
    const { fetcher } = mockFetcher({
      "ipapi.co": { body: { error: true, reason: "rate-limited" } },
    });
    expect(await ipLocation(fetcher)).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    const { fetcher } = mockFetcher({
      "ipapi.co": { body: { city: "Paris" } },
    });
    expect(await ipLocation(fetcher)).toBeNull();
  });
});

describe("resolveLocationFresh", () => {
  it("uses the IP city when ipapi succeeds", async () => {
    const { fetcher, calls } = mockFetcher({
      "ipapi.co": { body: { city: "Seattle", latitude: 47.6, longitude: -122.33 } },
      "geocoding-api.open-meteo.com": {
        body: { results: [{ name: "SHOULD_NOT_HIT", latitude: 0, longitude: 0 }] },
      },
    });
    const r = await resolveLocationFresh("America/Los_Angeles", fetcher);
    expect(r?.city).toBe("Seattle");
    expect(calls.some((c) => c.url.includes("geocoding-api"))).toBe(false);
  });

  it("falls back to the timezone city when IP lookup fails", async () => {
    const { fetcher, calls } = mockFetcher({
      "ipapi.co": { ok: false, body: {} },
      "geocoding-api.open-meteo.com": {
        body: { results: [{ name: "Tokyo", latitude: 35.68, longitude: 139.77 }] },
      },
    });
    const r = await resolveLocationFresh("Asia/Tokyo", fetcher);
    expect(r?.city).toBe("Tokyo");
    expect(calls.some((c) => c.url.includes("ipapi.co"))).toBe(true);
    expect(calls.some((c) => c.url.includes("geocoding-api"))).toBe(true);
  });

  it("returns the IP city even when the timezone has no city (e.g. UTC)", async () => {
    const { fetcher, calls } = mockFetcher({
      "ipapi.co": { body: { city: "London", latitude: 51.5, longitude: -0.12 } },
    });
    const r = await resolveLocationFresh("Etc/UTC", fetcher);
    expect(r?.city).toBe("London");
    expect(calls.every((c) => !c.url.includes("geocoding-api"))).toBe(true);
  });

  it("returns null when both IP and geocoding fail", async () => {
    const { fetcher } = mockFetcher({
      "ipapi.co": { ok: false, body: {} },
      "geocoding-api.open-meteo.com": { body: { results: [] } },
    });
    expect(await resolveLocationFresh("Europe/Nowhere", fetcher)).toBeNull();
  });
});

describe("fetchWeatherIconFresh", () => {
  it("returns the day icon for clear weather", async () => {
    const { fetcher } = mockFetcher({
      "api.open-meteo.com": { body: { current: { weather_code: 0, is_day: 1 } } },
    });
    expect(await fetchWeatherIconFresh(40, -74, fetcher)).toBe("☀️");
  });

  it("returns the night icon for clear weather at night", async () => {
    const { fetcher } = mockFetcher({
      "api.open-meteo.com": { body: { current: { weather_code: 0, is_day: 0 } } },
    });
    expect(await fetchWeatherIconFresh(40, -74, fetcher)).toBe("🌙");
  });

  it("returns null when payload is missing a weather code", async () => {
    const { fetcher } = mockFetcher({
      "api.open-meteo.com": { body: { current: {} } },
    });
    expect(await fetchWeatherIconFresh(40, -74, fetcher)).toBeNull();
  });

  it("returns null on http failure", async () => {
    const { fetcher } = mockFetcher({
      "api.open-meteo.com": { ok: false, body: {} },
    });
    expect(await fetchWeatherIconFresh(40, -74, fetcher)).toBeNull();
  });
});
