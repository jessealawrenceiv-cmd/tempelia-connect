// TEMPORARY DEBUG ENDPOINT — used to verify clientIp() resolution. Remove after verification.
import { createFileRoute } from "@tanstack/react-router";
import { getRequestHeader } from "@tanstack/react-start/server";

function clientIp(): string {
  const cf = getRequestHeader("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = getRequestHeader("x-real-ip");
  if (real) return real.trim();
  const fwd = getRequestHeader("x-forwarded-for") || "";
  const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || "0.0.0.0";
}

export const Route = createFileRoute("/api/public/_debug/ip")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          resolved: clientIp(),
          received: {
            "cf-connecting-ip": getRequestHeader("cf-connecting-ip") || null,
            "x-real-ip": getRequestHeader("x-real-ip") || null,
            "x-forwarded-for": getRequestHeader("x-forwarded-for") || null,
          },
        }),
    },
  },
});
