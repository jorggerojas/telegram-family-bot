import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config/config";
import { encryptSecret } from "../src/features/auth/crypto";
import { GoogleCalendar } from "../src/features/calendar/google-calendar";
import { createBot } from "../src/features/telegram/bot";
import { Repository } from "../src/shared/database";

const now = 1_800_000_000_000;
type TestEnv = typeof env & {
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

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

const callbackUpdate = (id: number, data: string) => ({
	update_id: id,
	callback_query: {
		id: `callback${id}`,
		from: { id: 100, is_bot: false, first_name: "Alex" },
		chat_instance: "chat",
		data,
		message: {
			message_id: id,
			date: 0,
			chat: { id: 100, type: "private" as const, first_name: "Alex" },
		},
	},
});

describe("recovered calendar confirmations", () => {
	beforeEach(async () => {
		await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM pending_actions"),
			env.DB.prepare("DELETE FROM google_credentials"),
		]);
	});

	it.each(["create", "update", "delete"] as const)(
		"reconciles lost %s results through callback recovery without a duplicate mutation",
		async (kind) => {
			const repository = new Repository(env.DB);
			await repository.saveCredential(
				await encryptSecret("refresh-token", config.googleTokenEncryptionKey),
				now,
			);
			const mutation = {
				summary: "Dentista",
				start: { dateTime: "2027-01-10T16:00:00.000Z" },
				end: { dateTime: "2027-01-10T17:00:00.000Z" },
			};
			const payload =
				kind === "create"
					? { event: mutation }
					: kind === "update"
						? { eventId: "event1", etag: "etag1", event: mutation }
						: { eventId: "event1", etag: "etag1" };
			const id = await repository.createAction(
				"100",
				"100",
				kind,
				JSON.stringify(payload),
				now,
			);
			const firstClaim = await repository.claimAction(
				id,
				"100",
				"100",
				kind,
				now,
			);
			if (!firstClaim) throw new Error("initial claim expected");
			await repository.markActionUncertain(id, firstClaim.fence_token, now);

			let mutationRequests = 0;
			const googleFetcher: typeof fetch = async (input, init) => {
				const url = String(input);
				if (url.includes("oauth2.googleapis.com"))
					return Response.json({ access_token: "access", expires_in: 300 });
				if (
					init?.method === "POST" ||
					init?.method === "PATCH" ||
					init?.method === "DELETE"
				)
					mutationRequests += 1;
				if (kind === "delete") return new Response(null, { status: 410 });
				return Response.json({
					id: kind === "create" ? `family${id}` : "event1",
					etag: "etag1",
					...mutation,
					extendedProperties: { private: { family_action_id: id } },
				});
			};
			const calendar = new GoogleCalendar(config, repository, googleFetcher);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = async () =>
				Response.json({
					ok: true,
					result: { id: 1, is_bot: true, first_name: "Family" },
				});
			try {
				const bot = createBot(
					config,
					repository,
					calendar,
					() => new Date(now + 1),
				);
				await bot.init();
				await bot.handleUpdate(callbackUpdate(1, `c:${id}`));
				const completed = await repository.getAction(id, "100", "100");
				expect(completed).toMatchObject({
					status: "done",
					event_id: kind === "create" ? `family${id}` : "event1",
				});
				expect(completed?.fence_token).not.toBe(firstClaim.fence_token);
				expect(mutationRequests).toBe(0);
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	);
});
