import { z } from "zod";
import type { AppConfig } from "../../config/config";
import { decryptSecret, encryptSecret } from "../auth/crypto";
import type { Repository } from "../../shared/database";
import { calendarInterval } from "../../shared/scheduling";

const calendarEventSchema = z.object({
	id: z.string(),
	etag: z.string().optional(),
	status: z.string().optional(),
	transparency: z.string().optional(),
	summary: z.string().optional(),
	description: z.string().optional(),
	location: z.string().optional(),
	recurrence: z.array(z.string()).optional(),
	start: z.object({
		dateTime: z.string().optional(),
		date: z.string().optional(),
		timeZone: z.string().optional(),
	}),
	end: z.object({
		dateTime: z.string().optional(),
		date: z.string().optional(),
		timeZone: z.string().optional(),
	}),
	extendedProperties: z
		.object({ private: z.record(z.string(), z.string()).optional() })
		.optional(),
});

const listSchema = z.object({
	items: z.array(calendarEventSchema).default([]),
	nextPageToken: z.string().optional(),
});
const calendarListSchema = z.object({
	id: z.string(),
	accessRole: z.enum(["freeBusyReader", "reader", "writer", "owner"]),
});
const tokenSchema = z.object({
	access_token: z.string(),
	expires_in: z.number().optional(),
	refresh_token: z.string().optional(),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export interface CalendarMutation {
	summary: string;
	description?: string;
	location?: string;
	start: CalendarEvent["start"];
	end: CalendarEvent["end"];
}

const sameMutation = (
	event: CalendarEvent,
	mutation: CalendarMutation,
): boolean =>
	event.summary === mutation.summary &&
	event.start.dateTime === mutation.start.dateTime &&
	event.start.date === mutation.start.date &&
	event.end.dateTime === mutation.end.dateTime &&
	event.end.date === mutation.end.date &&
	(mutation.description === undefined ||
		event.description === mutation.description) &&
	(mutation.location === undefined || event.location === mutation.location);

interface TokenCache {
	accessToken: string;
	expiresAt: number;
}

const calendarScopes = [
	"https://www.googleapis.com/auth/calendar.events",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

const fetchWithTimeout = async (
	input: RequestInfo,
	init: RequestInit,
	fetcher: typeof fetch,
): Promise<Response> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	try {
		return await fetcher(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
};

export class GoogleCalendar {
	private token: TokenCache | null = null;

	constructor(
		private readonly config: AppConfig,
		private readonly repository: Repository,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	oauthUrl(state: string): string {
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.searchParams.set("client_id", this.config.googleClientId);
		url.searchParams.set(
			"redirect_uri",
			`${this.config.workerBaseUrl}/auth/google/callback`,
		);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("access_type", "offline");
		url.searchParams.set("prompt", "consent");
		url.searchParams.set("scope", calendarScopes.join(" "));
		url.searchParams.set("state", state);
		return url.toString();
	}

	async exchangeCode(code: string, now: number): Promise<void> {
		const body = new URLSearchParams({
			code,
			client_id: this.config.googleClientId,
			client_secret: this.config.googleClientSecret,
			redirect_uri: `${this.config.workerBaseUrl}/auth/google/callback`,
			grant_type: "authorization_code",
		});
		const response = await fetchWithTimeout(
			"https://oauth2.googleapis.com/token",
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body,
			},
			this.fetcher,
		);
		if (!response.ok)
			throw new Error("Google authorization could not be completed.");
		const result = tokenSchema.parse(await response.json());
		const existing = await this.repository.getCredential();
		const refreshToken =
			result.refresh_token ??
			(existing
				? await decryptSecret(
						existing.encrypted_refresh_token,
						this.config.googleTokenEncryptionKey,
					)
				: null);
		if (!refreshToken)
			throw new Error(
				"Google did not provide a refresh token. Reconnect with consent.",
			);
		this.token = {
			accessToken: result.access_token,
			expiresAt: now + Math.max(60, result.expires_in ?? 300) * 1000,
		};
		await this.verifyCalendarAccess();
		await this.repository.saveCredential(
			await encryptSecret(refreshToken, this.config.googleTokenEncryptionKey),
			now,
		);
	}

	async isConnected(): Promise<boolean> {
		return (await this.repository.getCredential()) !== null;
	}

	private async accessToken(): Promise<string> {
		const now = Date.now();
		if (this.token && this.token.expiresAt > now + 30_000)
			return this.token.accessToken;
		const credential = await this.repository.getCredential();
		if (!credential) throw new Error("Google Calendar is not connected.");
		const refreshToken = await decryptSecret(
			credential.encrypted_refresh_token,
			this.config.googleTokenEncryptionKey,
		);
		const body = new URLSearchParams({
			client_id: this.config.googleClientId,
			client_secret: this.config.googleClientSecret,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		});
		const response = await fetchWithTimeout(
			"https://oauth2.googleapis.com/token",
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body,
			},
			this.fetcher,
		);
		if (!response.ok) throw new Error("Google Calendar needs reconnecting.");
		const result = tokenSchema.parse(await response.json());
		this.token = {
			accessToken: result.access_token,
			expiresAt: now + Math.max(60, result.expires_in ?? 300) * 1000,
		};
		return this.token.accessToken;
	}

	private async request(
		path: string,
		init: RequestInit = {},
	): Promise<Response> {
		return fetchWithTimeout(
			`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.config.calendarId)}${path}`,
			{
				...init,
				headers: {
					Authorization: `Bearer ${await this.accessToken()}`,
					"Content-Type": "application/json",
					...init.headers,
				},
			},
			this.fetcher,
		);
	}

	private async verifyCalendarAccess(): Promise<void> {
		const response = await fetchWithTimeout(
			`https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(this.config.calendarId)}`,
			{ headers: { Authorization: `Bearer ${await this.accessToken()}` } },
			this.fetcher,
		);
		if (!response.ok)
			throw new Error("Configured family calendar is unavailable.");
		const calendar = calendarListSchema.parse(await response.json());
		if (calendar.accessRole !== "writer" && calendar.accessRole !== "owner")
			throw new Error(
				"Google account cannot write the configured family calendar.",
			);
	}

	async list(timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
		const events: CalendarEvent[] = [];
		let pageToken: string | undefined;
		do {
			const query = new URLSearchParams({
				singleEvents: "true",
				orderBy: "startTime",
				showDeleted: "false",
				timeMin: timeMin.toISOString(),
				timeMax: timeMax.toISOString(),
			});
			if (pageToken) query.set("pageToken", pageToken);
			const response = await this.request(`/events?${query}`);
			if (!response.ok) throw new Error("Google Calendar could not be read.");
			const page = listSchema.parse(await response.json());
			events.push(
				...page.items.filter((event) => event.status !== "cancelled"),
			);
			pageToken = page.nextPageToken;
		} while (pageToken);
		return events;
	}

	async get(eventId: string): Promise<CalendarEvent | null> {
		const response = await this.request(
			`/events/${encodeURIComponent(eventId)}`,
		);
		if (response.status === 404 || response.status === 410) return null;
		if (!response.ok) throw new Error("Google Calendar could not be read.");
		const event = calendarEventSchema.parse(await response.json());
		return event.status === "cancelled" ? null : event;
	}

	async insert(
		eventId: string,
		event: CalendarMutation,
		actionId: string,
		creator: { name: string; telegramId: string },
	): Promise<CalendarEvent> {
		const existing = await this.get(eventId);
		if (
			existing?.extendedProperties?.private?.family_action_id === actionId &&
			sameMutation(existing, event)
		)
			return existing;
		if (existing)
			throw new Error("Google Calendar event identifier is unavailable.");
		const response = await this.request(`/events?sendUpdates=none`, {
			method: "POST",
			body: JSON.stringify({
				...event,
				id: eventId,
				extendedProperties: {
					private: {
						family_action_id: actionId,
						family_creator_name: creator.name,
						family_creator_telegram_id: creator.telegramId,
					},
				},
			}),
		});
		if (response.status === 409)
			return this.insert(eventId, event, actionId, creator);
		if (!response.ok)
			throw new Error("Google Calendar could not save the event.");
		return calendarEventSchema.parse(await response.json());
	}

	async patch(
		eventId: string,
		etag: string,
		event: CalendarMutation,
		actionId: string,
	): Promise<CalendarEvent> {
		const existing = await this.get(eventId);
		if (!existing) throw new Error("El evento ya no existe.");
		if (existing.recurrence?.length)
			throw new Error("No gestiono eventos recurrentes.");
		if (
			existing.extendedProperties?.private?.family_action_id === actionId &&
			sameMutation(existing, event)
		)
			return existing;
		if (existing.etag !== etag)
			throw new Error("El evento cambió; vuelve a revisarlo antes de guardar.");
		const response = await this.request(
			`/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
			{
				method: "PATCH",
				headers: { "If-Match": etag },
				body: JSON.stringify({
					...event,
					description: event.description ?? existing.description,
					location: event.location ?? existing.location,
					extendedProperties: {
						private: {
							...existing.extendedProperties?.private,
							family_action_id: actionId,
						},
					},
				}),
			},
		);
		if (response.status === 412)
			throw new Error("El evento cambió; vuelve a revisarlo antes de guardar.");
		if (!response.ok)
			throw new Error("Google Calendar could not update the event.");
		return calendarEventSchema.parse(await response.json());
	}

	async delete(eventId: string, etag: string): Promise<void> {
		const existing = await this.get(eventId);
		if (!existing) return;
		if (existing.etag !== etag)
			throw new Error("El evento cambió; vuelve a revisarlo antes de borrar.");
		const response = await this.request(
			`/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
			{ method: "DELETE", headers: { "If-Match": etag } },
		);
		if (response.status === 404 || response.status === 410) return;
		if (response.status === 412)
			throw new Error("El evento cambió; vuelve a revisarlo antes de borrar.");
		if (!response.ok)
			throw new Error("Google Calendar could not borrar el evento.");
	}

	async nearbyBusy(
		start: Date,
		end: Date,
		excludeEventId?: string,
	): Promise<CalendarEvent[]> {
		const proximity = 60 * 60_000;
		const minimum = new Date(start.getTime() - proximity);
		const maximum = new Date(end.getTime() + proximity);
		const events = await this.list(
			new Date(minimum.getTime() - 1),
			new Date(maximum.getTime() + 1),
		);
		return events.filter(
			(event) =>
				event.id !== excludeEventId &&
				event.status !== "cancelled" &&
				event.transparency !== "transparent" &&
				(() => {
					const interval = calendarInterval(event.start, event.end);
					return (
						interval !== null &&
						interval.end >= minimum &&
						interval.start <= maximum
					);
				})(),
		);
	}
}
