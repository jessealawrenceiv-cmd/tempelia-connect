/**
 * Server-only weather lookup: ZIP -> lat/lon -> National Weather Service forecast.
 *
 * api.weather.gov is free and key-less but asks callers to identify themselves
 * and not to hammer it, so every zip's result is cached for a full hour and
 * concurrent lookups for the same zip share one in-flight request.
 */
import { pickWeatherIcon, WEATHER_CACHE_MS, type ZipWeather } from "./weather";

const UA = "Temaro (admin@temaro.io)";

type CacheEntry = { expiresAt: number; value: ZipWeather };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ZipWeather>>();
/** Counts real NWS round-trips per zip, so caching can be proven end to end. */
const upstreamFetches = new Map<string, number>();

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/geo+json, application/json" },
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

/** ZIP -> centroid. Zippopotam first, US Census geocoder as a fallback. */
async function geocodeZip(zip: string): Promise<{ lat: number; lon: number; place: string | null }> {
  try {
    const body = (await getJson(`https://api.zippopotam.us/us/${zip}`)) as {
      places?: Array<{ latitude: string; longitude: string; "place name"?: string; "state abbreviation"?: string }>;
    };
    const p = body.places?.[0];
    if (p) {
      const city = p["place name"];
      const state = p["state abbreviation"];
      return {
        lat: Number(p.latitude),
        lon: Number(p.longitude),
        place: city ? (state ? `${city}, ${state}` : city) : null,
      };
    }
  } catch {
    /* fall through to the census geocoder */
  }

  const census = (await getJson(
    `https://geocoding.geo.census.gov/geocoder/locations/address?zip=${zip}&street=&benchmark=Public_AR_Current&format=json`,
  )) as { result?: { addressMatches?: Array<{ coordinates?: { x: number; y: number }; matchedAddress?: string }> } };
  const match = census.result?.addressMatches?.[0];
  if (!match?.coordinates) throw new Error(`Couldn't find a location for ZIP ${zip}`);
  return { lat: match.coordinates.y, lon: match.coordinates.x, place: match.matchedAddress ?? null };
}

async function fetchFromNws(zip: string): Promise<ZipWeather> {
  const { lat, lon, place } = await geocodeZip(zip);

  // NWS wants at most 4 decimal places on the points endpoint.
  const points = (await getJson(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
  )) as { properties?: { forecast?: string; forecastHourly?: string; relativeLocation?: { properties?: { city?: string; state?: string } } } };

  const forecastUrl = points.properties?.forecast;
  if (!forecastUrl) throw new Error("No forecast grid for that ZIP code");

  const forecast = (await getJson(forecastUrl)) as {
    properties?: { periods?: Array<{ temperature: number; temperatureUnit: string; shortForecast: string }> };
  };
  const period = forecast.properties?.periods?.[0];

  // Hourly gives the closest thing to a "current" temperature.
  let temperature = period?.temperature ?? null;
  let temperatureUnit = period?.temperatureUnit ?? "F";
  const hourlyUrl = points.properties?.forecastHourly;
  if (hourlyUrl) {
    try {
      const hourly = (await getJson(hourlyUrl)) as {
        properties?: { periods?: Array<{ temperature: number; temperatureUnit: string }> };
      };
      const now = hourly.properties?.periods?.[0];
      if (now) {
        temperature = now.temperature;
        temperatureUnit = now.temperatureUnit;
      }
    } catch {
      /* keep the daily period's temperature */
    }
  }

  const rel = points.properties?.relativeLocation?.properties;
  const shortForecast = period?.shortForecast ?? "Forecast unavailable";

  return {
    zip,
    place: place ?? (rel?.city ? `${rel.city}, ${rel.state ?? ""}`.trim().replace(/,$/, "") : null),
    temperature,
    temperatureUnit,
    shortForecast,
    icon: pickWeatherIcon(shortForecast),
    cached: false,
    fetchedAt: new Date().toISOString(),
    upstreamFetches: 0,
  };
}

/** Cached (>= 1 hour) NWS lookup for a 5-digit ZIP. */
export async function getWeatherForZip(zip: string): Promise<ZipWeather> {
  const hit = cache.get(zip);
  if (hit && hit.expiresAt > Date.now()) {
    return { ...hit.value, cached: true, upstreamFetches: upstreamFetches.get(zip) ?? 0 };
  }

  const pending = inFlight.get(zip);
  if (pending) return { ...(await pending), cached: true };

  const promise = (async () => {
    upstreamFetches.set(zip, (upstreamFetches.get(zip) ?? 0) + 1);
    const value = await fetchFromNws(zip);
    const withCount = { ...value, upstreamFetches: upstreamFetches.get(zip) ?? 1 };
    cache.set(zip, { expiresAt: Date.now() + WEATHER_CACHE_MS, value: withCount });
    return withCount;
  })().finally(() => inFlight.delete(zip));

  inFlight.set(zip, promise);
  return promise;
}

/** Test/diagnostic helper: how many live NWS calls have happened for a zip. */
export function upstreamFetchCount(zip: string): number {
  return upstreamFetches.get(zip) ?? 0;
}
