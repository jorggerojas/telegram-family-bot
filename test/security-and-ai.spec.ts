import { describe, expect, it } from "vitest";
import { configurationDiagnostics, readConfig } from "../src/config/config";
import { decryptSecret, encryptSecret } from "../src/features/auth/crypto";
import { interpretMessage } from "../src/features/ai/interpret";

const baseConfig = {
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
};
const aiProviders = {
	groqApiKey: null,
	geminiApiKey: "key",
	geminiModel: "model",
};

describe("private integration boundaries", () => {
	it("requires exactly Alex and Sam numeric allowlist IDs", () => {
		expect(readConfig(baseConfig).allowedUsers.get("100")).toBe("Alex");
		expect(
			readConfig({ ...baseConfig, GROQ_API_KEY: "" }).groqApiKey,
		).toBeNull();
		expect(() =>
			readConfig({
				...baseConfig,
				ALLOWED_TELEGRAM_USERS_JSON: '{"name":"Alex"}',
			}),
		).toThrow();
		expect(() =>
			readConfig({
				...baseConfig,
				ALLOWED_TELEGRAM_USERS_JSON: '{"100":"Alex","200":"Alex"}',
			}),
		).toThrow();
	});

	it("reports malformed configuration without parsing or exposing values", () => {
		expect(
			configurationDiagnostics({
				...baseConfig,
				ALLOWED_TELEGRAM_USERS_JSON: "{not-json",
			}),
		).toContain("ALLOWED_TELEGRAM_USERS_JSON");
		expect(
			configurationDiagnostics({
				...baseConfig,
				GOOGLE_TOKEN_ENCRYPTION_KEY: "not-a-32-byte-key",
			}),
		).toContain("GOOGLE_TOKEN_ENCRYPTION_KEY");
	});

	it("encrypts refresh tokens without retaining plaintext", async () => {
		const encrypted = await encryptSecret(
			"refresh-token",
			baseConfig.GOOGLE_TOKEN_ENCRYPTION_KEY,
		);
		expect(encrypted).not.toContain("refresh-token");
		expect(
			await decryptSecret(encrypted, baseConfig.GOOGLE_TOKEN_ENCRYPTION_KEY),
		).toBe("refresh-token");
		await expect(
			decryptSecret(`${encrypted}x`, baseConfig.GOOGLE_TOKEN_ENCRYPTION_KEY),
		).rejects.toThrow();
	});

	it("accepts structured Gemini output and safely rejects API failures", async () => {
		const complete = {
			intent: "CREATE_EVENT",
			title: "Cita con dentista de Sam",
			location: null,
			search: null,
			day: 10,
			month: 10,
			year: 2026,
			weekday: "sabado",
			hour: 18,
			minute: 0,
			duration_minutes: null,
			all_day: false,
			missing: [],
			fields: ["title", "date", "time"],
		};
		const goodFetch: typeof fetch = async (input, init) => {
			expect(String(input)).toContain("models/model:generateContent");
			expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("key");
			const body = JSON.parse(String(init?.body));
			expect(body.generationConfig.responseMimeType).toBe("application/json");
			expect(
				body.generationConfig.responseSchema.properties.year,
			).toMatchObject({
				minimum: 2020,
				maximum: 2100,
			});
			expect(
				body.generationConfig.responseSchema.properties.weekday.enum,
			).toContain("sábado");
			return Response.json({
				candidates: [
					{
						finishReason: "STOP",
						content: { parts: [{ text: JSON.stringify(complete) }] },
					},
				],
			});
		};
		const input = {
			message: "dentista sábado 10 de octubre a las 18",
			sender: "Sam",
			nowMadrid: "09/10/26, 14:00",
			previousDraft: null,
		};
		expect(
			(await interpretMessage(input, aiProviders, goodFetch))?.intent,
		).toBe("CREATE_EVENT");
		const failedFetch: typeof fetch = async () =>
			new Response("no", { status: 429 });
		expect(await interpretMessage(input, aiProviders, failedFetch)).toBeNull();
	});

	it("uses Groq first and falls back to Gemini on provider failure", async () => {
		const input = {
			message: "dentista mañana a las 18",
			sender: "Sam",
			nowMadrid: "09/10/26, 14:00",
			previousDraft: null,
		};
		const result = {
			intent: "CREATE_EVENT",
			title: "Cita con dentista de Sam",
			location: null,
			search: null,
			day: 10,
			month: 10,
			year: 2026,
			weekday: "sabado",
			hour: 18,
			minute: 0,
			duration_minutes: null,
			all_day: false,
			missing: [],
			fields: ["title", "date", "time"],
		};
		const calls: string[] = [];
		const groqFetch: typeof fetch = async (input, init) => {
			calls.push(String(input));
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer groq-key",
			);
			const body = JSON.parse(String(init?.body));
			expect(body.model).toBe("openai/gpt-oss-20b");
			expect(body.response_format).toEqual({ type: "json_object" });
			return Response.json({
				choices: [{ message: { content: JSON.stringify(result) } }],
			});
		};
		expect(
			await interpretMessage(
				input,
				{ ...aiProviders, groqApiKey: "groq-key" },
				groqFetch,
			),
		).toMatchObject({ intent: "CREATE_EVENT" });
		expect(calls).toHaveLength(1);
		calls.length = 0;
		const fetcher: typeof fetch = async (input) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("api.groq.com"))
				return new Response("payment required", { status: 402 });
			return Response.json({
				candidates: [
					{
						finishReason: "STOP",
						content: { parts: [{ text: JSON.stringify(result) }] },
					},
				],
			});
		};
		expect(
			await interpretMessage(
				input,
				{ ...aiProviders, groqApiKey: "groq-key" },
				fetcher,
			),
		).toMatchObject({ intent: "CREATE_EVENT" });
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("api.groq.com/openai/v1/chat/completions");
		expect(calls[1]).toContain("generativelanguage.googleapis.com");
	});

	it("rejects incomplete, refusal, and schema-invalid structured output", async () => {
		const input = {
			message: "dentista mañana a las18",
			sender: "Sam",
			nowMadrid: "09/10/26, 14:00",
			previousDraft: null,
		};
		const responses = [
			{
				candidates: [
					{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } },
				],
			},
			{
				candidates: [
					{ finishReason: "SAFETY", content: { parts: [{ text: "{}" }] } },
				],
			},
			{
				candidates: [
					{
						finishReason: "STOP",
						content: {
							parts: [{ text: JSON.stringify({ intent: "CREATE_EVENT" }) }],
						},
					},
				],
			},
		];
		for (const response of responses) {
			expect(
				await interpretMessage(input, aiProviders, async () =>
					Response.json(response),
				),
			).toBeNull();
		}
	});
});
