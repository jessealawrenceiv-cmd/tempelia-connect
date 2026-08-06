import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Cloud, CloudRain, Sun, Wind } from "lucide-react";
import { useEffect, useState } from "react";
import { getZipWeather } from "@/lib/weather.functions";
import { greetingLine, isValidZip, WEATHER_CACHE_MS, type WeatherIcon } from "@/lib/weather";

function WeatherGlyph({ icon }: { icon: WeatherIcon }) {
  const cls = "h-6 w-6 text-moss";
  if (icon === "sun") return <Sun aria-hidden="true" className={cls} />;
  if (icon === "rain") return <CloudRain aria-hidden="true" className={cls} />;
  if (icon === "wind") return <Wind aria-hidden="true" className={cls} />;
  return <Cloud aria-hidden="true" className={cls} />;
}

/**
 * Greeting banner + one-line NWS weather strip at the top of Home.
 * The greeting uses the viewer's own clock and re-evaluates every minute so it
 * flips correctly if the page is left open across noon or 5pm.
 */
export function HomeGreetingWeather({
  businessName,
  zipCode,
}: {
  businessName?: string | null;
  zipCode?: string | null;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const zip = (zipCode ?? "").trim();
  const hasZip = isValidZip(zip);
  const fetchWeather = useServerFn(getZipWeather);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["home", "weather", zip],
    queryFn: () => fetchWeather({ data: { zip } }),
    enabled: hasZip,
    // Match the server-side cache: at most one lookup per hour per zip.
    staleTime: WEATHER_CACHE_MS,
    gcTime: WEATHER_CACHE_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  return (
    <section
      aria-label="Greeting and today's weather"
      className="panel mb-5 flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid="home-greeting-weather"
    >
      <h2 className="font-display text-2xl uppercase leading-none text-paper" data-testid="home-greeting">
        {greetingLine(now, businessName)}
      </h2>

      <div
        className="flex items-center gap-3 sm:justify-end"
        data-testid="home-weather"
        // Diagnostics: lets us prove the hourly cache is being honoured.
        data-weather-cached={data ? String(data.cached) : undefined}
        data-weather-upstream-fetches={data ? String(data.upstreamFetches) : undefined}
      >
        {!hasZip ? (
          <p className="mono text-[11px] uppercase tracking-widest text-muted-foreground" data-testid="home-weather-empty">
            Add your ZIP code in Settings to see today's weather
          </p>
        ) : isLoading ? (
          <p className="mono text-[11px] uppercase tracking-widest text-muted-foreground">Checking the forecast…</p>
        ) : isError || !data ? (
          <p className="mono text-[11px] uppercase tracking-widest text-muted-foreground" data-testid="home-weather-error">
            Weather unavailable right now
          </p>
        ) : (
          <>
            <WeatherGlyph icon={data.icon} />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="mono text-xl text-paper" data-testid="home-weather-temp">
                  {data.temperature === null ? "—" : `${Math.round(data.temperature)}°${data.temperatureUnit}`}
                </span>
                {data.place && (
                  <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{data.place}</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground" data-testid="home-weather-forecast">
                {data.shortForecast}
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
