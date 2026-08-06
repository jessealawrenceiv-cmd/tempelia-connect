import { describe, expect, it } from "vitest";
import { greetingLine, pickWeatherIcon, sanitizeZipInput, isValidZip } from "@/lib/weather";
const at = (h: number) => { const d = new Date(); d.setHours(h, 30, 0, 0); return d; };
describe("greeting", () => {
  it("morning before noon", () => { expect(greetingLine(at(6), "Acme")).toBe("Good morning, Acme"); expect(greetingLine(at(11), "Acme")).toBe("Good morning, Acme"); });
  it("afternoon 12-5", () => { expect(greetingLine(at(12), "Acme")).toBe("Good afternoon, Acme"); expect(greetingLine(at(16), "Acme")).toBe("Good afternoon, Acme"); });
  it("evening after 5", () => { expect(greetingLine(at(17), "Acme")).toBe("Good evening, Acme"); expect(greetingLine(at(23), "Acme")).toBe("Good evening, Acme"); });
});
describe("icon", () => {
  it("picks", () => {
    expect(pickWeatherIcon("Rain likely before 2pm, then mostly sunny")).toBe("rain");
    expect(pickWeatherIcon("Sunny")).toBe("sun");
    expect(pickWeatherIcon("Breezy and clear")).toBe("wind");
    expect(pickWeatherIcon("Mostly Cloudy")).toBe("cloud");
    expect(pickWeatherIcon("")).toBe("cloud");
  });
});
describe("zip", () => { it("sanitizes", () => { expect(sanitizeZipInput("7a2201x9")).toBe("72201"); expect(isValidZip("7220")).toBe(false); expect(isValidZip("72201")).toBe(true); }); });
