import { describe, expect, it } from "vitest";
import { formatGermanDateTimeInput, parseGermanDateTimeInput } from "../shared/datetime.js";

describe("German date-time input helpers", () => {
  it("parses common German date-time inputs", () => {
    expect(parts(parseGermanDateTimeInput("26.05.2026 18:30"))).toEqual([2026, 4, 26, 18, 30]);
    expect(parts(parseGermanDateTimeInput("26.05.26 18:30"))).toEqual([2026, 4, 26, 18, 30]);
    expect(parts(parseGermanDateTimeInput("26.05.2026, 18:30"))).toEqual([2026, 4, 26, 18, 30]);
    expect(parts(parseGermanDateTimeInput("26.05.2026 um 18:30"))).toEqual([2026, 4, 26, 18, 30]);
  });

  it("rejects non-German or impossible date-time inputs", () => {
    expect(parseGermanDateTimeInput("2026-05-26T18:30")).toBeNull();
    expect(parseGermanDateTimeInput("31.02.2026 18:30")).toBeNull();
    expect(parseGermanDateTimeInput("26.05.2026 24:00")).toBeNull();
  });

  it("formats existing timestamps for German text input", () => {
    expect(formatGermanDateTimeInput(new Date(2026, 4, 26, 8, 5))).toBe("26.05.2026 08:05");
  });
});

function parts(date: Date | null): number[] | null {
  if (!date) return null;
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()];
}
