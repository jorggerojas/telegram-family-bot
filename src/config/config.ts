import { z } from "zod";

const PEOPLE = {
	Alex: "Alex",
	Sam: "Sam",
} as const;

export type FamilyMember = (typeof PEOPLE)[keyof typeof PEOPLE];

export interface AppConfig {
	allowedUsers: Map<string, FamilyMember>;
	calendarId: string;
	defaultDurationMinutes: number;
	defaultTimeZone: string;
	googleClientId: string;
	googleClientSecret: string;
	googleTokenEncryptionKey: string;
	groqApiKey: string | null;
	geminiApiKey: string;
	geminiModel: string;
	oauthSetupAdminToken: string;
	telegramBotToken: string;
	telegramWebhookSecret: string;
	workerBaseUrl: string;
}

const configSchema = z.object({
	ALLOWED_TELEGRAM_USERS_JSON: z.string().min(1),
	DEFAULT_EVENT_DURATION_MINUTES: z.coerce
		.number()
		.int()
		.min(5)
		.max(1440)
		.default(60),
	DEFAULT_TIME_ZONE: z
		.string()
		.default("Europe/Madrid")
		.refine((value) => value === "Europe/Madrid"),
	GOOGLE_CALENDAR_ID: z.string().min(1),
	GOOGLE_CLIENT_ID: z.string().min(1),
	GOOGLE_CLIENT_SECRET: z.string().min(1),
	GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().refine(
		(value) => {
			try {
				return atob(value).length === 32;
			} catch {
				return false;
			}
		},
		{ error: "Must be a 32-byte base64 key." },
	),
	GEMINI_API_KEY: z.string().min(1),
	GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash-lite"),
	GROQ_API_KEY: z
		.string()
		.optional()
		.transform((value) => value?.trim() || undefined),
	OAUTH_SETUP_ADMIN_TOKEN: z.string().min(1),
	TELEGRAM_BOT_TOKEN: z.string().min(1),
	TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
	WORKER_BASE_URL: z.url(),
});

const parseUsers = (value: string): Record<string, FamilyMember> | null => {
	try {
		const parsed: unknown = JSON.parse(value);
		const users = z
			.record(z.string().regex(/^\d+$/), z.enum([PEOPLE.Alex, PEOPLE.Sam]))
			.safeParse(parsed);
		if (
			!users.success ||
			Object.keys(users.data).length !== 2 ||
			new Set(Object.values(users.data)).size !== 2
		)
			return null;
		return users.data;
	} catch {
		return null;
	}
};

export const configurationDiagnostics = (
	env: Record<string, unknown>,
): string[] => {
	const result = configSchema.safeParse(env);
	const diagnostics = result.success
		? []
		: result.error.issues.map(
				(issue) => issue.path.join(".") || "configuration",
			);
	if (
		typeof env.ALLOWED_TELEGRAM_USERS_JSON === "string" &&
		!parseUsers(env.ALLOWED_TELEGRAM_USERS_JSON)
	)
		diagnostics.push("ALLOWED_TELEGRAM_USERS_JSON");
	return [...new Set(diagnostics)];
};

export const readConfig = (env: Record<string, unknown>): AppConfig => {
	const values = configSchema.parse(env);
	const users = parseUsers(values.ALLOWED_TELEGRAM_USERS_JSON);
	if (!users) {
		throw new Error(
			"ALLOWED_TELEGRAM_USERS_JSON must map exactly Alex and Sam to numeric IDs.",
		);
	}
	return {
		allowedUsers: new Map(Object.entries(users)),
		calendarId: values.GOOGLE_CALENDAR_ID,
		defaultDurationMinutes: values.DEFAULT_EVENT_DURATION_MINUTES,
		defaultTimeZone: values.DEFAULT_TIME_ZONE,
		googleClientId: values.GOOGLE_CLIENT_ID,
		googleClientSecret: values.GOOGLE_CLIENT_SECRET,
		googleTokenEncryptionKey: values.GOOGLE_TOKEN_ENCRYPTION_KEY,
		groqApiKey: values.GROQ_API_KEY ?? null,
		geminiApiKey: values.GEMINI_API_KEY,
		geminiModel: values.GEMINI_MODEL,
		oauthSetupAdminToken: values.OAUTH_SETUP_ADMIN_TOKEN,
		telegramBotToken: values.TELEGRAM_BOT_TOKEN,
		telegramWebhookSecret: values.TELEGRAM_WEBHOOK_SECRET,
		workerBaseUrl: values.WORKER_BASE_URL.replace(/\/$/, ""),
	};
};
