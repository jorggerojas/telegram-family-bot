import { pathToFileURL } from "node:url";

const telegramUrl = (token, method) =>
	`https://api.telegram.org/bot${token}/${method}`;

const isRecord = (value) => typeof value === "object" && value !== null;

const telegramRequest = async (fetcher, token, method, init) => {
	let response;
	try {
		response = await fetcher(telegramUrl(token, method), init);
	} catch {
		throw new Error("Telegram request failed.");
	}
	if (!response.ok) throw new Error("Telegram request failed.");

	let payload;
	try {
		payload = await response.json();
	} catch {
		throw new Error("Telegram request failed.");
	}
	if (!isRecord(payload) || payload.ok !== true)
		throw new Error("Telegram request failed.");
	return payload.result;
};

export const discoverTelegramIds = async ({ token, fetch: fetcher }) => {
	if (!token) throw new Error("Missing Telegram bot token.");
	const webhook = await telegramRequest(fetcher, token, "getWebhookInfo");
	if (isRecord(webhook) && typeof webhook.url === "string" && webhook.url) {
		throw new Error(
			"Telegram ID discovery requires no configured webhook. It made no changes. Keep the webhook configured and use Telegram Desktop personal data export instead.",
		);
	}

	const updates = await telegramRequest(fetcher, token, "getUpdates", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			limit: 20,
			timeout: 0,
			allowed_updates: ["message"],
		}),
	});
	if (!Array.isArray(updates)) throw new Error("Telegram request failed.");

	const ids = new Set();
	for (const update of updates) {
		if (!isRecord(update) || !isRecord(update.message)) continue;
		const { chat, from } = update.message;
		if (!isRecord(chat) || !isRecord(from) || chat.type !== "private") continue;
		if (
			typeof chat.id === "number" &&
			Number.isSafeInteger(chat.id) &&
			typeof from.id === "number" &&
			Number.isSafeInteger(from.id) &&
			chat.id === from.id
		) {
			ids.add(String(from.id));
		}
	}
	return [...ids];
};

const isDirectRun =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
	try {
		const { localEnv } = await import("./env.mjs");
		const ids = await discoverTelegramIds({
			token: (await localEnv()).TELEGRAM_BOT_TOKEN,
			fetch,
		});
		console.log(ids.join("\n"));
	} catch (error) {
		console.error(
			error instanceof Error &&
				error.message.startsWith("Telegram ID discovery")
				? error.message
				: "Telegram ID discovery failed.",
		);
		process.exitCode = 1;
	}
}
