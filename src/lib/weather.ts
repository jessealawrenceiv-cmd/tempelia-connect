/**
 * Pure, client-safe helpers for the Home greeting banner and weather strip.
 * No network access here so these can be unit tested directly.
 */

export type WeatherIcon = "sun" | "rain" | "wind" | "cloud";

/** Time-of-day greeting: before 12pm / 12pm–5pm / after 5pm, in the viewer's local time. */
export function greetingFor(date: Date): "Good morning" | "Good afternoon" | "Good evening" {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Full banner line, e.g. "Good morning, Ridgeline Plumbing". */
export function greetingLine(date: Date, businessName?: string | null): string {
  const name = (businessName ?? "").trim();
  return name ? `${greetingFor(date)}, ${name}` : greetingFor(date);
}

/**
 * Pick one simple icon from the NWS short-forecast wording.
 * Rain wins over sun ("Rain likely before 2pm, then mostly sunny" is a rain day),
 * wind is checked next, and anything unmatched falls back to a plain cloud.
 */
export function pickWeatherIcon(shortForecast: string | null | undefined): WeatherIcon {
  const text = (shortForecast ?? "").toLowerCase();
  if (!text) return "cloud";
  if (/(rain|shower|storm|thunder|drizzle|sleet|snow)/.test(text)) return "rain";
  if (/(wind|breez|blustery|gust)/.test(text)) return "wind";
  if (/(sunny|clear|fair)/.test(text)) return "sun";
  return "cloud";
}

/** Exactly five digits — the only location data we ask for. */
export function isValidZip(zip: string | null | undefined): boolean {
  return /^[0-9]{5}$/.test((zip ?? "").trim());
}

/** Keep only digits, max 5 — for the Settings input. */
export function sanitizeZipInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 5);
}

export type ZipWeather = {
  zip: string;
  place: string | null;
  temperature: number | null;
  temperatureUnit: string;
  shortForecast: string;
  icon: WeatherIcon;
  /** true when this response came from the server-side hourly cache */
  cached: boolean;
  fetchedAt: string;
  /** how many times the live NWS API has actually been called for this zip */
  upstreamFetches: number;
};

/** Client-side cache window must match the server's: one hour. */
export const WEATHER_CACHE_MS = 60 * 60 * 1000;
