import { describe, expect, it, vi } from "vitest";
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
	openaiApiKey: null,
	geminiApiKey: "key",
	geminiModel: "model",
};

describe("private integration boundaries", () => {
	it("accepts unique allowlisted member names", () => {
		expect(readConfig(baseConfig).allowedUsers.get("100")).toBe("Alex");
		expect(readConfig(baseConfig).defaultTimeZone).toBe("Europe/Madrid");
		expect(
			readConfig({ ...baseConfig, GROQ_API_KEY: "" }).groqApiKey,
		).toBeNull();
		expect(
			readConfig({ ...baseConfig, OPENAI_API_KEY: "  " }).openaiApiKey,
		).toBeNull();
		expect(
			readConfig({ ...baseConfig, OPENAI_API_KEY: "nv-key" }).openaiApiKey,
		).toBe("nv-key");
		expect(
			readConfig({
				...baseConfig,
				ALLOWED_TELEGRAM_USERS_JSON: '{"100":"Alex","200":"Sam","300":"Riley"}',
				DEFAULT_TIME_ZONE: "America/Mexico_City",
			}).allowedUsers.get("300"),
		).toBe("Riley");
		expect(
			readConfig({
				...baseConfig,
				DEFAULT_TIME_ZONE: "America/Mexico_City",
			}).defaultTimeZone,
		).toBe("America/Mexico_City");
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
		expect(() =>
			readConfig({
				...baseConfig,
				ALLOWED_TELEGRAM_USERS_JSON: "{}",
			}),
		).toThrow();
		expect(() =>
			readConfig({
				...baseConfig,
				DEFAULT_TIME_ZONE: "Not/AZone",
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
			nowLocal: "09/10/26, 14:00",
			previousDraft: null,
		};
		expect(
			(await interpretMessage(input, aiProviders, goodFetch))?.interpretation
				.intent,
		).toBe("CREATE_EVENT");
		const failedFetch: typeof fetch = async () =>
			new Response("no", { status: 429 });
		expect(await interpretMessage(input, aiProviders, failedFetch)).toBeNull();
	});

	it("uses Groq first and falls back to Gemini on provider failure", async () => {
		const input = {
			message: "dentista mañana a las 18",
			sender: "Sam",
			nowLocal: "09/10/26, 14:00",
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
			expect(body.response_format).toMatchObject({
				type: "json_schema",
				json_schema: { strict: true },
			});
			expect(body.messages[0].content).toContain("JSON object");
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
		).toMatchObject({
			interpretation: { intent: "CREATE_EVENT" },
			provider: "groq",
		});
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
		).toMatchObject({
			interpretation: { intent: "CREATE_EVENT" },
			provider: "gemini",
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("api.groq.com/openai/v1/chat/completions");
		expect(calls[1]).toContain("generativelanguage.googleapis.com");
	});

	it("uses NVIDIA after Groq and Gemini only after both fail", async () => {
		const input = {
			message: "dentista mañana a las 18",
			sender: "Sam",
			nowLocal: "09/10/26, 14:00",
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
		const fetcher: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("api.groq.com"))
				return new Response("rate limit", { status: 429 });
			if (url.includes("integrate.api.nvidia.com")) {
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer nv-key",
				);
				const body = JSON.parse(String(init?.body));
				expect(body.model).toBe("deepseek-ai/deepseek-v4.1-flash");
				expect(body.temperature).toBe(1);
				expect(body.top_p).toBe(0.95);
				expect(body.max_tokens).toBe(4096);
				expect(body.stream).toBe(false);
				expect(body.reasoning_effort).toBe("low");
				expect(body.response_format).toMatchObject({
					type: "json_schema",
					json_schema: { name: "calendar_interpretation", strict: true },
				});
				return Response.json({
					choices: [{ message: { content: JSON.stringify(result) } }],
				});
			}
			return new Response("gemini should not run", { status: 500 });
		};
		expect(
			await interpretMessage(
				input,
				{ ...aiProviders, groqApiKey: "groq-key", openaiApiKey: "nv-key" },
				fetcher,
			),
		).toMatchObject({
			interpretation: { intent: "CREATE_EVENT" },
			provider: "nvidia",
		});
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("integrate.api.nvidia.com/v1/chat/completions");

		calls.length = 0;
		const exhausted: typeof fetch = async (input) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("generativelanguage.googleapis.com")) {
				return Response.json({
					candidates: [
						{
							finishReason: "STOP",
							content: { parts: [{ text: JSON.stringify(result) }] },
						},
					],
				});
			}
			return new Response("unavailable", { status: 429 });
		};
		expect(
			await interpretMessage(
				input,
				{ ...aiProviders, groqApiKey: "groq-key", openaiApiKey: "nv-key" },
				exhausted,
			),
		).toMatchObject({
			interpretation: { intent: "CREATE_EVENT" },
			provider: "gemini",
		});
		expect(calls).toHaveLength(3);
		expect(calls[0]).toContain("api.groq.com");
		expect(calls[1]).toContain("integrate.api.nvidia.com");
		expect(calls[2]).toContain("generativelanguage.googleapis.com");
	});

	it("logs Groq HTTP status without exposing provider error contents", async () => {
		const logger = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await interpretMessage(
				{
					message: "private message",
					sender: "Sam",
					nowLocal: "10/10/26, 03:24",
					previousDraft: null,
				},
				{ ...aiProviders, groqApiKey: "private-key" },
				async (url) =>
					String(url).includes("api.groq.com")
						? Response.json(
								{ error: { message: "private-key private message" } },
								{ status: 401 },
							)
						: new Response("unavailable", { status: 503 }),
			);
			expect(logger).toHaveBeenCalledWith("Groq request error", {
				type: "AuthenticationError",
				status: 401,
				cause: null,
			});
			expect(JSON.stringify(logger.mock.calls)).not.toContain("private");
		} finally {
			logger.mockRestore();
		}
	});

	it("rejects incomplete, refusal, and schema-invalid structured output", async () => {
		const input = {
			message: "dentista mañana a las18",
			sender: "Sam",
			nowLocal: "09/10/26, 14:00",
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
