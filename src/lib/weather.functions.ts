import { createServerFn } from "@tanstack/react-start";
import { isValidZip } from "./weather";

/**
 * Public, read-only forecast lookup for a 5-digit US ZIP. Cached server-side for
 * an hour (see weather.server.ts), so repeat page loads never hit api.weather.gov.
 */
export const getZipWeather = createServerFn({ method: "GET" })
  .inputValidator((input: { zip: string }) => {
    const zip = (input?.zip ?? "").trim();
    if (!isValidZip(zip)) throw new Error("Enter a 5-digit ZIP code");
    return { zip };
  })
  .handler(async ({ data }) => {
    const { getWeatherForZip } = await import("./weather.server");
    return getWeatherForZip(data.zip);
  });
