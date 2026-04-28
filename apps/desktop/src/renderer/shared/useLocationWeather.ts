import { useEffect, useState } from "react";

export type LocationWeather = {
  city: string | null;
  icon: string | null;
};

export type ResolvedLocation = {
  city: string;
  lat: number;
  lon: number;
};

type Fetcher = typeof fetch;

const WEATHER_TTL_MS = 10 * 60 * 1000;

let cachedLocation: ResolvedLocation | null = null;
let cachedWeather: { icon: string; fetchedAt: number; lat: number; lon: number } | null = null;
let inflight: Promise<void> | null = null;

export function parseCityFromTimezone(tz: string | null | undefined): string | null {
  if (!tz || tz.startsWith("Etc/") || tz === "UTC" || !tz.includes("/")) return null;
  const last = tz.split("/").pop();
  return last ? last.replace(/_/g, " ") : null;
}

function currentTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

type GeocodeHit = { name?: string; latitude?: number; longitude?: number };
type GeocodePayload = { results?: GeocodeHit[] };
type IpPayload = {
  city?: string;
  latitude?: number;
  longitude?: number;
  error?: boolean;
};
type WeatherPayload = { current?: { weather_code?: number; is_day?: number } };

export async function geocodeCity(
  city: string,
  fetcher: Fetcher = fetch,
): Promise<ResolvedLocation | null> {
  try {
    const r = await fetcher(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as GeocodePayload;
    const hit = data.results?.[0];
    if (!hit || typeof hit.latitude !== "number" || typeof hit.longitude !== "number") return null;
    return { city: hit.name ?? city, lat: hit.latitude, lon: hit.longitude };
  } catch {
    return null;
  }
}

// Fallback only — we prefer the OS timezone so the user's IP never leaves the
// device in the common case. ipapi.co is used when the timezone is missing or
// an Etc/* zone with no city component.
export async function ipLocation(fetcher: Fetcher = fetch): Promise<ResolvedLocation | null> {
  try {
    const r = await fetcher("https://ipapi.co/json/");
    if (!r.ok) return null;
    const data = (await r.json()) as IpPayload;
    if (data.error) return null;
    if (
      typeof data.latitude !== "number" ||
      typeof data.longitude !== "number" ||
      typeof data.city !== "string"
    ) {
      return null;
    }
    return { city: data.city, lat: data.latitude, lon: data.longitude };
  } catch {
    return null;
  }
}

export async function resolveLocationFresh(
  tz: string | null,
  fetcher: Fetcher = fetch,
): Promise<ResolvedLocation | null> {
  const city = parseCityFromTimezone(tz);
  if (city) {
    const geo = await geocodeCity(city, fetcher);
    if (geo) return geo;
  }
  return ipLocation(fetcher);
}

export function iconForWeatherCode(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? "☀️" : "🌙";
  if (code === 1 || code === 2) return isDay ? "🌤️" : "☁️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "🌧️";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

export async function fetchWeatherIconFresh(
  lat: number,
  lon: number,
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  try {
    const r = await fetcher(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,is_day`,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as WeatherPayload;
    const code = data.current?.weather_code;
    const isDay = data.current?.is_day === 1;
    if (typeof code !== "number") return null;
    return iconForWeatherCode(code, isDay);
  } catch {
    return null;
  }
}

async function resolveLocationCached(): Promise<ResolvedLocation | null> {
  if (cachedLocation) return cachedLocation;
  const loc = await resolveLocationFresh(currentTimezone());
  if (loc) cachedLocation = loc;
  return loc;
}

const peerLocationCache = new Map<string, ResolvedLocation>();

async function resolvePeerCity(city: string): Promise<ResolvedLocation | null> {
  const hit = peerLocationCache.get(city);
  if (hit) return hit;
  const loc = await geocodeCity(city);
  if (loc) peerLocationCache.set(city, loc);
  return loc;
}

function reportLocationToMain(city: string | null): void {
  // Tests import this module without an electron bridge — guard.
  if (typeof window === "undefined" || !window.chatheads?.setUserLocation) return;
  void window.chatheads.setUserLocation({ timezone: currentTimezone(), city });
}

async function fetchWeatherIconCached(lat: number, lon: number): Promise<string | null> {
  const now = Date.now();
  if (
    cachedWeather &&
    cachedWeather.lat === lat &&
    cachedWeather.lon === lon &&
    now - cachedWeather.fetchedAt < WEATHER_TTL_MS
  ) {
    return cachedWeather.icon;
  }
  const icon = await fetchWeatherIconFresh(lat, lon);
  if (icon) cachedWeather = { icon, fetchedAt: now, lat, lon };
  return icon;
}

/** Calling without arguments runs the existing self path: resolve via local
 *  timezone, IP fallback, and report back to main.
 *
 *  Passing `override` (even `null` or `{city: null}`) switches to peer mode:
 *  no local resolve, no server report. If `override.city` is set we geocode
 *  it for the weather icon; otherwise the hook returns empty state so the
 *  caller can render nothing for a peer we don't have data on yet. */
export function useLocationWeather(
  override?: { timezone: string | null; city: string | null } | null,
): LocationWeather {
  const isPeerMode = override !== undefined;
  const overrideCity = override?.city ?? null;

  const [state, setState] = useState<LocationWeather>(() => {
    if (isPeerMode) return { city: overrideCity, icon: null };
    return {
      city: cachedLocation?.city ?? null,
      icon: cachedWeather?.icon ?? null,
    };
  });

  useEffect(() => {
    let cancelled = false;

    if (isPeerMode) {
      setState({ city: overrideCity, icon: null });
      if (!overrideCity) return;
      void resolvePeerCity(overrideCity).then(async (loc) => {
        if (cancelled || !loc) return;
        setState((s) => (s.city === loc.city ? s : { ...s, city: loc.city }));
        const icon = await fetchWeatherIconCached(loc.lat, loc.lon);
        if (cancelled || !icon) return;
        setState((s) => (s.icon === icon ? s : { ...s, icon }));
      });
      return () => {
        cancelled = true;
      };
    }

    const run = async (): Promise<void> => {
      const loc = await resolveLocationCached();
      if (cancelled || !loc) return;
      setState((s) => (s.city === loc.city ? s : { ...s, city: loc.city }));
      reportLocationToMain(loc.city);
      const icon = await fetchWeatherIconCached(loc.lat, loc.lon);
      if (cancelled || !icon) return;
      setState((s) => (s.icon === icon ? s : { ...s, icon }));
    };
    // `inflight` dedups the two runs React 18 Strict Mode issues on mount (and
    // any other concurrent mounts) — subscribers wait on the same promise and
    // then snapshot from cache, instead of racing to the same APIs.
    if (inflight) {
      inflight.finally(() => {
        if (cancelled) return;
        setState({
          city: cachedLocation?.city ?? null,
          icon: cachedWeather?.icon ?? null,
        });
      });
    } else {
      inflight = run().finally(() => {
        inflight = null;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [isPeerMode, overrideCity]);

  return state;
}
