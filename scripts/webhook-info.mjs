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
console.log(
	JSON.stringify({
		configured: Boolean(result.result?.url),
		pendingUpdateCount: result.result?.pending_update_count ?? 0,
	}),
);
