import type { AppConfig } from "../../config/config";
import { randomId, type Repository } from "../../shared/database";
import { timingSafeEqual } from "../../shared/timing-safe";
import type { GoogleCalendar } from "../calendar/google-calendar";

const html = (message: string): Response =>
	new Response(
		`<!doctype html><html lang="en"><body><p>${message}</p></body></html>`,
		{
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
			},
		},
	);

export const startOAuth = async (
	request: Request,
	config: AppConfig,
	repository: Repository,
	calendar: GoogleCalendar,
): Promise<Response> => {
	const authorization = request.headers.get("authorization") ?? "";
	const expected = `Bearer ${config.oauthSetupAdminToken}`;
	if (!timingSafeEqual(authorization, expected))
		return new Response("Not found", { status: 404 });
	const state = randomId();
	await repository.saveOAuthState(state, Date.now());
	return Response.redirect(calendar.oauthUrl(state), 302);
};

export const finishOAuth = async (
	request: Request,
	repository: Repository,
	calendar: GoogleCalendar,
): Promise<Response> => {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!state || !(await repository.consumeOAuthState(state, Date.now())))
		return html("Authorization link is invalid or expired.");
	if (!code || url.searchParams.has("error"))
		return html("Calendar connection could not be completed. Start again.");
	try {
		await calendar.exchangeCode(code, Date.now());
		return html("Calendar connection completed. You can close this page.");
	} catch {
		return html("Calendar connection could not be completed. Start again.");
	}
};
