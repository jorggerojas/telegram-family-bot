import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("worker health route", () => {
	it("returns safe configuration diagnostics without secret values", async () => {
		const context = createExecutionContext();
		const invalidEnv = {
			...env,
			GOOGLE_CLIENT_SECRET: "",
		};
		const response = await worker.fetch(
			new IncomingRequest("https://example.com/health"),
			invalidEnv,
			context,
		);
		await waitOnExecutionContext(context);
		expect(response.status).toBe(200);
		const body = await response.json<{ ok: boolean; diagnostics: string[] }>();
		expect(body.ok).toBe(false);
		expect(body.diagnostics).toContain("GOOGLE_CLIENT_SECRET");
		expect(body.diagnostics.join(",")).not.toContain("test-secret");
	});
});
