import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessageEntity } from "grammy/types";
import { readConfig } from "../src/config/config";
import { createBot } from "../src/features/telegram/bot";
import type { GoogleCalendar } from "../src/features/calendar/google-calendar";
import { Repository } from "../src/shared/database";

type TestEnv = typeof env & {
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const now = new Date("2026-10-09T12:00:00.000Z");
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

const incomplete = {
	intent: "CREATE_EVENT",
	title: null,
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
	missing: ["date", "time", "title"],
	fields: [],
};

const message = (id: number, text: string, user = 100) => ({
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
		entities: [] as MessageEntity[],
	},
});

describe("D1-backed clarification conversations", () => {
	beforeEach(async () => {
		await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
		await env.DB.prepare(
			"DELETE FROM conversations; DELETE FROM pending_actions;",
		).run();
	});

	it("keeps each raw draft until completion, expiry, or cancellation through bot calls", async () => {
		const repository = new Repository(env.DB);
		const calendar = {
			nearbyBusy: async () => [],
			isConnected: async () => true,
			list: async () => [],
		} as unknown as GoogleCalendar;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) =>
			String(input).includes("generativelanguage.googleapis.com")
				? Response.json({
						candidates: [
							{
								finishReason: "STOP",
								content: { parts: [{ text: JSON.stringify(incomplete) }] },
							},
						],
					})
				: Response.json({
						ok: true,
						result: { id: 1, is_bot: true, first_name: "Family" },
					});
		try {
			const bot = createBot(config, repository, calendar, () => new Date(now));
			await bot.init();
			await bot.handleUpdate(message(1, "dentista sábado 10 de octubre"));
			await bot.handleUpdate(message(2, "peluquería 11 de octubre", 200));
			expect(
				await repository.getConversation("100", "100", now.getTime()),
			).toBe("dentista sábado 10 de octubre");
			expect(
				await repository.getConversation("200", "200", now.getTime()),
			).toBe("peluquería 11 de octubre");
			await bot.handleUpdate(message(3, "a las17"));
			expect(
				await repository.getConversation("100", "100", now.getTime()),
			).toBeNull();
			const action = await env.DB.prepare(
				"SELECT payload FROM pending_actions WHERE owner_id = '100'",
			).first<{ payload: string }>();
			expect(action?.payload).toContain("Cita con dentista de Alex");
			expect(action?.payload).toContain("2026-10-10T15:00:00.000Z");
			await repository.saveConversation("300", "300", "expired", now.getTime());
			expect(
				await repository.getConversation(
					"300",
					"300",
					now.getTime() + 30 * 60_000 + 1,
				),
			).toBeNull();
			const cancel = message(4, "/cancel", 200);
			cancel.message.entities = [
				{ offset: 0, length: 7, type: "bot_command" as const },
			];
			await bot.handleUpdate(cancel);
			expect(
				await repository.getConversation("200", "200", now.getTime()),
			).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
