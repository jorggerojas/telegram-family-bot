import {
	applyD1Migrations,
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config/config";
import { decryptSecret, encryptSecret } from "../src/features/auth/crypto";
import { finishOAuth, startOAuth } from "../src/features/auth/oauth";
import type { GoogleCalendar } from "../src/features/calendar/google-calendar";
import worker from "../src/index";
import { Repository, sha256 } from "../src/shared/database";

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

type TestEnv = typeof env & {
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const request = async (
	path: string,
	init?: RequestInit<IncomingRequestCfProperties>,
): Promise<Response> => {
	const context = createExecutionContext();
	const response = await worker.fetch(
		new IncomingRequest(`https://example.test${path}`, init),
		env,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
};

const start = async (): Promise<string> => {
	const response = await request("/admin/oauth/start", {
		method: "POST",
		headers: { Authorization: "Bearer test-admin-token" },
	});
	expect(response.status).toBe(302);
	const state = new URL(
		response.headers.get("location") ?? "",
	).searchParams.get("state");
	if (!state) throw new Error("OAuth state expected");
	return state;
};

describe("OAuth state lifecycle", () => {
	beforeEach(async () => {
		await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
		await env.DB.prepare("DELETE FROM oauth_states").run();
		await env.DB.prepare("DELETE FROM google_credentials").run();
	});

	afterEach(() => vi.unstubAllGlobals());

	it("uses a D1-backed state once and rejects missing or replayed callbacks", async () => {
		let exchanges = 0;
		const calendar = {
			oauthUrl: (state: string) =>
				`https://accounts.example/authorize?state=${state}`,
			exchangeCode: async () => {
				exchanges += 1;
			},
		} as unknown as GoogleCalendar;
		const repository = new Repository(env.DB);
		const unauthorized = await startOAuth(
			new Request("https://example.com/admin/oauth/start"),
			config,
			repository,
			calendar,
		);
		expect(unauthorized.status).toBe(404);
		const started = await startOAuth(
			new Request("https://example.com/admin/oauth/start", {
				headers: { Authorization: "Bearer admin" },
			}),
			config,
			repository,
			calendar,
		);
		const state = new URL(
			started.headers.get("location") ?? "",
		).searchParams.get("state");
		expect(state).toBeTruthy();
		const callback = `https://example.com/auth/google/callback?code=code&state=${state}`;
		expect(
			(await finishOAuth(new Request(callback), repository, calendar)).status,
		).toBe(200);
		expect(exchanges).toBe(1);
		expect(
			(await finishOAuth(new Request(callback), repository, calendar)).status,
		).toBe(200);
		expect(exchanges).toBe(1);
		expect(
			(
				await finishOAuth(
					new Request("https://example.com/auth/google/callback?code=code"),
					repository,
					calendar,
				)
			).status,
		).toBe(200);
	});

	it("runs authorized start through Worker route and stores only a hashed expiring state", async () => {
		expect(
			(await request("/admin/oauth/start", { method: "POST" })).status,
		).toBe(404);
		expect(
			(
				await request("/admin/oauth/start", {
					method: "POST",
					headers: { Authorization: "Bearer wrong" },
				})
			).status,
		).toBe(404);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS count FROM oauth_states",
			).first(),
		).toEqual({ count: 0 });

		const before = Date.now();
		const state = await start();
		const location = new URL(
			(
				await request("/admin/oauth/start", {
					method: "POST",
					headers: { Authorization: "Bearer test-admin-token" },
				})
			).headers.get("location") ?? "",
		);
		expect(location.origin).toBe("https://accounts.google.com");
		expect(location.searchParams.get("access_type")).toBe("offline");
		const stateRow = await env.DB.prepare(
			"SELECT state_hash, expires_at FROM oauth_states WHERE state_hash = ?",
		)
			.bind(await sha256(state))
			.first<{ state_hash: string; expires_at: number }>();
		expect(stateRow?.state_hash).toBe(await sha256(state));
		expect(stateRow?.state_hash).not.toBe(state);
		expect(stateRow?.expires_at).toBeGreaterThanOrEqual(before + 10 * 60_000);
	});

	it("exchanges once, verifies writer access, and persists only encrypted refresh tokens", async () => {
		const state = await start();
		const code = "authorization-code";
		const refreshToken = "refresh-token";
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				expect(String(init?.body)).toContain(code);
				return Response.json({
					access_token: "access-token",
					refresh_token: refreshToken,
				});
			}
			expect(url).toContain("calendarList/test-calendar%40example.com");
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer access-token",
			);
			return Response.json({
				id: "test-calendar@example.com",
				accessRole: "writer",
			});
		});
		vi.stubGlobal("fetch", fetcher);

		const response = await request(
			`/auth/google/callback?code=${code}&state=${state}`,
		);
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain("Calendar connection completed");
		expect(body).not.toContain(code);
		expect(body).not.toContain(refreshToken);
		expect(fetcher).toHaveBeenCalledTimes(2);
		const credential = await new Repository(env.DB).getCredential();
		expect(credential?.encrypted_refresh_token).not.toContain(refreshToken);
		expect(
			await decryptSecret(
				credential?.encrypted_refresh_token ?? "",
				"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
			),
		).toBe(refreshToken);
	});

	it("consumes denied callbacks so they cannot be replayed with an authorization code", async () => {
		const state = await start();
		const denied = await request(
			`/auth/google/callback?error=access_denied&state=${state}`,
		);
		expect(await denied.text()).toContain("could not be completed");
		const fetcher = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetcher);
		const replay = await request(
			`/auth/google/callback?code=authorization-code&state=${state}`,
		);
		expect(await replay.text()).toContain("invalid or expired");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects expired and replayed states without exchanging tokens", async () => {
		const repository = new Repository(env.DB);
		await repository.saveOAuthState("expired", Date.now() - 10 * 60_000 - 1);
		const fetcher = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetcher);
		expect(
			await (
				await request("/auth/google/callback?code=code&state=expired")
			).text(),
		).toContain("invalid or expired");
		expect(
			await (
				await request("/auth/google/callback?code=code&state=unknown")
			).text(),
		).toContain("invalid or expired");
		expect(fetcher).not.toHaveBeenCalled();
		const state = await start();
		vi.stubGlobal("fetch", async () =>
			Response.json({ access_token: "access", refresh_token: "refresh" }),
		);
		await request(`/auth/google/callback?code=code&state=${state}`);
		expect(
			await (
				await request(`/auth/google/callback?code=code&state=${state}`)
			).text(),
		).toContain("invalid or expired");
	});

	it("preserves existing refresh credentials when Google omits a replacement and refuses invalid calendar access", async () => {
		const repository = new Repository(env.DB);
		await repository.saveCredential(
			await encryptSecret(
				"existing-refresh",
				"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
			),
			Date.now(),
		);
		const state = await start();
		vi.stubGlobal("fetch", async (input: RequestInfo) =>
			String(input).includes("oauth2.googleapis.com")
				? Response.json({ access_token: "access" })
				: Response.json({
						id: "test-calendar@example.com",
						accessRole: "writer",
					}),
		);
		await request(`/auth/google/callback?code=code&state=${state}`);
		expect(
			await decryptSecret(
				(await repository.getCredential())?.encrypted_refresh_token ?? "",
				"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
			),
		).toBe("existing-refresh");

		await env.DB.prepare("DELETE FROM google_credentials").run();
		const deniedState = await start();
		vi.stubGlobal("fetch", async (input: RequestInfo) =>
			String(input).includes("oauth2.googleapis.com")
				? Response.json({
						access_token: "access",
						refresh_token: "new-refresh",
					})
				: Response.json({
						id: "test-calendar@example.com",
						accessRole: "reader",
					}),
		);
		const denied = await request(
			`/auth/google/callback?code=secret-code&state=${deniedState}`,
		);
		expect(await denied.text()).not.toContain("secret-code");
		expect(await repository.getCredential()).toBeNull();

		const noRefreshState = await start();
		vi.stubGlobal("fetch", async () =>
			Response.json({ access_token: "access" }),
		);
		const noRefresh = await request(
			`/auth/google/callback?code=another-secret-code&state=${noRefreshState}`,
		);
		expect(await noRefresh.text()).toContain("could not be completed");
		expect(await repository.getCredential()).toBeNull();
	});
});
