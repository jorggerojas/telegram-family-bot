import { describe, expect, it } from "vitest";
import {
	calendarInterval,
	civilMidnight,
	classifyProximity,
	formatLocal,
	nextLocalDate,
	resolveSpanishDate,
} from "../src/shared/scheduling";

const MADRID = "Europe/Madrid";
const MEXICO = "America/Mexico_City";

describe("Spanish scheduling rules", () => {
	it("resolves a complete future date and preserves explicit 24-hour time", () => {
		const result = resolveSpanishDate(
			{
				day: 10,
				month: 10,
				year: undefined,
				hour: 18,
				minute: 0,
			},
			new Date("2026-10-09T12:00:00.000Z"),
			MADRID,
		);

		expect(result.ok && formatLocal(result.value.start, MADRID)).toBe(
			"10/10/26, 18:00",
		);
	});

	it("rejects a past date and a weekday contradiction", () => {
		expect(
			resolveSpanishDate(
				{ day: 8, month: 10, year: 2026, hour: 18, minute: 0 },
				new Date("2026-10-09T12:00:00.000Z"),
				MADRID,
			),
		).toMatchObject({ ok: false });
		expect(
			resolveSpanishDate(
				{
					day: 10,
					month: 10,
					year: 2026,
					hour: 18,
					minute: 0,
					weekday: "lunes",
				},
				new Date("2026-10-09T12:00:00.000Z"),
				MADRID,
			),
		).toMatchObject({ ok: false });
	});

	it("classifies exact 60-minute proximity boundaries", () => {
		const proposedStart = new Date("2026-10-10T16:00:00.000Z");
		const proposedEnd = new Date("2026-10-10T17:00:00.000Z");
		expect(
			classifyProximity(proposedStart, proposedEnd, {
				start: new Date("2026-10-10T15:00:00.000Z"),
				end: new Date("2026-10-10T16:00:00.000Z"),
			}),
		).toBe("NEAR_BEFORE");
		expect(
			classifyProximity(proposedStart, proposedEnd, {
				start: new Date("2026-10-10T13:59:59.000Z"),
				end: new Date("2026-10-10T14:59:59.000Z"),
			}),
		).toBe("CLEAR");
	});

	it.each([
		[
			"overlap",
			"2026-10-10T16:30:00.000Z",
			"2026-10-10T17:30:00.000Z",
			"OVERLAP",
		],
		[
			"ends 30 minutes before",
			"2026-10-10T14:30:00.000Z",
			"2026-10-10T15:30:00.000Z",
			"NEAR_BEFORE",
		],
		[
			"starts 30 minutes after",
			"2026-10-10T17:30:00.000Z",
			"2026-10-10T18:30:00.000Z",
			"NEAR_AFTER",
		],
		[
			"exactly 60 minutes before",
			"2026-10-10T14:00:00.000Z",
			"2026-10-10T15:00:00.000Z",
			"NEAR_BEFORE",
		],
		[
			"exactly 60 minutes after",
			"2026-10-10T18:00:00.000Z",
			"2026-10-10T19:00:00.000Z",
			"NEAR_AFTER",
		],
		[
			"more than 60 minutes clear",
			"2026-10-10T13:59:00.000Z",
			"2026-10-10T14:59:00.000Z",
			"CLEAR",
		],
	])("classifies proximity when event %s", (_name, start, end, expected) => {
		expect(
			classifyProximity(
				new Date("2026-10-10T16:00:00.000Z"),
				new Date("2026-10-10T17:00:00.000Z"),
				{ start: new Date(start), end: new Date(end) },
			),
		).toBe(expected);
	});

	it("rejects Europe/Madrid DST gaps and folds", () => {
		const now = new Date("2026-01-01T12:00:00.000Z");
		expect(
			resolveSpanishDate(
				{ day: 29, month: 3, year: 2026, hour: 2, minute: 30 },
				now,
				MADRID,
			),
		).toMatchObject({ ok: false });
		expect(
			resolveSpanishDate(
				{ day: 25, month: 10, year: 2026, hour: 2, minute: 30 },
				now,
				MADRID,
			),
		).toMatchObject({ ok: false });
	});

	it.each([
		["2026-03-29T00:00:00.000Z", "2026-03-30"],
		["2026-10-25T00:00:00.000Z", "2026-10-26"],
	])("increments civil local date through DST %s", (date, expected) => {
		expect(nextLocalDate(new Date(date), MADRID)).toBe(expected);
	});

	it.each([
		["CEST", "2026-04-10", "2026-04-09T22:00:00.000Z"],
		["CET", "2026-01-10", "2026-01-09T23:00:00.000Z"],
		["spring DST", "2026-03-29", "2026-03-28T23:00:00.000Z"],
		["fall DST", "2026-10-25", "2026-10-24T22:00:00.000Z"],
	])(
		"converts %s date-only calendar boundaries to local midnight",
		(_name, date, expected) => {
			expect(civilMidnight(date, MADRID)?.toISOString()).toBe(expected);
		},
	);

	it("builds all-day intervals at local civil boundaries", () => {
		const interval = calendarInterval(
			{ date: "2026-03-29" },
			{ date: "2026-03-30" },
			MADRID,
		);
		expect(interval?.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
		expect(interval?.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
	});

	it("makes an all-day event overlap local 00:30", () => {
		const interval = calendarInterval(
			{ date: "2026-04-10" },
			{ date: "2026-04-11" },
			MADRID,
		);
		if (!interval) throw new Error("all-day interval expected");
		expect(
			classifyProximity(
				new Date("2026-04-09T22:30:00.000Z"),
				new Date("2026-04-09T23:30:00.000Z"),
				interval,
			),
		).toBe("OVERLAP");
	});

	it("resolves wall times in America/Mexico_City", () => {
		const result = resolveSpanishDate(
			{ day: 15, month: 6, year: 2026, hour: 10, minute: 0 },
			new Date("2026-06-01T12:00:00.000Z"),
			MEXICO,
		);
		expect(result.ok && formatLocal(result.value.start, MEXICO)).toBe(
			"15/6/26, 10:00",
		);
		expect(civilMidnight("2026-06-15", MEXICO)?.toISOString()).toBe(
			"2026-06-15T06:00:00.000Z",
		);
	});
});
