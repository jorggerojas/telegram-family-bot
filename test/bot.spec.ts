import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config/config";
import { createBot } from "../src/features/telegram/bot";
import type {
	CalendarEvent,
	GoogleCalendar,
} from "../src/features/calendar/google-calendar";
import type { Repository } from "../src/shared/database";

const config = readConfig({
	ALLOWED_TELEGRAM_USERS_JSON: '{"100":"Alex","200":"Sam"}',
	GOOGLE_CALENDAR_ID: "familia@example.com",
	GOOGLE_CLIENT_ID: "client",
	GOOGLE_CLIENT_SECRET: "secret",
	GOOGLE_TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
	GEMINI_API_KEY: "key",
	OAUTH_SETUP_ADMIN_TOKEN: "admin",
	TELEGRAM_BOT_TOKEN: "bot",
	TELEGRAM_WEBHOOK_SECRET: "0123456789abcdef",
	WORKER_BASE_URL: "https://example.com",
});

interface StoredAction {
	id: string;
	owner_id: string;
	chat_id: string;
	kind: string;
	payload: string;
	status: string;
	event_id: string | null;
	expires_at: number;
	fence_token: string;
}

const event = {
	id: "event1",
	etag: "etag1",
	summary: "Dentista",
	description: "Existing description",
	location: "Clínica",
	start: { dateTime: "2030-10-10T16:00:00.000Z" },
	end: { dateTime: "2030-10-10T17:00:00.000Z" },
};

const interpretation = (overrides: Record<string, unknown> = {}) => ({
	intent: "CREATE_EVENT",
	title: "Cita con dentista de Alex",
	location: null,
	search: null,
	day: 10,
	month: 10,
	year: 2030,
	weekday: null,
	hour: 18,
	minute: 0,
	duration_minutes: null,
	all_day: false,
	missing: [],
	fields: ["title", "date", "time"],
	...overrides,
});

const messageUpdate = (id: number, text: string, user = 100) => ({
	update_id: id,
	message: {
		message_id: id,
		date: 0,
		chat: {
			id: user,
			type: "private" as const,
			first_name: user === 100 ? "Alex" : "Sam",
		},
		from: {
			id: user,
			is_bot: false,
			first_name: user === 100 ? "Alex" : "Sam",
		},
		text,
	},
});

const callbackUpdate = (id: number, data: string, user = 100) => ({
	update_id: id,
	callback_query: {
		id: `callback${id}`,
		from: {
			id: user,
			is_bot: false,
			first_name: user === 100 ? "Alex" : "Sam",
		},
		chat_instance: "chat",
		data,
		message: {
			message_id: id,
			date: 0,
			chat: { id: user, type: "private" as const, first_name: "Alex" },
		},
	},
});

const fixedNow = new Date("2026-10-09T12:00:00.000Z");

const setup = (
	ai: Record<string, unknown> | Record<string, unknown>[] = interpretation(),
	events: CalendarEvent[] = [event],
	now = fixedNow,
) => {
	const actions = new Map<string, StoredAction>();
	const conversations = new Map<string, string>();
	const aiResponses = Array.isArray(ai) ? [...ai] : [ai];
	let next = 0;
	let claims = 0;
	const repository = {
		getConversation: async (owner: string, chat: string) =>
			conversations.get(`${owner}:${chat}`) ?? null,
		saveConversation: async (owner: string, chat: string, draft: string) => {
			conversations.set(`${owner}:${chat}`, draft);
		},
		cancelConversation: async (owner: string, chat: string) => {
			conversations.delete(`${owner}:${chat}`);
		},
		createAction: async (
			owner: string,
			chat: string,
			kind: string,
			payload: string,
		) => {
			const id = (++next).toString(16).padStart(32, "0");
			actions.set(id, {
				id,
				owner_id: owner,
				chat_id: chat,
				kind,
				payload,
				status: "pending",
				event_id: null,
				expires_at: now.getTime() + 15 * 60_000,
				fence_token: "",
			});
			return id;
		},
		getAction: async (id: string, owner: string, chat: string) => {
			const action = actions.get(id);
			return action?.owner_id === owner && action.chat_id === chat
				? action
				: null;
		},
		claimAction: async (
			id: string,
			owner: string,
			chat: string,
			kind: string,
			current: number,
		) => {
			const action = actions.get(id);
			if (
				!action ||
				action.owner_id !== owner ||
				action.chat_id !== chat ||
				action.kind !== kind ||
				(action.status !== "pending" && action.status !== "uncertain") ||
				action.expires_at < current
			)
				return null;
			claims += 1;
			action.status = "executing";
			action.fence_token = `f${claims}`;
			return action;
		},
		finishAction: async (id: string, eventId: string | null, token: string) => {
			const action = actions.get(id);
			if (action?.status !== "executing" || action.fence_token !== token)
				return false;
			action.status = "done";
			action.event_id = eventId;
			return true;
		},
		markActionUncertain: async (id: string, token: string) => {
			const action = actions.get(id);
			if (action?.status !== "executing" || action.fence_token !== token)
				return false;
			action.status = "uncertain";
			return true;
		},
		cancelAction: async (
			id: string,
			owner: string,
			chat: string,
			current: number,
		) => {
			const action = actions.get(id);
			if (
				!action ||
				action.owner_id !== owner ||
				action.chat_id !== chat ||
				action.status !== "pending" ||
				action.expires_at < current
			)
				return false;
			action.status = "done";
			return true;
		},
		getLatestPendingAction: async (
			owner: string,
			chat: string,
			kinds: string[],
			current: number,
		) => {
			const matches = [...actions.values()]
				.filter(
					(action) =>
						action.owner_id === owner &&
						action.chat_id === chat &&
						action.status === "pending" &&
						action.expires_at >= current &&
						kinds.includes(action.kind),
				)
				.sort((left, right) => right.expires_at - left.expires_at);
			return matches[0] ?? null;
		},
		updatePendingActionPayload: async (
			id: string,
			owner: string,
			chat: string,
			payload: string,
			current: number,
		) => {
			const action = actions.get(id);
			if (
				!action ||
				action.owner_id !== owner ||
				action.chat_id !== chat ||
				action.status !== "pending" ||
				action.expires_at < current
			)
				return false;
			action.payload = payload;
			action.expires_at = current + 15 * 60_000;
			return true;
		},
	} as unknown as Repository;
	let inserts = 0;
	let insertedEventId = "";
	let patches = 0;
	let deletes = 0;
	let aiCalls = 0;
	const calendar = {
		nearbyBusy: async () => events.filter((item) => item.id !== "event1"),
		insert: async (id: string) => {
			inserts += 1;
			insertedEventId = id;
			return { ...event, id: "saved" };
		},
		patch: async (_id: string, _etag: string, mutation: typeof event) => {
			patches += 1;
			return { ...event, ...mutation };
		},
		delete: async () => {
			deletes += 1;
		},
		isConnected: async () => true,
		list: async () => events,
		get: async (id: string) => events.find((item) => item.id === id) ?? null,
	} as unknown as GoogleCalendar;
	const sent: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		if (String(input).includes("generativelanguage.googleapis.com")) {
			aiCalls += 1;
			return Response.json({
				candidates: [
					{
						finishReason: "STOP",
						content: {
							parts: [{ text: JSON.stringify(aiResponses.shift() ?? ai) }],
						},
					},
				],
			});
		}
		if (init?.body) sent.push(String(init.body));
		return Response.json({
			ok: true,
			result: { message_id: 1, date: 0, chat: { id: 100, type: "private" } },
		});
	};
	const restore = () => {
		globalThis.fetch = originalFetch;
	};
	return {
		actions,
		conversations,
		calendar,
		aiCalls: () => aiCalls,
		claims: () => claims,
		counts: () => ({ inserts, patches, deletes }),
		insertedEventId: () => insertedEventId,
		create: () => createBot(config, repository, calendar, () => new Date(now)),
		restore,
		sent,
	};
};

describe("Telegram confirmation workflow", () => {
	it("does not send commands or callbacks to AI", async () => {
		const test = setup();
		try {
			const bot = test.create();
			await bot.init();
			const command = messageUpdate(1, "/help");
			await bot.handleUpdate({
				...command,
				message: {
					...command.message,
					entities: [{ offset: 0, length: 5, type: "bot_command" as const }],
				},
			});
			expect(test.aiCalls()).toBe(0);
			await bot.handleUpdate(
				messageUpdate(2, "dentista 10 de octubre de 2030 a las18"),
			);
			const id = [...test.actions.keys()][0];
			await bot.handleUpdate(callbackUpdate(3, `c:${id}`));
			expect(test.aiCalls()).toBe(1);
		} finally {
			test.restore();
		}
	});

	it("does not persist malformed structured AI output", async () => {
		const test = setup({ intent: "CREATE_EVENT" });
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "dentista mañana a las18"));
			expect(test.actions.size).toBe(0);
			expect(test.counts()).toEqual({ inserts: 0, patches: 0, deletes: 0 });
		} finally {
			test.restore();
		}
	});

	it("asks whether to create or search when AI cannot identify intent", async () => {
		const test = setup(interpretation({ intent: "CLARIFICATION" }));
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "autoescuela el martes"));
			expect(test.sent.join("\n")).toContain(
				"¿Quieres crear un evento o buscar uno existente?",
			);
			expect(test.actions.size).toBe(0);
		} finally {
			test.restore();
		}
	});

	it("uses explicit owner evidence even when AI supplies a generic title", async () => {
		const test = setup(interpretation({ title: "dentista" }));
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(
				messageUpdate(1, "dentista de Sam el 10 de octubre de 2030 a las18"),
			);
			const action = [...test.actions.values()][0];
			expect(action?.owner_id).toBe("100");
			expect(action?.payload).toContain("Cita con dentista de Sam");
			expect(test.counts().inserts).toBe(0);
			expect(test.sent.join("\n")).toContain("Preparado:");
		} finally {
			test.restore();
		}
	});

	it("creates no calendar event until its owner confirms callback", async () => {
		const test = setup();
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "dentista sábado"));
			expect(test.counts().inserts).toBe(0);
			const id = [...test.actions.keys()][0];
			await bot.handleUpdate(callbackUpdate(2, `c:${id}`));
			expect(test.counts().inserts).toBe(1);
			expect(test.insertedEventId()).toBe(id);
			expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
		} finally {
			test.restore();
		}
	});

	it("cancels only the owner's pending action and rejects invalid callback verbs", async () => {
		const test = setup();
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "dentista sábado"));
			const id = [...test.actions.keys()][0];
			await bot.handleUpdate(callbackUpdate(2, `s:${id}`));
			expect(test.claims()).toBe(0);
			await bot.handleUpdate(callbackUpdate(3, `x:${id}`, 200));
			expect(test.actions.get(id)?.status).toBe("pending");
			await bot.handleUpdate(callbackUpdate(4, `x:${id}`));
			await bot.handleUpdate(callbackUpdate(5, `c:${id}`));
			expect(test.counts().inserts).toBe(0);
		} finally {
			test.restore();
		}
	});

	it("does not execute an expired unconfirmed callback", async () => {
		const test = setup();
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "dentista sábado"));
			const id = [...test.actions.keys()][0];
			const action = test.actions.get(id);
			if (!action) throw new Error("action expected");
			action.expires_at = fixedNow.getTime() - 1;
			await bot.handleUpdate(callbackUpdate(2, `c:${id}`));
			expect(test.counts().inserts).toBe(0);
			expect(test.claims()).toBe(0);
		} finally {
			test.restore();
		}
	});

	it("stores direct update proposal before confirmation with Madrid wall time and duration", async () => {
		const test = setup(
			interpretation({
				intent: "UPDATE_EVENT",
				title: null,
				search: "dentista",
				day: null,
				month: null,
				year: null,
				hour: 19,
				minute: 0,
				fields: ["time"],
			}),
		);
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "cámbialo a las 19"));
			const preview = test.sent.join("\n");
			expect(preview).toContain("Antes: Dentista — 10/10/30, 18:00");
			expect(preview).toContain("Propuesto: Dentista — 10/10/30, 19:00");
			const action = [...test.actions.values()].find(
				(item) => item.kind === "update",
			);
			expect(action?.payload).toContain("2030-10-10T17:00:00.000Z");
			expect(action?.payload).toContain("Existing description");
			expect(action?.payload).toContain("Clínica");
			expect(test.counts().patches).toBe(0);
		} finally {
			test.restore();
		}
	});

	it("selection creates a delete confirmation without deleting first", async () => {
		const other = { ...event, id: "event2", summary: "Dentista Sam" };
		const test = setup(
			interpretation({
				intent: "DELETE_EVENT",
				title: null,
				search: "dentista",
			}),
			[event, other],
		);
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "borra dentista"));
			const selected = [...test.actions.values()][0];
			await bot.handleUpdate(callbackUpdate(2, `s:${selected.id}`));
			expect(test.counts().deletes).toBe(0);
			const confirmation = [...test.actions.values()].find(
				(item) => item.kind === "delete" && item.status === "pending",
			);
			expect(confirmation).toBeDefined();
			if (!confirmation) throw new Error("confirmation expected");
			await bot.handleUpdate(callbackUpdate(3, `c:${confirmation.id}`));
			expect(test.counts().deletes).toBe(1);
		} finally {
			test.restore();
		}
	});

	it("shows proximity override but excludes the event being moved", async () => {
		const nearby = {
			...event,
			id: "event2",
			summary: "Recogida",
			start: { dateTime: "2030-10-10T18:00:00.000Z" },
			end: { dateTime: "2030-10-10T18:30:00.000Z" },
		};
		const test = setup(
			interpretation({
				intent: "UPDATE_EVENT",
				title: null,
				search: "dentista",
				day: null,
				month: null,
				year: null,
				hour: 19,
				minute: 0,
				fields: ["time"],
			}),
			[event, nearby],
		);
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "cámbialo a las 19"));
			const preview = test.sent.join("\n");
			expect(preview).toContain("Está cerca de Recogida");
			expect(preview).toContain("Guardar cambio igualmente");
			expect(preview).not.toContain("Está cerca de Dentista");
		} finally {
			test.restore();
		}
	});

	it("renders all-day update previews without midnight clock labels", async () => {
		const allDay = {
			id: "event1",
			etag: "etag1",
			summary: "Colegio",
			start: { date: "2030-10-10" },
			end: { date: "2030-10-11" },
		};
		const test = setup(
			interpretation({
				intent: "UPDATE_EVENT",
				title: null,
				search: "colegio",
				day: 12,
				month: 10,
				year: 2030,
				hour: null,
				minute: null,
				all_day: true,
				fields: ["date"],
			}),
			[allDay],
		);
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "mueve colegio al 12"));
			const preview = test.sent.join("\n");
			expect(preview).toContain("todo el día 10/10/30");
			expect(preview).toContain("todo el día 12/10/30");
			expect(preview).not.toContain("00:00");
		} finally {
			test.restore();
		}
	});

	it("preserves an original draft through repeated time clarification", async () => {
		const incomplete = interpretation({
			title: null,
			day: null,
			month: null,
			year: null,
			hour: null,
			minute: null,
			missing: ["date", "time", "title"],
		});
		const test = setup([incomplete, incomplete, incomplete]);
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "dentista 10 de octubre"));
			await bot.handleUpdate(messageUpdate(2, "a las cinco"));
			await bot.handleUpdate(messageUpdate(3, "a las18"));
			expect(test.sent.join("\n")).toContain("Preparado");
			const action = [...test.actions.values()][0];
			expect(action?.kind).toBe("create");
			expect(action?.payload).toContain("Cita con dentista de Alex");
			expect(action?.payload).toContain("2026-10-10T16:00:00.000Z");
			expect(test.conversations.get("100:100")).toBeUndefined();
		} finally {
			test.restore();
		}
	});

	it("uses fixed Madrid clock and normalizes Sam's explicit dentist appointment", async () => {
		const test = setup(interpretation({ title: "dentista" }));
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(
				messageUpdate(1, "dentista sábado 10 de octubre a las18", 200),
			);
			expect(test.sent.join("\n")).toContain("Preparado:");
			const action = [...test.actions.values()][0];
			expect(action?.owner_id).toBe("200");
			expect(action?.payload).toContain("Cita con dentista de Sam");
			expect(action?.payload).toContain("2026-10-10T16:00:00.000Z");
			expect(test.sent.join("\n")).toContain(
				"Preparado: Cita con dentista de Sam, 10/10/26, 18:00 (60 min)",
			);
			expect(test.sent.join("\n")).not.toContain("¿");
			expect(test.counts()).toEqual({ inserts: 0, patches: 0, deletes: 0 });
		} finally {
			test.restore();
		}
	});

	it.each([
		["spring gap", 29, 3, "2026-03-30"],
		["autumn fold", 25, 10, "2026-10-26"],
	])(
		"uses next civil Madrid date for all-day %s",
		async (_name, day, month, end) => {
			const test = setup(
				interpretation({
					title: "Colegio",
					day,
					month,
					year: 2026,
					hour: null,
					minute: null,
					all_day: true,
					fields: ["title", "date"],
				}),
				[event],
				new Date("2026-01-01T12:00:00.000Z"),
			);
			try {
				const bot = test.create();
				await bot.init();
				await bot.handleUpdate(messageUpdate(1, "colegio todo el día"));
				const action = [...test.actions.values()][0];
				expect(action?.payload).toContain(`"end":{"date":"${end}"}`);
			} finally {
				test.restore();
			}
		},
	);

	it("selects the requested update before mutating and previews old and proposed dates", async () => {
		const old = { ...event, id: "old", summary: "Dentista Alex" };
		const selected = {
			...event,
			id: "ana",
			summary: "Dentista Sam",
			start: { dateTime: "2030-10-12T16:00:00.000Z" },
			end: { dateTime: "2030-10-12T17:00:00.000Z" },
		};
		const nearby = {
			...event,
			id: "nearby",
			summary: "Recogida",
			start: { dateTime: "2030-10-14T17:30:00.000Z" },
			end: { dateTime: "2030-10-14T18:00:00.000Z" },
		};
		const test = setup(
			interpretation({
				intent: "UPDATE_EVENT",
				title: null,
				search: "dentista",
				day: 14,
				month: 10,
				year: 2030,
				hour: 19,
				minute: 0,
				fields: ["date", "time"],
			}),
			[old, selected, nearby],
		);
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "cambia dentista al 14 a las19"));
			const selection = [...test.actions.values()].find(
				(action) =>
					action.kind === "select" && action.payload.includes('"ana"'),
			);
			if (!selection) throw new Error("selection expected");
			await bot.handleUpdate(callbackUpdate(2, `s:${selection.id}`));
			expect(test.counts().patches).toBe(0);
			expect(test.sent.join("\n")).toContain(
				"Antes: Dentista Sam — 12/10/30, 18:00",
			);
			expect(test.sent.join("\n")).toContain(
				"Propuesto: Cita con dentista de Alex — 14/10/30, 19:00",
			);
			expect(test.sent.join("\n")).toContain("Se solapa con Recogida");
			const confirmation = [...test.actions.values()].find(
				(action) => action.kind === "update" && action.status === "pending",
			);
			if (!confirmation) throw new Error("confirmation expected");
			await bot.handleUpdate(callbackUpdate(3, `c:${confirmation.id}`));
			expect(test.counts().patches).toBe(1);
		} finally {
			test.restore();
		}
	});

	it("reclaims an uncertain create without a second calendar mutation", async () => {
		const test = setup();
		let remoteMutations = 0;
		let written = false;
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "dentista sábado"));
			const id = [...test.actions.keys()][0];
			test.calendar.insert = async () => {
				if (written) return { ...event, id: "saved" };
				written = true;
				remoteMutations += 1;
				throw new Error("response lost after write");
			};
			await bot.handleUpdate(callbackUpdate(2, `c:${id}`));
			expect(test.actions.get(id)?.status).toBe("uncertain");
			await bot.handleUpdate(callbackUpdate(3, `c:${id}`));
			expect(test.actions.get(id)?.status).toBe("done");
			expect(remoteMutations).toBe(1);
		} finally {
			test.restore();
		}
	});

	it("reclaims an uncertain patch without a second calendar mutation", async () => {
		const test = setup();
		const id = "b".repeat(32);
		let remoteMutations = 0;
		let written = false;
		test.actions.set(id, {
			id,
			owner_id: "100",
			chat_id: "100",
			kind: "update",
			payload: JSON.stringify({
				eventId: event.id,
				etag: event.etag,
				event: { summary: "Nuevo", start: event.start, end: event.end },
			}),
			status: "pending",
			event_id: null,
			expires_at: fixedNow.getTime() + 60_000,
			fence_token: "",
		});
		test.calendar.patch = async () => {
			if (written) return { ...event, summary: "Nuevo" };
			written = true;
			remoteMutations += 1;
			throw new Error("response lost after patch");
		};
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(callbackUpdate(1, `c:${id}`));
			expect(test.actions.get(id)?.status).toBe("uncertain");
			await bot.handleUpdate(callbackUpdate(2, `c:${id}`));
			expect(test.actions.get(id)?.status).toBe("done");
			expect(remoteMutations).toBe(1);
		} finally {
			test.restore();
		}
	});

	it("reclaims an uncertain delete when a repeated delete finds no event", async () => {
		const test = setup();
		const id = "c".repeat(32);
		let remoteMutations = 0;
		let deleted = false;
		test.actions.set(id, {
			id,
			owner_id: "100",
			chat_id: "100",
			kind: "delete",
			payload: JSON.stringify({ eventId: event.id, etag: event.etag }),
			status: "pending",
			event_id: null,
			expires_at: fixedNow.getTime() + 60_000,
			fence_token: "",
		});
		test.calendar.delete = async () => {
			if (deleted) return;
			deleted = true;
			remoteMutations += 1;
			throw new Error("response lost after delete");
		};
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(callbackUpdate(1, `c:${id}`));
			expect(test.actions.get(id)?.status).toBe("uncertain");
			await bot.handleUpdate(callbackUpdate(2, `c:${id}`));
			expect(test.actions.get(id)?.status).toBe("done");
			expect(remoteMutations).toBe(1);
		} finally {
			test.restore();
		}
	});

	it("revises a pending overlapping create with muévelo instead of searching calendar", async () => {
		const overlapping = {
			...event,
			id: "ortodoncia",
			summary: "Ortodoncia jorge",
			start: { dateTime: "2026-10-21T17:00:00.000Z" },
			end: { dateTime: "2026-10-21T18:00:00.000Z" },
		};
		const test = setup(
			[
				interpretation({
					title: "test",
					day: 21,
					month: 10,
					year: 2026,
					weekday: "martes",
					hour: 19,
					minute: 0,
				}),
				interpretation({
					intent: "UPDATE_EVENT",
					title: null,
					search: null,
					day: 22,
					month: 10,
					year: 2026,
					weekday: null,
					hour: null,
					minute: null,
					fields: ["date"],
				}),
			],
			[overlapping],
			new Date("2026-10-12T18:00:00.000Z"),
		);
		test.calendar.nearbyBusy = async () => [overlapping];
		let listed = 0;
		test.calendar.list = async () => {
			listed += 1;
			return [overlapping];
		};
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "test para el 21 a las 19"));
			expect(test.sent.join("\n")).toContain("Se solapa con Ortodoncia jorge");
			expect(test.sent.join("\n")).toContain(
				"Avisos: 10 min, 1 h, 2 h y 1 día antes.",
			);
			const createId = [...test.actions.keys()][0];
			expect(createId).toBeDefined();
			await bot.handleUpdate(messageUpdate(2, "muévelo para el 22"));
			expect(listed).toBe(0);
			expect(test.sent.join("\n")).not.toContain(
				"He encontrado varios eventos",
			);
			expect(test.sent.join("\n")).toContain("22/10/26, 19:00");
			const revised = test.actions.get(createId as string);
			expect(revised?.kind).toBe("create");
			expect(revised?.status).toBe("pending");
			expect(revised?.payload).toContain("2026-10-22T17:00:00.000Z");
			expect(revised?.payload).toContain('"minutes":10');
			expect(revised?.payload).toContain('"minutes":1440');
		} finally {
			test.restore();
		}
	});

	it("asks for month when a bare past day lacks a month", async () => {
		const test = setup(
			interpretation({
				title: "Cita",
				day: 10,
				month: null,
				year: null,
				hour: 19,
				minute: 0,
			}),
			[event],
			new Date("2026-10-12T18:00:00.000Z"),
		);
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "cita para el 10 a las 19"));
			expect(test.sent.join("\n")).toContain("¿De qué mes?");
			expect(test.actions.size).toBe(0);
		} finally {
			test.restore();
		}
	});

	it("finds free gaps around all-day busy time while ignoring cancelled events", async () => {
		const test = setup(
			interpretation({ intent: "CHECK_AVAILABILITY", duration_minutes: 60 }),
			[
				{
					...event,
					id: "cancelled",
					status: "cancelled",
					start: { dateTime: "2026-10-09T12:00:00.000Z" },
					end: { dateTime: "2026-10-16T12:00:00.000Z" },
				},
				{
					...event,
					id: "all-day",
					start: { date: "2026-10-10" },
					end: { date: "2026-10-11" },
				},
			],
		);
		try {
			const bot = test.create();
			await bot.init();
			await bot.handleUpdate(messageUpdate(1, "¿hay hueco?"));
			expect(test.sent.join("\n")).toContain(
				"Huecos reales de al menos 60 min",
			);
		} finally {
			test.restore();
		}
	});

	it.each([
		[
			"CEST",
			"2026-04-10",
			"2026-04-11",
			"2026-04-09T22:00:00.000Z",
			"10/4/26, 0:00–10/4/26, 2:00",
			"11/4/26, 0:00",
		],
		[
			"CET",
			"2026-01-10",
			"2026-01-11",
			"2026-01-09T23:00:00.000Z",
			"10/1/26, 0:00–10/1/26, 1:00",
			"11/1/26, 0:00",
		],
		[
			"spring DST",
			"2026-03-29",
			"2026-03-30",
			"2026-03-28T23:00:00.000Z",
			"29/3/26, 0:00–29/3/26, 1:00",
			"30/3/26, 0:00",
		],
		[
			"fall DST",
			"2026-10-25",
			"2026-10-26",
			"2026-10-24T22:00:00.000Z",
			"25/10/26, 0:00–25/10/26, 2:00",
			"26/10/26, 0:00",
		],
	])(
		"emits availability only after Madrid all-day end during %s",
		async (_name, date, end, now, wrongGap, endBoundary) => {
			const test = setup(
				interpretation({ intent: "CHECK_AVAILABILITY", duration_minutes: 60 }),
				[
					{
						...event,
						id: "all-day",
						start: { date },
						end: { date: end },
					},
				],
				new Date(now),
			);
			try {
				const bot = test.create();
				await bot.init();
				await bot.handleUpdate(messageUpdate(1, "¿hay hueco?"));
				expect(test.sent.join("\\n")).not.toContain(wrongGap);
				expect(test.sent.join("\\n")).toContain(endBoundary);
			} finally {
				test.restore();
			}
		},
	);
});
