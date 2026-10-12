import { localEnv } from "./env.mjs";

const env = await localEnv();
if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing Telegram bot token.");
const response = await fetch(
	`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`,
);
if (!response.ok)
	throw new Error("Telegram webhook information request failed.");
const result = await response.json();
if (!result.ok)
	throw new Error("Telegram rejected webhook information request.");
const info = result.result ?? {};
console.log(
	JSON.stringify({
		configured: Boolean(info.url),
		pendingUpdateCount: info.pending_update_count ?? 0,
		lastErrorMessage: info.last_error_message ?? null,
		lastErrorAt: info.last_error_date
			? new Date(info.last_error_date * 1000).toISOString()
			: null,
	}),
);
