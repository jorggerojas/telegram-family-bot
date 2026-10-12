import { z } from "zod";
import type { Update } from "grammy/types";
import { configurationDiagnostics, readConfig } from "./config/config";
import { finishOAuth, startOAuth } from "./features/auth/oauth";
import { GoogleCalendar } from "./features/calendar/google-calendar";
import { createBot } from "./features/telegram/bot";
import { Repository } from "./shared/database";

const updateSchema = z
	.object({ update_id: z.number().int().nonnegative() })
	.loose();
const MAX_WEBHOOK_BYTES = 512_000;

const parseUpdate = async (
	request: Request,
): Promise<{ update_id: number } | null> => {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (!Number.isFinite(contentLength) || contentLength > MAX_WEBHOOK_BYTES)
		return null;
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BYTES)
		return null;
	try {
		return updateSchema.safeParse(JSON.parse(body)).data ?? null;
	} catch {
		return null;
	}
};

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const rawEnv = env as unknown as Record<string, unknown>;
		const diagnostics = configurationDiagnostics(rawEnv);
		if (new URL(request.url).pathname === "/health")
			return Response.json({ ok: diagnostics.length === 0, diagnostics });
		if (diagnostics.length > 0)
			return new Response("Service unavailable", { status: 503 });
		const config = readConfig(rawEnv);
		const repository = new Repository(env.DB);
		const calendar = new GoogleCalendar(config, repository);
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/admin/oauth/start")
			return startOAuth(request, config, repository, calendar);
		if (request.method === "GET" && url.pathname === "/auth/google/callback")
			return finishOAuth(request, repository, calendar);
		if (request.method !== "POST" || url.pathname !== "/webhooks/telegram")
			return new Response("Not found", { status: 404 });
		if (
			request.headers.get("x-telegram-bot-api-secret-token") !==
			config.telegramWebhookSecret
		)
			return new Response("Not found", { status: 404 });
		const update = await parseUpdate(request);
		if (!update) return new Response("Bad request", { status: 400 });
		const claimed = await repository.claimUpdate(update.update_id, Date.now());
		if (claimed.status === "completed") return new Response("OK");
		if (claimed.status === "retry") {
			console.warn("Telegram update awaiting processing", {
				updateId: update.update_id,
			});
			return new Response("Retry", { status: 503 });
		}
		let stage = "bot.init";
		try {
			const bot = createBot(config, repository, calendar);
			await bot.init();
			stage = "bot.handleUpdate";
			await bot.handleUpdate(update as Update);
			stage = "completeUpdate";
			if (
				!(await repository.completeUpdate(
					update.update_id,
					claimed.fenceToken,
					Date.now(),
				))
			) {
				console.warn("Telegram update completion lost its lease", {
					updateId: update.update_id,
				});
				return new Response("Retry", { status: 503 });
			}
			stage = "cleanup";
			await repository.cleanup(Date.now());
			return new Response("OK");
		} catch (error) {
			const cause =
				error instanceof Error &&
				"error" in error &&
				typeof error.error === "object" &&
				error.error !== null
					? error.error
					: null;
			console.error("Telegram update processing failed", {
				updateId: update.update_id,
				stage,
				type: error instanceof Error ? error.constructor.name : "unknown",
				cause: cause instanceof Error ? cause.constructor.name : null,
				code:
					cause !== null &&
					"error_code" in cause &&
					typeof cause.error_code === "number"
						? cause.error_code
						: null,
			});
			return new Response("Retry", { status: 503 });
		}
	},
} satisfies ExportedHandler<Env>;
