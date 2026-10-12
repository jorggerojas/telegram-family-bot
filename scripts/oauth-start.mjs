import { localEnv } from "./env.mjs";

const env = await localEnv();
if (!env.WORKER_BASE_URL || !env.OAUTH_SETUP_ADMIN_TOKEN) {
	throw new Error(
		"Missing WORKER_BASE_URL or OAUTH_SETUP_ADMIN_TOKEN in .dev.vars.",
	);
}

const base = env.WORKER_BASE_URL.replace(/\/$/, "");
const response = await fetch(`${base}/admin/oauth/start`, {
	method: "POST",
	headers: { Authorization: `Bearer ${env.OAUTH_SETUP_ADMIN_TOKEN}` },
	redirect: "manual",
});

if (response.status === 404) {
	throw new Error(
		"OAuth start returned 404. OAUTH_SETUP_ADMIN_TOKEN in .dev.vars does not match the deployed Worker secret (or the Worker is down). Sync with: pnpm exec wrangler secret put OAUTH_SETUP_ADMIN_TOKEN",
	);
}
if (response.status !== 302) {
	throw new Error(
		`OAuth start failed with status ${response.status}. Check that the Worker is deployed.`,
	);
}

const location = response.headers.get("location");
if (!location) throw new Error("OAuth start returned no redirect URL.");
console.log(location);
console.log(
	"Open that URL in a browser, finish Google consent, then send /status in Telegram.",
);
