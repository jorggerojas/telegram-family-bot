import { describe, expect, it, vi } from "vitest";
import { discoverTelegramIds } from "../scripts/telegram-ids.mjs";

describe("Telegram ID setup script", () => {
	it("reads only unique matching private message IDs without acknowledging updates", async () => {
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/getWebhookInfo"))
				return Response.json({ ok: true, result: { url: "" } });
			if (url.endsWith("/getUpdates"))
				return Response.json({
					ok: true,
					result: [
						{
							message: {
								chat: { id: 101, type: "private" },
								from: { id: 101 },
							},
						},
						{
							message: {
								chat: { id: 101, type: "private" },
								from: { id: 101 },
							},
						},
						{
							message: {
								chat: { id: 202, type: "private" },
								from: { id: 303 },
							},
						},
						{
							message: {
								chat: { id: -404, type: "group" },
								from: { id: 404 },
							},
						},
					],
				});
			throw new Error(`Unexpected request: ${url} ${String(init?.body)}`);
		});

		await expect(
			discoverTelegramIds({ token: "test-token", fetch: fetcher }),
		).resolves.toEqual(["101"]);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/getWebhookInfo$/);
		expect(String(fetcher.mock.calls[1]?.[0])).toMatch(/\/getUpdates$/);
		expect(String(fetcher.mock.calls[1]?.[1]?.body)).toBe(
			'{"limit":20,"timeout":0,"allowed_updates":["message"]}',
		);
	});

	it("refuses a configured webhook before reading updates", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ ok: true, result: { url: "https://example.test/hook" } }),
		);

		await expect(
			discoverTelegramIds({ token: "test-token", fetch: fetcher }),
		).rejects.toThrow("requires no configured webhook");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
