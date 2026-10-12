import {
	applyD1Migrations,
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/features/auth/crypto";
import worker from "../src/index";

type TestEnv = typeof env & {
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const secret = "0123456789abcdef";

const statusUpdate = (
	updateId: number,
	userId = 100,
	chatType = "private",
) => ({
	update_id: updateId,
	message: {
		message_id: updateId,
		date: 0,
		chat: { id: userId, type: chatType },
		from: { id: userId, is_bot: false, first_name: "Family" },
		text: "/status",
		entities: [{ offset: 0, length: 7, type: "bot_command" }],
	},
});

const callbackUpdate = (
	updateId: number,
	actionId: string,
	userId = 200,
	verb = "c",
) => ({
	update_id: updateId,
	callback_query: {
		id: `callback-${updateId}`,
		from: { id: userId, is_bot: false, first_name: "Sam" },
		chat_instance: "chat",
		data: `${verb}:${actionId}`,
		message: {
			message_id: updateId,
			date: 0,
			chat: { id: userId, type: "private" },
		},
	},
});

const request = async (
	body: unknown,
	headers: HeadersInit = {},
): Promise<Response> => {
	const context = createExecutionContext();
	const response = await worker.fetch(
		new Request("https://example.test/webhooks/telegram", {
			method: "POST",
			headers,
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
		env,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
};

const telegram = (): ReturnType<typeof vi.fn<typeof fetch>> =>
	vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url.endsWith("/getMe"))
			return Response.json({
				ok: true,
				result: {
					id: 1,
					is_bot: true,
					first_name: "Family",
					username: "family",
				},
			});
		if (url.includes("api.telegram.org"))
			return Response.json({
				ok: true,
				result: { message_id: 1, date: 0, chat: { id: 100, type: "private" } },
			});
		throw new Error(`Unexpected external request: ${url}`);
	});

describe("Telegram webhook Worker boundary", () => {
	beforeEach(async () => {
		await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
		await env.DB.prepare(
			"DELETE FROM processed_updates; DELETE FROM pending_actions; DELETE FROM conversations;",
		).run();
	});

	afterEach(() => vi.unstubAllGlobals());

	it("rejects invalid secrets and malformed or oversized payloads before bot work", async () => {
		const fetcher = telegram();
		vi.stubGlobal("fetch", fetcher);
		expect((await request(statusUpdate(1))).status).toBe(404);
		expect(
			(
				await request(statusUpdate(2), {
					"x-telegram-bot-api-secret-token": "wrong",
				})
			).status,
		).toBe(404);
		expect(
			(
				await request("{bad", {
					"x-telegram-bot-api-secret-token": secret,
				})
			).status,
		).toBe(400);
		expect(
			(
				await request(statusUpdate(3), {
					"x-telegram-bot-api-secret-token": secret,
					"content-length": "512001",
				})
			).status,
		).toBe(400);
		expect(
			(
				await request(
					JSON.stringify({ update_id: 4, padding: "😀".repeat(200_000) }),
					{ "x-telegram-bot-api-secret-token": secret },
				)
			).status,
		).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS count FROM processed_updates",
			).first(),
		).toEqual({ count: 0 });
	});

	it("accepts private allowlisted commands without Gemini or Calendar requests", async () => {
		const fetcher = telegram();
		vi.stubGlobal("fetch", fetcher);
		for (const update of [statusUpdate(10, 100), statusUpdate(11, 200)])
			expect(
				await request(update, { "x-telegram-bot-api-secret-token": secret }),
			).toHaveProperty("status", 200);
		expect(
			fetcher.mock.calls.some(([input]) =>
				/(openai|googleapis)/.test(String(input)),
			),
		).toBe(false);
	});

	it("does not send unknown or group updates to Gemini or Calendar", async () => {
		const fetcher = telegram();
		vi.stubGlobal("fetch", fetcher);
		for (const update of [
			statusUpdate(20, 999),
			statusUpdate(21, 100, "group"),
			statusUpdate(22, 100, "channel"),
		])
			expect(
				await request(update, { "x-telegram-bot-api-secret-token": secret }),
			).toHaveProperty("status", 200);
		expect(
			fetcher.mock.calls.some(([input]) =>
				/(openai|googleapis)/.test(String(input)),
			),
		).toBe(false);
	});

	it("keeps failed refresh details private and returns a safe Spanish command response", async () => {
		const encrypted = await encryptSecret(
			"refresh-token",
			"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
		);
		await env.DB.prepare(
			"INSERT INTO google_credentials(account, encrypted_refresh_token, updated_at) VALUES ('family', ?, ?)",
		)
			.bind(encrypted, Date.now())
			.run();
		const messages: string[] = [];
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/getMe"))
				return Response.json({
					ok: true,
					result: {
						id: 1,
						is_bot: true,
						first_name: "Family",
						username: "family",
					},
				});
			if (url.includes("oauth2.googleapis.com"))
				return new Response("refresh-token server failure", { status: 400 });
			if (url.includes("api.telegram.org")) {
				messages.push(String(init?.body));
				return Response.json({
					ok: true,
					result: {
						message_id: 1,
						date: 0,
						chat: { id: 100, type: "private" },
					},
				});
			}
			throw new Error(`Unexpected external request: ${url}`);
		});
		vi.stubGlobal("fetch", fetcher);
		const update = statusUpdate(25);
		update.message.text = "/today";
		update.message.entities[0].length = 6;
		expect(
			await request(update, { "x-telegram-bot-api-secret-token": secret }),
		).toHaveProperty("status", 200);
		expect(messages.join("\n")).toContain(
			"No puedo consultar el calendario ahora",
		);
		expect(messages.join("\n")).not.toContain("refresh-token");
		expect(messages.join("\n")).not.toContain("test-secret");
		expect(
			await env.DB.prepare(
				"SELECT encrypted_refresh_token FROM google_credentials",
			).first(),
		).toEqual({ encrypted_refresh_token: encrypted });
		expect(
			fetcher.mock.calls.some(([input]) =>
				String(input).includes("generativelanguage.googleapis.com"),
			),
		).toBe(false);
	});

	it("deduplicates completed updates and fences a retry after failed processing", async () => {
		const fetcher = telegram();
		vi.stubGlobal("fetch", fetcher);
		const headers = { "x-telegram-bot-api-secret-token": secret };
		expect((await request(statusUpdate(30), headers)).status).toBe(200);
		const completedCalls = fetcher.mock.calls.length;
		expect((await request(statusUpdate(30), headers)).status).toBe(200);
		expect(fetcher).toHaveBeenCalledTimes(completedCalls);

		vi.stubGlobal("fetch", async () =>
			Response.json(
				{
					ok: false,
					error_code: 400,
					description: "telegram rejected request",
				},
				{ status: 400 },
			),
		);
		expect((await request(statusUpdate(31), headers)).status).toBe(503);
		const failed = await env.DB.prepare(
			"SELECT status, fence_token FROM processed_updates WHERE update_id = 31",
		).first<{ status: string; fence_token: string }>();
		expect(failed?.status).toBe("processing");
		await env.DB.prepare(
			"UPDATE processed_updates SET lease_until = 0 WHERE update_id = 31",
		).run();
		const retryFetcher = telegram();
		vi.stubGlobal("fetch", retryFetcher);
		expect((await request(statusUpdate(31), headers)).status).toBe(200);
		const recovered = await env.DB.prepare(
			"SELECT status, fence_token FROM processed_updates WHERE update_id = 31",
		).first<{ status: string; fence_token: string }>();
		expect(recovered?.status).toBe("done");
		expect(recovered?.fence_token).not.toBe(failed?.fence_token);
	});

	it("blocks another allowed user from confirming an owner's pending action", async () => {
		const actionId = "a".repeat(32);
		const now = Date.now();
		await env.DB.prepare(
			"INSERT INTO pending_actions(id, owner_id, chat_id, kind, payload, status, expires_at, created_at) VALUES (?, ?, ?, 'create', ?, 'pending', ?, ?)",
		)
			.bind(
				actionId,
				"100",
				"100",
				JSON.stringify({ event: { summary: "Private" } }),
				now + 60_000,
				now,
			)
			.run();
		const fetcher = telegram();
		vi.stubGlobal("fetch", fetcher);
		expect(
			await request(callbackUpdate(40, actionId), {
				"x-telegram-bot-api-secret-token": secret,
			}),
		).toHaveProperty("status", 200);
		expect(
			await env.DB.prepare("SELECT status FROM pending_actions WHERE id = ?")
				.bind(actionId)
				.first(),
		).toEqual({ status: "pending" });
		expect(
			await request(callbackUpdate(41, actionId, 200, "x"), {
				"x-telegram-bot-api-secret-token": secret,
			}),
		).toHaveProperty("status", 200);
		expect(
			await env.DB.prepare("SELECT status FROM pending_actions WHERE id = ?")
				.bind(actionId)
				.first(),
		).toEqual({ status: "pending" });
	});
});
