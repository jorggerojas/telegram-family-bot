import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("worker health route", () => {
	it("returns only ok without leaking configuration diagnostics", async () => {
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
		const body = await response.json<{ ok: boolean; diagnostics?: string[] }>();
		expect(body.ok).toBe(false);
		expect(body.diagnostics).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("GOOGLE_CLIENT_SECRET");
		expect(JSON.stringify(body)).not.toContain("test-secret");
	});
});
