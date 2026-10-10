import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					ALLOWED_TELEGRAM_USERS_JSON: '{"100":"Alex","200":"Sam"}',
					GOOGLE_CALENDAR_ID: "test-calendar@example.com",
					GOOGLE_CLIENT_ID: "test-client",
					GOOGLE_CLIENT_SECRET: "test-secret",
					GOOGLE_TOKEN_ENCRYPTION_KEY:
						"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
					GEMINI_API_KEY: "test-gemini-key",
					OAUTH_SETUP_ADMIN_TOKEN: "test-admin-token",
					TELEGRAM_BOT_TOKEN: "test-telegram-token",
					TELEGRAM_WEBHOOK_SECRET: "0123456789abcdef",
					WORKER_BASE_URL: "https://example.test",
					TEST_MIGRATIONS: await readD1Migrations(
						path.join(import.meta.dirname, "migrations"),
					),
				},
			},
		})),
	],
});
