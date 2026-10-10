import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config/config";
import { encryptSecret } from "../src/features/auth/crypto";
import { GoogleCalendar } from "../src/features/calendar/google-calendar";
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

const repository = {
	getCredential: async () => null,
	saveCredential: async () => undefined,
} as unknown as Repository;

const event = {
	id: "event1",
	etag: "etag1",
	summary: "Dentista",
	description: "Existing description",
	start: { dateTime: "2026-10-10T16:00:00.000Z" },
	end: { dateTime: "2026-10-10T17:00:00.000Z" },
	extendedProperties: { private: { legacy: "keep" } },
};

const connectedCalendar = async (
	responses: Response[],
): Promise<GoogleCalendar> => {
	const fetcher: typeof fetch = async () => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected request");
		return response;
	};
	const calendar = new GoogleCalendar(config, repository, fetcher);
	await calendar.exchangeCode("code", Date.now());
	return calendar;
};

describe("Google Calendar adapter", () => {
	it("keeps transparent events in agendas but excludes them from busy scans", async () => {
		const calendar = await connectedCalendar([
			Response.json({ access_token: "token", refresh_token: "refresh" }),
			Response.json({ id: config.calendarId, accessRole: "writer" }),
			Response.json({
				items: [
					{ ...event, transparency: "transparent" },
					{ ...event, id: "busy" },
				],
			}),
			Response.json({
				items: [
					{ ...event, transparency: "transparent" },
					{ ...event, id: "busy" },
				],
			}),
		]);
		const start = new Date("2026-10-10T16:00:00.000Z");
		const end = new Date("2026-10-10T17:00:00.000Z");
		expect((await calendar.list(start, end)).map((item) => item.id)).toEqual([
			"event1",
			"busy",
		]);
		expect(
			(await calendar.nearbyBusy(start, end)).map((item) => item.id),
		).toEqual(["busy"]);
	});

	it("queries and filters the exact one-hour nearby-busy boundary", async () => {
		let nearbyUrl = "";
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(String(input));
			if (url.hostname === "oauth2.googleapis.com")
				return Response.json({
					access_token: "token",
					refresh_token: "refresh",
				});
			if (url.pathname.includes("calendarList"))
				return Response.json({ id: config.calendarId, accessRole: "writer" });
			nearbyUrl = url.toString();
			return Response.json({
				items: [
					{
						...event,
						id: "ends-at-boundary",
						start: { dateTime: "2026-10-10T14:00:00.000Z" },
						end: { dateTime: "2026-10-10T15:00:00.000Z" },
					},
					{
						...event,
						id: "starts-at-boundary",
						start: { dateTime: "2026-10-10T18:00:00.000Z" },
						end: { dateTime: "2026-10-10T19:00:00.000Z" },
					},
					{
						...event,
						id: "ends-outside",
						start: { dateTime: "2026-10-10T13:59:00.000Z" },
						end: { dateTime: "2026-10-10T14:59:59.999Z" },
					},
					{
						...event,
						id: "starts-outside",
						start: { dateTime: "2026-10-10T18:00:00.001Z" },
						end: { dateTime: "2026-10-10T19:00:00.000Z" },
					},
				],
			});
		};
		const calendar = new GoogleCalendar(config, repository, fetcher);
		await calendar.exchangeCode("code", Date.now());
		expect(
			(
				await calendar.nearbyBusy(
					new Date("2026-10-10T16:00:00.000Z"),
					new Date("2026-10-10T17:00:00.000Z"),
				)
			).map((item) => item.id),
		).toEqual(["ends-at-boundary", "starts-at-boundary"]);
		const nearbyQuery = new URL(nearbyUrl).searchParams;
		expect(nearbyQuery.get("timeMin")).toBe("2026-10-10T14:59:59.999Z");
		expect(nearbyQuery.get("timeMax")).toBe("2026-10-10T18:00:00.001Z");
	});

	it("paginates agendas while retaining free events and excluding cancelled events", async () => {
		const calendar = await connectedCalendar([
			Response.json({ access_token: "token", refresh_token: "refresh" }),
			Response.json({ id: config.calendarId, accessRole: "writer" }),
			Response.json({
				items: [{ ...event, id: "first", transparency: "transparent" }],
				nextPageToken: "second",
			}),
			Response.json({
				items: [
					{ ...event, id: "cancelled", status: "cancelled" },
					{
						...event,
						id: "all-day",
						start: { date: "2026-10-11" },
						end: { date: "2026-10-12" },
					},
				],
			}),
		]);
		const events = await calendar.list(
			new Date("2026-10-10T00:00:00.000Z"),
			new Date("2026-10-12T00:00:00.000Z"),
		);
		expect(events.map((item) => item.id)).toEqual(["first", "all-day"]);
	});

	it("preserves unrelated description and private metadata on patch", async () => {
		let patchBody = "";
		const responses = [
			Response.json({ access_token: "token", refresh_token: "refresh" }),
			Response.json({ id: config.calendarId, accessRole: "owner" }),
			Response.json(event),
			new Response(JSON.stringify(event), { status: 200 }),
		];
		const fetcher: typeof fetch = async (_input, init) => {
			if (init?.method === "PATCH") patchBody = String(init.body);
			const response = responses.shift();
			if (!response) throw new Error("Unexpected request");
			return response;
		};
		const calendar = new GoogleCalendar(config, repository, fetcher);
		await calendar.exchangeCode("code", Date.now());
		await calendar.patch(
			event.id,
			"etag1",
			{ summary: "Nuevo título", start: event.start, end: event.end },
			"action1",
		);
		expect(patchBody).toContain("Existing description");
		expect(patchBody).toContain("legacy");
		expect(patchBody).toContain("family_action_id");
	});

	it("reconciles deterministic create after an uncertain response without a second post", async () => {
		const calendar = await connectedCalendar([
			Response.json({ access_token: "token", refresh_token: "refresh" }),
			Response.json({ id: config.calendarId, accessRole: "owner" }),
			Response.json({
				...event,
				id: "a1b2c3",
				extendedProperties: { private: { family_action_id: "action1" } },
			}),
		]);
		const existing = await calendar.insert(
			"a1b2c3",
			{
				summary: event.summary,
				description: event.description,
				location: undefined,
				start: event.start,
				end: event.end,
			},
			"action1",
			{ name: "Alex", telegramId: "100" },
		);
		expect(existing.id).toBe("a1b2c3");
	});

	it("reconciles a lost patch response by action marker without another patch", async () => {
		let patches = 0;
		const responses: Array<Response | Error> = [
			Response.json({ access_token: "token", refresh_token: "refresh" }),
			Response.json({ id: config.calendarId, accessRole: "owner" }),
			Response.json(event),
			new Error("timeout after write"),
			Response.json({
				...event,
				summary: "Nuevo título",
				extendedProperties: {
					private: { legacy: "keep", family_action_id: "action1" },
				},
			}),
		];
		const fetcher: typeof fetch = async (_input, init) => {
			if (init?.method === "PATCH") patches += 1;
			const response = responses.shift();
			if (!response) throw new Error("Unexpected request");
			if (response instanceof Error) throw response;
			return response;
		};
		const calendar = new GoogleCalendar(config, repository, fetcher);
		await calendar.exchangeCode("code", Date.now());
		const mutation = {
			summary: "Nuevo título",
			description: "Existing description",
			start: event.start,
			end: event.end,
		};
		await expect(
			calendar.patch(event.id, "etag1", mutation, "action1"),
		).rejects.toThrow("timeout");
		await calendar.patch(event.id, "etag1", mutation, "action1");
		expect(patches).toBe(1);
	});

	it("treats cancelled and gone deletes as already complete", async () => {
		const calendar = await connectedCalendar([
			Response.json({ access_token: "token", refresh_token: "refresh" }),
			Response.json({ id: config.calendarId, accessRole: "owner" }),
			Response.json(event),
			new Response(null, { status: 410 }),
		]);
		await expect(calendar.delete(event.id, "etag1")).resolves.toBeUndefined();
	});

	it("uses the native fetcher to refresh before Calendar access and does not call Calendar after a failed refresh", async () => {
		const encrypted = await encryptSecret(
			"refresh-token",
			config.googleTokenEncryptionKey,
		);
		const connectedRepository = {
			getCredential: async () => ({
				encrypted_refresh_token: encrypted,
				updated_at: Date.now(),
			}),
		} as unknown as Repository;
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetcher: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			if (String(input).includes("oauth2.googleapis.com")) {
				expect(String(init?.body)).toContain("grant_type=refresh_token");
				expect(String(init?.body)).toContain("refresh-token");
				return Response.json({ access_token: "fresh-access", expires_in: 300 });
			}
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer fresh-access",
			);
			return Response.json({ items: [] });
		};
		const calendar = new GoogleCalendar(config, connectedRepository, fetcher);
		await expect(
			calendar.list(new Date("2030-01-01"), new Date("2030-01-02")),
		).resolves.toEqual([]);
		expect(calls).toHaveLength(2);

		const failedCalls: string[] = [];
		const unavailable = new GoogleCalendar(
			config,
			connectedRepository,
			async (input) => {
				failedCalls.push(String(input));
				return new Response("refresh-token must stay private", { status: 400 });
			},
		);
		await expect(
			unavailable.list(new Date("2030-01-01"), new Date("2030-01-02")),
		).rejects.toThrow("Google Calendar needs reconnecting.");
		expect(failedCalls).toEqual(["https://oauth2.googleapis.com/token"]);
	});
});
