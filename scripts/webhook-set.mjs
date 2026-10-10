import { localEnv } from "./env.mjs";

const env = await localEnv();
if (
	!env.TELEGRAM_BOT_TOKEN ||
	!env.WORKER_BASE_URL ||
	!env.TELEGRAM_WEBHOOK_SECRET
) {
	throw new Error("Missing Telegram webhook configuration.");
}

const response = await fetch(
	`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
	{
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			url: `${env.WORKER_BASE_URL.replace(/\/$/, "")}/webhooks/telegram`,
			secret_token: env.TELEGRAM_WEBHOOK_SECRET,
			allowed_updates: ["message", "callback_query"],
		}),
	},
);
if (!response.ok) throw new Error("Telegram webhook request failed.");
const result = await response.json();
if (!result.ok) throw new Error("Telegram rejected webhook configuration.");
console.log("Webhook configured.");
