import { describe, expect, it } from "vitest";
import { normalizeInterpretation } from "../src/features/ai/normalization";
import type { Interpretation } from "../src/features/ai/interpret";

const draft = (overrides: Partial<Interpretation> = {}): Interpretation => ({
	intent: "CREATE_EVENT",
	title: "Dentista",
	location: null,
	search: null,
	day: null,
	month: null,
	year: null,
	weekday: null,
	hour: null,
	minute: null,
	duration_minutes: null,
	all_day: false,
	missing: [],
	fields: ["title", "date", "time"],
	...overrides,
});

describe("deterministic Spanish interpretation normalization", () => {
	it.each([
		[
			"dentista sábado 10 de octubre a las 18",
			10,
			10,
			18,
			"Cita con dentista de Sam",
		],
		["médico mañana 11", 10, 10, 11, "Cita médica de Sam"],
		["peluquería ocho de la tarde mañana", 10, 10, 20, "Peluquería de Sam"],
	])(
		"preserves explicit components from %s",
		(message, day, month, hour, title) => {
			const value = normalizeInterpretation(
				draft({ day: 1, month: 1, hour: 9, title: "Evento" }),
				message,
				"Sam",
				new Date("2026-10-09T12:00:00.000Z"),
			);
			expect(value).toMatchObject({ day, month, year: 2026, hour, title });
		},
	);

	it("does not silently choose an ambiguous named hour", () => {
		const value = normalizeInterpretation(
			draft({ hour: 17, minute: 0 }),
			"dentista mañana a las cinco",
			"Alex",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value.missing).toContain("time");
		expect(value.hour).toBeNull();
	});

	it("resolves named Spanish hours only when AM or PM is explicit", () => {
		const value = normalizeInterpretation(
			draft({ hour: null, minute: null }),
			"dentista mañana a las cinco de la tarde",
			"Alex",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value).toMatchObject({ hour: 17, minute: 0, missing: [] });
	});

	it.each([
		["7.45", 7, 45],
		["7:45", 7, 45],
		["7.45am", 7, 45],
		["7:45am", 7, 45],
		["7.45pm", 19, 45],
		["7:45pm", 19, 45],
	])("normalizes numeric clock format %s", (clock, hour, minute) => {
		const value = normalizeInterpretation(
			draft({ hour: null, minute: null }),
			`dentista mañana ${clock}`,
			"Alex",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value).toMatchObject({ hour, minute, missing: [] });
	});

	it("keeps a generic model title without inventing an owner", () => {
		const value = normalizeInterpretation(
			draft({ title: "Cena", hour: 20 }),
			"cena mañana a las20",
			"Sam",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value.title).toBe("Cena");
	});

	it("keeps original explicit evidence when a clarification supplies compact time", () => {
		const value = normalizeInterpretation(
			draft({
				title: null,
				day: null,
				month: null,
				year: null,
				hour: null,
				minute: null,
				missing: ["date", "time", "title"],
			}),
			"a las18",
			"Sam",
			new Date("2026-10-09T12:00:00.000Z"),
			"dentista sábado 10 de octubre",
		);
		expect(value).toMatchObject({
			title: "Cita con dentista de Sam",
			day: 10,
			month: 10,
			year: 2026,
			hour: 18,
			minute: 0,
			missing: [],
		});
	});

	it("preserves an explicit clock time in a natural update request", () => {
		const value = normalizeInterpretation(
			draft({ intent: "UPDATE_EVENT", hour: null, minute: null }),
			"cambia hora dentista 19:00",
			"Alex",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value).toMatchObject({
			title: "Cita con dentista de Alex",
			hour: 19,
			minute: 0,
		});
	});

	it("chooses the next bare weekday instead of trusting a model date", () => {
		const value = normalizeInterpretation(
			draft({ day: 10, month: 10, year: 2030, hour: 18 }),
			"dentista sábado",
			"Alex",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value).toMatchObject({
			day: 10,
			month: 10,
			year: 2026,
			weekday: null,
		});
	});

	it.each([
		["pasado mañana", 11, 10],
		["el próximo viernes", 16, 10],
		["este sábado", 10, 10],
		["dentro de dos semanas", 23, 10],
		["el último viernes del mes", 30, 10],
	])("anchors relative date %s in Madrid", (message, day, month) => {
		const value = normalizeInterpretation(
			draft(),
			message,
			"Alex",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value).toMatchObject({ day, month, year: 2026 });
	});
});
