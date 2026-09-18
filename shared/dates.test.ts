import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  daysBetween,
  isValidISODate,
  startOfWeek,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  weekdayOf,
  weeksUntil,
} from "./dates";

test("addDays crosses a month boundary", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("addDays crosses a year boundary in both directions", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
});

test("a leap day exists in 2028 and does not in 2027", () => {
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2028-02-29", 1), "2028-03-01");
  assert.equal(addDays("2027-02-28", 1), "2027-03-01");
  assert.equal(daysBetween("2028-02-01", "2028-03-01"), 29);
  assert.equal(daysBetween("2027-02-01", "2027-03-01"), 28);
});

test("daysBetween is signed and zero on the same day", () => {
  assert.equal(daysBetween("2026-09-14", "2026-09-21"), 7);
  assert.equal(daysBetween("2026-09-21", "2026-09-14"), -7);
  assert.equal(daysBetween("2026-09-14", "2026-09-14"), 0);
});

test("startOfWeek of a Sunday returns the PRECEDING Monday", () => {
  // 2026-09-20 is a Sunday. It ends the week that began on the 14th; reading
  // it as the start of the next one would silently shift a whole week's plan.
  assert.equal(startOfWeek("2026-09-20"), "2026-09-14");
  assert.equal(startOfWeek("2026-09-14"), "2026-09-14", "a Monday is already its own week start");
  assert.equal(startOfWeek("2026-09-15"), "2026-09-14");
});

test("startOfWeek reaches back across a month and a year boundary", () => {
  assert.equal(startOfWeek("2026-03-01"), "2026-02-23");
  assert.equal(startOfWeek("2027-01-03"), "2026-12-28");
});

test("weekdayOf indexes Monday as 0 and Sunday as 6", () => {
  assert.equal(weekdayOf("2026-09-14"), 0);
  assert.equal(weekdayOf("2026-09-19"), 5);
  assert.equal(weekdayOf("2026-09-20"), 6);
  assert.equal(WEEKDAY_LABELS[weekdayOf("2026-09-19")], "Saturday");
  assert.equal(WEEKDAY_SHORT[weekdayOf("2026-09-20")], "Sun");
});

test("weeksUntil stays fractional — a race 10 days out is not 1 week out", () => {
  assert.equal(weeksUntil("2026-09-14", "2026-09-21"), 1);
  assert.ok(Math.abs(weeksUntil("2026-09-14", "2026-09-24") - 10 / 7) < 1e-9);
  assert.ok(weeksUntil("2026-09-24", "2026-09-14") < 0, "a date in the past is negative weeks out");
});

test("isValidISODate rejects dates the calendar doesn't have", () => {
  assert.ok(isValidISODate("2026-09-14"));
  assert.ok(isValidISODate("2028-02-29"), "2028 is a leap year");
  assert.ok(!isValidISODate("2027-02-29"), "2027 is not");
  assert.ok(!isValidISODate("2026-02-30"));
  assert.ok(!isValidISODate("2026-13-01"));
  assert.ok(!isValidISODate("2026-9-4"), "no zero padding is not the format the whole app agrees on");
  assert.ok(!isValidISODate("not a date"));
  assert.ok(!isValidISODate(20260914));
  assert.ok(!isValidISODate(undefined));
});

test("a week laid out by offsets round-trips through the helpers", () => {
  const weekStart = "2026-09-14";
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(weekStart, offset);
    assert.equal(weekdayOf(date), offset);
    assert.equal(startOfWeek(date), weekStart);
    assert.equal(daysBetween(weekStart, date), offset);
  }
});
