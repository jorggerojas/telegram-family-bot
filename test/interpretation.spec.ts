import { describe, expect, it } from "vitest";
import { normalizeInterpretation } from "../src/features/ai/normalization";
import {
	interpretMessage,
	type Interpretation,
} from "../src/features/ai/interpret";

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
	it("requires only actual creation prerequisites despite model missing optional fields", () => {
		const value = normalizeInterpretation(
			draft({ missing: ["location", "search", "duration"] }),
			"dentista sábado 10 de octubre a las 18",
			"Alex",
			new Date("2026-10-10T01:32:00.000Z"),
		);
		expect(value).toMatchObject({
			title: "Cita con dentista de Alex",
			day: 10,
			month: 10,
			year: 2026,
			hour: 18,
			minute: 0,
			missing: [],
		});
	});

	it("requests Groq output matching the required interpretation schema", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const result = await interpretMessage(
			{
				message: "dentista sábado",
				sender: "Alex",
				nowMadrid: "2026-10-09T14:00:00+02:00",
				previousDraft: null,
			},
			{
				groqApiKey: "test-key",
				openaiApiKey: null,
				geminiApiKey: "unused",
				geminiModel: "unused",
			},
			async (_input, init) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return Response.json({
					id: "completion",
					object: "chat.completion",
					created: 0,
					model: "openai/gpt-oss-20b",
					choices: [
						{
							index: 0,
							finish_reason: "stop",
							message: {
								role: "assistant",
								content: JSON.stringify(draft()),
							},
						},
					],
				});
			},
		);

		expect(result).toEqual(draft());
		expect(requestBody?.response_format).toMatchObject({
			type: "json_schema",
			json_schema: {
				name: "calendar_interpretation",
				strict: true,
				schema: {
					type: "object",
					required: expect.arrayContaining([
						"intent",
						"location",
						"search",
						"duration_minutes",
						"all_day",
						"missing",
						"fields",
					]),
					additionalProperties: false,
				},
			},
		});
	});

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
		["hoy", 9, 10],
	])("anchors relative date %s in Madrid", (message, day, month) => {
		const value = normalizeInterpretation(
			draft(),
			message,
			"Alex",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value).toMatchObject({ day, month, year: 2026 });
	});

	it("drops model-only weekday when the user gives a numeric day and hour", () => {
		const value = normalizeInterpretation(
			draft({
				day: 22,
				month: 10,
				year: 2026,
				weekday: "viernes",
				hour: 19,
				minute: 0,
			}),
			"test para el 22 a las 19",
			"Alex",
			new Date("2026-10-12T18:00:00.000Z"),
		);
		expect(value).toMatchObject({
			day: 22,
			month: 10,
			year: 2026,
			hour: 19,
			weekday: null,
			missing: [],
		});
	});

	it("parses hoy and este mes without trusting a mismatched weekday", () => {
		const today = normalizeInterpretation(
			draft({ day: 12, month: 10, year: 2026, weekday: "martes", hour: 23 }),
			"crear dormir para hoy a las 23",
			"Alex",
			new Date("2026-10-12T18:00:00.000Z"),
		);
		expect(today).toMatchObject({
			day: 12,
			month: 10,
			year: 2026,
			hour: 23,
			weekday: null,
			missing: [],
		});
		const thisMonth = normalizeInterpretation(
			draft({ weekday: "lunes", hour: 19 }),
			"prueba maquillaje para el 22 de este mes a las 19",
			"Alex",
			new Date("2026-10-12T18:00:00.000Z"),
		);
		expect(thisMonth).toMatchObject({
			day: 22,
			month: 10,
			year: 2026,
			hour: 19,
			weekday: null,
			missing: [],
		});
	});

	it("asks for the month when a bare day has already passed this month", () => {
		const value = normalizeInterpretation(
			draft({ hour: 19, minute: 0 }),
			"cita para el 10 a las 19",
			"Alex",
			new Date("2026-10-12T18:00:00.000Z"),
		);
		expect(value.missing).toContain("month");
		expect(value.month).toBeNull();
	});

	it("treats para las as a clock time and drops an invented date", () => {
		const now = new Date("2026-10-12T18:51:00.000Z");
		const stillToday = normalizeInterpretation(
			draft({
				title: "dormir",
				day: 26,
				month: 10,
				year: 2026,
				hour: 23,
				minute: 0,
			}),
			"dormir para las 23",
			"Alex",
			now,
		);
		expect(stillToday).toMatchObject({
			title: "dormir",
			day: 12,
			month: 10,
			year: 2026,
			hour: 23,
			minute: 0,
			weekday: null,
			missing: [],
		});
		const tomorrow = normalizeInterpretation(
			draft({
				title: "dormir",
				day: 26,
				month: 10,
				year: 2026,
				hour: 8,
				minute: 0,
			}),
			"dormir para las 8",
			"Alex",
			now,
		);
		expect(tomorrow).toMatchObject({
			day: 13,
			month: 10,
			year: 2026,
			hour: 8,
			minute: 0,
			missing: [],
		});
		const drafted = normalizeInterpretation(
			draft({ title: "dormir", day: 26, month: 10, year: 2026, hour: 10 }),
			"para las 23",
			"Alex",
			now,
			"dormir el 20 de octubre",
		);
		expect(drafted).toMatchObject({
			day: 20,
			month: 10,
			year: 2026,
			hour: 23,
			minute: 0,
			missing: [],
		});
	});

	it("defaults a time-only create to today or tomorrow in Madrid", () => {
		const stillToday = normalizeInterpretation(
			draft({ day: null, month: null, year: null, hour: 23, minute: 0 }),
			"dormir a las 23",
			"Alex",
			new Date("2026-10-12T18:00:00.000Z"),
		);
		expect(stillToday).toMatchObject({
			day: 12,
			month: 10,
			year: 2026,
			hour: 23,
			missing: [],
		});
		const tomorrow = normalizeInterpretation(
			draft({ day: null, month: null, year: null, hour: 8, minute: 0 }),
			"café a las 8",
			"Alex",
			new Date("2026-10-12T18:00:00.000Z"),
		);
		expect(tomorrow).toMatchObject({
			day: 13,
			month: 10,
			year: 2026,
			hour: 8,
			missing: [],
		});
	});

	it("asks for the day when an explicit weekday contradicts the numeric date", () => {
		const value = normalizeInterpretation(
			draft({ hour: 18, minute: 0 }),
			"dentista lunes 10 de octubre a las 18",
			"Alex",
			new Date("2026-10-09T12:00:00.000Z"),
		);
		expect(value.missing).toContain("date");
		expect(value.weekday).toBeNull();
	});
});
