import { Bot, InlineKeyboard } from "grammy";
import type { AppConfig, FamilyMember } from "../../config/config";
import { interpretMessage, type Interpretation } from "../ai/interpret";
import { normalizeInterpretation } from "../ai/normalization";
import type {
	CalendarEvent,
	CalendarMutation,
	GoogleCalendar,
} from "../calendar/google-calendar";
import {
	addMadridDays,
	calendarInterval,
	classifyProximity,
	formatMadrid,
	madridDate,
	madridLocalDateTime,
	nextMadridDate,
	resolveSpanishDate,
} from "../../shared/scheduling";
import type { Repository } from "../../shared/database";

const ACTIONS = {
	CREATE: "create",
	UPDATE: "update",
	DELETE: "delete",
	SELECT: "select",
} as const;
type ActionKind = (typeof ACTIONS)[keyof typeof ACTIONS];

interface ActionPayload {
	event?: CalendarMutation;
	eventId?: string;
	etag?: string;
	operation?: ActionKind;
	interpretation?: Interpretation;
	message?: string;
}

const parsePayload = (value: string): ActionPayload | null => {
	try {
		const result: unknown = JSON.parse(value);
		return typeof result === "object" && result !== null
			? (result as ActionPayload)
			: null;
	} catch {
		return null;
	}
};

const senderFrom = (
	id: number | undefined,
	config: AppConfig,
): FamilyMember | null =>
	id === undefined ? null : (config.allowedUsers.get(String(id)) ?? null);

const interval = (event: CalendarEvent): { start: Date; end: Date } | null =>
	calendarInterval(event.start, event.end);

const titleDefault = (message: string, sender: FamilyMember): string | null => {
	const text = message.toLocaleLowerCase("es-ES");
	if (/\bdentista\b/.test(text)) return `Cita con dentista de ${sender}`;
	if (/\bdoctora?\b|\bm[eé]dico\b/.test(text))
		return `Cita médica de ${sender}`;
	if (/\bpeluquer[ií]a\b/.test(text)) return `Peluquería de ${sender}`;
	return null;
};

const eventLabel = (event: CalendarEvent): string => {
	if (event.start.date) {
		const first = new Intl.DateTimeFormat("es-ES", {
			dateStyle: "short",
			timeZone: "Europe/Madrid",
		}).format(new Date(`${event.start.date}T12:00:00.000Z`));
		if (!event.end.date)
			return `${event.summary ?? "Sin título"} — todo el día ${first}`;
		const last = new Intl.DateTimeFormat("es-ES", {
			dateStyle: "short",
			timeZone: "Europe/Madrid",
		}).format(
			new Date(`${event.end.date}T12:00:00.000Z`).getTime() - 86_400_000,
		);
		return `${event.summary ?? "Sin título"} — todo el día ${first}${first === last ? "" : `–${last}`}`;
	}
	const value = interval(event);
	return `${event.summary ?? "Sin título"} — ${value ? formatMadrid(value.start) : "sin fecha"}`;
};

const missingQuestion = (value: Interpretation): string =>
	value.missing.includes("time")
		? "¿A qué hora?"
		: value.missing.includes("date")
			? "¿Qué día?"
			: value.missing.includes("title")
				? "¿Qué evento quieres guardar?"
				: "Necesito un poco más de información.";

const mutationFor = (
	value: Interpretation,
	sender: FamilyMember,
	message: string,
	duration: number,
	now: Date,
): { event: CalendarMutation; label: string } | { error: string } => {
	const title = value.title ?? titleDefault(message, sender);
	if (!title) return { error: "Necesito el título del evento." };
	if (value.all_day) {
		if (value.day === null) return { error: "¿Qué día?" };
		const result = resolveSpanishDate(
			{
				day: value.day,
				month: value.month ?? undefined,
				year: value.year ?? undefined,
			},
			now,
		);
		if (!result.ok) return { error: result.reason };
		return {
			event: {
				summary: title,
				location: value.location ?? undefined,
				start: { date: madridDate(result.value.start) },
				end: { date: nextMadridDate(result.value.start) },
			},
			label: `${title}, todo el día`,
		};
	}
	if (value.day === null || value.hour === null)
		return { error: missingQuestion(value) };
	const result = resolveSpanishDate(
		{
			day: value.day,
			month: value.month ?? undefined,
			year: value.year ?? undefined,
			hour: value.hour,
			minute: value.minute ?? 0,
			weekday: value.weekday ?? undefined,
		},
		now,
	);
	if (!result.ok) return { error: result.reason };
	const minutes = value.duration_minutes ?? duration;
	const end = new Date(result.value.start.getTime() + minutes * 60_000);
	return {
		event: {
			summary: title,
			location: value.location ?? undefined,
			start: {
				dateTime: result.value.start.toISOString(),
				timeZone: "Europe/Madrid",
			},
			end: { dateTime: end.toISOString(), timeZone: "Europe/Madrid" },
		},
		label: `${title}, ${formatMadrid(result.value.start)} (${minutes} min)`,
	};
};

const updateMutationFor = (
	old: CalendarEvent,
	value: Interpretation,
	sender: FamilyMember,
	message: string,
	now: Date,
): { event: CalendarMutation; label: string } | { error: string } => {
	if (old.recurrence?.length)
		return { error: "No gestiono eventos recurrentes." };
	if (old.start.date || old.end.date) {
		if (!value.all_day)
			return {
				error:
					"No puedo convertir un evento de todo el día a una hora concreta. Indica un nuevo evento.",
			};
		if (!old.start.date || !old.end.date)
			return { error: "No gestiono ese evento." };
		const base = old.start.date.split("-").map(Number);
		if (base.length !== 3 || base.some(Number.isNaN))
			return { error: "No gestiono ese evento." };
		const target = mutationFor(
			{
				...value,
				day: value.day ?? base[2],
				month: value.month ?? base[1],
				year: value.year ?? base[0],
				title: value.title ?? old.summary ?? null,
			},
			sender,
			message,
			1440,
			now,
		);
		if ("error" in target) return target;
		const oldInterval = calendarInterval(old.start, old.end);
		const durationDays = oldInterval
			? Math.max(
					1,
					Math.round(
						(oldInterval.end.getTime() - oldInterval.start.getTime()) /
							86_400_000,
					),
				)
			: 1;
		const start = target.event.start.date;
		if (!start) return { error: "No gestiono ese evento." };
		const end = addMadridDays(start, durationDays);
		if (!end) return { error: "No gestiono ese evento." };
		return {
			event: {
				...target.event,
				description: old.description,
				location: value.location ?? old.location,
				end: { date: end },
			},
			label: target.label,
		};
	}
	if (value.all_day)
		return {
			error:
				"No puedo convertir un evento con hora en todo el día. Indica un nuevo evento.",
		};
	if (value.weekday && value.day === null)
		return { error: "Indica una fecha exacta para cambiar este evento." };
	const previous = interval(old);
	if (!previous) return { error: "No gestiono ese evento." };
	const local = madridLocalDateTime(previous.start);
	const target = mutationFor(
		{
			...value,
			day: value.day ?? local.day,
			month: value.month ?? local.month,
			year: value.year ?? local.year,
			hour: value.hour ?? local.hour,
			minute: value.minute ?? local.minute,
			title: value.title ?? old.summary ?? null,
			location: value.location ?? old.location ?? null,
		},
		sender,
		message,
		value.duration_minutes ??
			Math.round((previous.end.getTime() - previous.start.getTime()) / 60_000),
		now,
	);
	if ("error" in target) return target;
	return {
		event: { ...target.event, description: old.description },
		label: target.label,
	};
};

const busyWarnings = (
	events: CalendarEvent[],
	proposed: CalendarMutation,
	exclude?: string,
): string[] => {
	const proposedInterval = interval({
		id: "proposed",
		start: proposed.start,
		end: proposed.end,
	});
	if (!proposedInterval) return [];
	return events.flatMap((event) => {
		if (
			event.id === exclude ||
			event.transparency === "transparent" ||
			event.status === "cancelled"
		)
			return [];
		const existing = interval(event);
		if (!existing) return [];
		const relation = classifyProximity(
			proposedInterval.start,
			proposedInterval.end,
			existing,
		);
		return relation === "CLEAR"
			? []
			: [
					`${relation === "OVERLAP" ? "Se solapa con" : "Está cerca de"} ${eventLabel(event)}`,
				];
	});
};

const listReply = async (
	calendar: GoogleCalendar,
	from: Date,
	until: Date,
): Promise<string> => {
	const events = await calendar.list(from, until);
	return events.length ? events.map(eventLabel).join("\n") : "No hay eventos.";
};

const availabilityReply = async (
	calendar: GoogleCalendar,
	from: Date,
	until: Date,
	minutes: number,
): Promise<string> => {
	const busy = (await calendar.list(from, until))
		.filter(
			(event) =>
				event.transparency !== "transparent" && event.status !== "cancelled",
		)
		.flatMap((event) => {
			const value = interval(event);
			return value ? [value] : [];
		})
		.sort((left, right) => left.start.getTime() - right.start.getTime());
	const gaps: { start: Date; end: Date }[] = [];
	let cursor = from;
	for (const item of busy) {
		if (
			item.start > cursor &&
			item.start.getTime() - cursor.getTime() >= minutes * 60_000
		)
			gaps.push({ start: cursor, end: item.start });
		if (item.end > cursor) cursor = item.end;
	}
	if (until.getTime() - cursor.getTime() >= minutes * 60_000)
		gaps.push({ start: cursor, end: until });
	return gaps.length
		? `Huecos reales de al menos ${minutes} min:\n${gaps
				.slice(0, 3)
				.map((gap) => `${formatMadrid(gap.start)}–${formatMadrid(gap.end)}`)
				.join("\n")}`
		: "No hay huecos reales con esa duración en este periodo.";
};

const searchEvents = async (
	calendar: GoogleCalendar,
	search: string | null,
	now: Date,
): Promise<CalendarEvent[]> => {
	const events = await calendar.list(
		new Date(now.getTime() - 31 * 86_400_000),
		new Date(now.getTime() + 366 * 86_400_000),
	);
	const term = (search ?? "").toLocaleLowerCase("es-ES");
	return events.filter((event) =>
		(event.summary ?? "").toLocaleLowerCase("es-ES").includes(term),
	);
};

export const createBot = (
	config: AppConfig,
	repository: Repository,
	calendar: GoogleCalendar,
	clock = (): Date => new Date(),
): Bot => {
	const bot = new Bot(config.telegramBotToken);
	const privateUser = (
		id: number | undefined,
		chatType: string | undefined,
	): FamilyMember | null =>
		chatType === "private" ? senderFrom(id, config) : null;
	const createPreview = async (
		ownerId: string,
		chatId: string,
		_sender: FamilyMember,
		event: CalendarMutation,
		label: string,
		reply: (
			text: string,
			options?: { reply_markup?: InlineKeyboard },
		) => Promise<unknown>,
	): Promise<unknown> => {
		const start = interval({ id: "new", start: event.start, end: event.end });
		const warnings = start
			? busyWarnings(await calendar.nearbyBusy(start.start, start.end), event)
			: [];
		const action = await repository.createAction(
			ownerId,
			chatId,
			ACTIONS.CREATE,
			JSON.stringify({ event }),
			clock().getTime(),
		);
		const verb = warnings.length ? "Crear igualmente" : "Crear";
		return reply(
			`${warnings.join("\n")}${warnings.length ? "\n" : ""}Preparado: ${label}\nNo se guardará hasta confirmarlo.`,
			{
				reply_markup: new InlineKeyboard()
					.text(verb, `c:${action}`)
					.text("Cancelar", `x:${action}`),
			},
		);
	};
	const operationPreview = async (
		ownerId: string,
		chatId: string,
		sender: FamilyMember,
		operation: ActionKind,
		old: CalendarEvent,
		interpretation: Interpretation,
		message: string,
		reply: (
			text: string,
			options?: { reply_markup?: InlineKeyboard },
		) => Promise<unknown>,
	): Promise<unknown> => {
		if (old.recurrence?.length)
			return reply("No gestiono eventos recurrentes.");
		if (!old.id || !old.etag) return reply("No gestiono ese evento.");
		if (operation === ACTIONS.DELETE) {
			const action = await repository.createAction(
				ownerId,
				chatId,
				ACTIONS.DELETE,
				JSON.stringify({ eventId: old.id, etag: old.etag }),
				clock().getTime(),
			);
			return reply(
				`Borrar: ${eventLabel(old)}\nNo se borrará hasta confirmarlo.`,
				{
					reply_markup: new InlineKeyboard()
						.text("Borrar", `c:${action}`)
						.text("Cancelar", `x:${action}`),
				},
			);
		}
		const proposed = updateMutationFor(
			old,
			interpretation,
			sender,
			message,
			clock(),
		);
		if ("error" in proposed) return reply(proposed.error);
		const proposedEvent: CalendarEvent = {
			id: old.id,
			start: proposed.event.start,
			end: proposed.event.end,
			summary: proposed.event.summary,
		};
		const proposedInterval = interval(proposedEvent);
		const warnings = proposedInterval
			? busyWarnings(
					await calendar.nearbyBusy(
						proposedInterval.start,
						proposedInterval.end,
						old.id,
					),
					proposed.event,
					old.id,
				)
			: [];
		const action = await repository.createAction(
			ownerId,
			chatId,
			ACTIONS.UPDATE,
			JSON.stringify({
				eventId: old.id,
				etag: old.etag,
				event: proposed.event,
			}),
			clock().getTime(),
		);
		return reply(
			`${warnings.join("\n")}${warnings.length ? "\n" : ""}Cambiar:\nAntes: ${eventLabel(old)}\nPropuesto: ${eventLabel(proposedEvent)}\nNo se guardará hasta confirmarlo.`,
			{
				reply_markup: new InlineKeyboard()
					.text(
						warnings.length ? "Guardar cambio igualmente" : "Guardar cambio",
						`c:${action}`,
					)
					.text("Cancelar", `x:${action}`),
			},
		);
	};

	bot.command("start", (ctx) =>
		ctx.reply(
			"Hola. Puedo consultar y preparar eventos del calendario familiar. Usa /help.",
		),
	);
	bot.command("help", (ctx) =>
		ctx.reply(
			"Escríbeme una cita en español. /today, /tomorrow, /week, /cancel y /status no usan IA.",
		),
	);
	bot.command("cancel", async (ctx) => {
		const sender = privateUser(ctx.from?.id, ctx.chat?.type);
		if (!sender || !ctx.from || !ctx.chat)
			return ctx.reply("Este bot solo funciona en chat privado autorizado.");
		await repository.cancelConversation(
			String(ctx.from.id),
			String(ctx.chat.id),
		);
		return ctx.reply("Conversación cancelada.");
	});
	bot.command("status", async (ctx) =>
		ctx.reply(
			privateUser(ctx.from?.id, ctx.chat?.type) &&
				(await calendar.isConnected())
				? "Calendario conectado."
				: "Este bot solo funciona en chat privado autorizado.",
		),
	);
	for (const command of ["today", "tomorrow", "week"] as const)
		bot.command(command, async (ctx) => {
			if (!privateUser(ctx.from?.id, ctx.chat?.type))
				return ctx.reply("Este bot solo funciona en chat privado autorizado.");
			const now = clock();
			const offset = command === "tomorrow" ? 1 : 0;
			const days = command === "week" ? 7 : 1;
			try {
				return ctx.reply(
					await listReply(
						calendar,
						new Date(now.getTime() + offset * 86_400_000),
						new Date(now.getTime() + (offset + days) * 86_400_000),
					),
				);
			} catch {
				return ctx.reply(
					"No puedo consultar el calendario ahora. Revisa la conexión.",
				);
			}
		});

	bot.on("message:text", async (ctx) => {
		const sender = privateUser(ctx.from?.id, ctx.chat.type);
		if (!sender || !ctx.from)
			return ctx.reply("Este bot solo funciona en chat privado autorizado.");
		const ownerId = String(ctx.from.id),
			chatId = String(ctx.chat.id),
			now = clock();
		const draft = await repository.getConversation(
			ownerId,
			chatId,
			now.getTime(),
		);
		const interpreted = await interpretMessage(
			{
				message: ctx.message.text,
				sender,
				nowMadrid: formatMadrid(now),
				previousDraft: draft,
			},
			config.geminiApiKey,
			config.geminiModel,
		);
		if (!interpreted)
			return ctx.reply(
				"No he podido interpretar eso. Prueba con una cita y fecha concreta.",
			);
		if (interpreted.intent === "UNKNOWN") {
			await repository.saveConversation(
				ownerId,
				chatId,
				draft ? `${draft}\n${ctx.message.text}` : ctx.message.text,
				now.getTime(),
			);
			return ctx.reply("¿Quieres crear un evento o buscar uno existente?");
		}
		const value = normalizeInterpretation(
			interpreted,
			ctx.message.text,
			sender,
			now,
			draft,
		);
		if (value.intent === "CLARIFICATION" || value.missing.length) {
			await repository.saveConversation(
				ownerId,
				chatId,
				draft ? `${draft}\n${ctx.message.text}` : ctx.message.text,
				now.getTime(),
			);
			return ctx.reply(
				value.intent === "CLARIFICATION"
					? "¿Quieres crear un evento o buscar uno existente?"
					: missingQuestion(value),
			);
		}
		if (
			value.intent === "LIST_EVENTS" ||
			value.intent === "CHECK_AVAILABILITY"
		) {
			try {
				return ctx.reply(
					value.intent === "CHECK_AVAILABILITY"
						? await availabilityReply(
								calendar,
								now,
								new Date(now.getTime() + 7 * 86_400_000),
								value.duration_minutes ?? config.defaultDurationMinutes,
							)
						: await listReply(
								calendar,
								now,
								new Date(now.getTime() + 7 * 86_400_000),
							),
				);
			} catch {
				return ctx.reply(
					"No puedo consultar el calendario ahora. Revisa la conexión.",
				);
			}
		}
		if (value.intent === "CREATE_EVENT") {
			const prepared = mutationFor(
				value,
				sender,
				ctx.message.text,
				config.defaultDurationMinutes,
				now,
			);
			if ("error" in prepared) {
				await repository.saveConversation(
					ownerId,
					chatId,
					ctx.message.text,
					now.getTime(),
				);
				return ctx.reply(prepared.error);
			}
			await repository.cancelConversation(ownerId, chatId);
			return createPreview(
				ownerId,
				chatId,
				sender,
				prepared.event,
				prepared.label,
				ctx.reply.bind(ctx),
			);
		}
		if (value.intent !== "UPDATE_EVENT" && value.intent !== "DELETE_EVENT") {
			await repository.saveConversation(
				ownerId,
				chatId,
				draft ? `${draft}\n${ctx.message.text}` : ctx.message.text,
				now.getTime(),
			);
			return ctx.reply("¿Quieres crear un evento o buscar uno existente?");
		}
		const matches = await searchEvents(
			calendar,
			value.search ?? value.title,
			now,
		);
		if (!matches.length)
			return ctx.reply(
				"No encuentro un evento que coincida. Indica un título y fecha más exactos.",
			);
		if (matches.some((event) => event.recurrence?.length))
			return ctx.reply("No gestiono eventos recurrentes.");
		const operation =
			value.intent === "UPDATE_EVENT" ? ACTIONS.UPDATE : ACTIONS.DELETE;
		if (matches.length > 1) {
			const keyboard = new InlineKeyboard();
			for (const match of matches.slice(0, 5)) {
				const id = await repository.createAction(
					ownerId,
					chatId,
					ACTIONS.SELECT,
					JSON.stringify({
						eventId: match.id,
						etag: match.etag,
						operation,
						interpretation: value,
						message: ctx.message.text,
					}),
					now.getTime(),
				);
				keyboard.text(eventLabel(match), `s:${id}`).row();
			}
			return ctx.reply("He encontrado varios eventos. Elige uno:", {
				reply_markup: keyboard,
			});
		}
		const match = matches[0];
		if (!match.id) return ctx.reply("No gestiono ese evento.");
		const current = await calendar.get(match.id);
		if (!current) return ctx.reply("El evento ya no existe.");
		return operationPreview(
			ownerId,
			chatId,
			sender,
			operation,
			current,
			value,
			ctx.message.text,
			ctx.reply.bind(ctx),
		);
	});

	bot.on("callback_query:data", async (ctx) => {
		const sender = privateUser(ctx.from?.id, ctx.chat?.type);
		if (!sender || !ctx.from || !ctx.chat)
			return ctx.answerCallbackQuery({ text: "No autorizado." });
		const parts = ctx.callbackQuery.data.split(":");
		if (
			parts.length !== 2 ||
			!/^[csx]$/.test(parts[0]) ||
			!/^[a-f0-9]{32}$/.test(parts[1])
		)
			return ctx.answerCallbackQuery({ text: "Acción no válida." });
		const [verb, id] = parts;
		const ownerId = String(ctx.from.id);
		const chatId = String(ctx.chat.id);
		const existing = await repository.getAction(id, ownerId, chatId);
		if (!existing)
			return ctx.answerCallbackQuery({
				text: "Acción vencida o no autorizada.",
			});
		if (verb === "x") {
			const cancelled = await repository.cancelAction(
				id,
				ownerId,
				chatId,
				clock().getTime(),
			);
			return ctx.answerCallbackQuery({
				text: cancelled ? "Cancelado." : "Acción vencida o ya procesada.",
			});
		}
		if (
			(verb === "s" && existing.kind !== ACTIONS.SELECT) ||
			(verb === "c" &&
				existing.kind !== ACTIONS.CREATE &&
				existing.kind !== ACTIONS.UPDATE &&
				existing.kind !== ACTIONS.DELETE)
		)
			return ctx.answerCallbackQuery({ text: "Acción no válida." });
		const previewPayload = parsePayload(existing.payload);
		const validSelection =
			verb === "s" &&
			existing.kind === ACTIONS.SELECT &&
			previewPayload?.eventId &&
			previewPayload.interpretation &&
			previewPayload.message &&
			(previewPayload.operation === ACTIONS.UPDATE ||
				previewPayload.operation === ACTIONS.DELETE);
		const validConfirmation =
			verb === "c" &&
			((existing.kind === ACTIONS.CREATE && previewPayload?.event) ||
				((existing.kind === ACTIONS.UPDATE ||
					existing.kind === ACTIONS.DELETE) &&
					previewPayload?.eventId &&
					previewPayload.etag &&
					(existing.kind === ACTIONS.DELETE || previewPayload.event)));
		if (!validSelection && !validConfirmation)
			return ctx.answerCallbackQuery({ text: "Acción no válida." });
		const action = await repository.claimAction(
			id,
			ownerId,
			chatId,
			existing.kind,
			clock().getTime(),
		);
		if (!action)
			return ctx.answerCallbackQuery({
				text: "Acción vencida o ya procesada.",
			});
		const payload = parsePayload(action.payload);
		if (!payload) {
			await repository.finishAction(
				action.id,
				null,
				action.fence_token,
				clock().getTime(),
			);
			return ctx.answerCallbackQuery({ text: "Acción no válida." });
		}
		if (
			action.kind === ACTIONS.SELECT &&
			verb === "s" &&
			(payload.operation === ACTIONS.UPDATE ||
				payload.operation === ACTIONS.DELETE) &&
			payload.eventId &&
			payload.interpretation &&
			payload.message
		) {
			const selected = await calendar.get(payload.eventId);
			if (!selected) {
				await repository.finishAction(
					action.id,
					payload.eventId,
					action.fence_token,
					clock().getTime(),
				);
				return ctx.reply("El evento ya no existe.");
			}
			await repository.finishAction(
				action.id,
				payload.eventId,
				action.fence_token,
				clock().getTime(),
			);
			await ctx.answerCallbackQuery({ text: "Seleccionado." });
			return operationPreview(
				ownerId,
				chatId,
				sender,
				payload.operation,
				selected,
				payload.interpretation,
				payload.message,
				ctx.reply.bind(ctx),
			);
		}
		if (verb !== "c")
			return ctx.answerCallbackQuery({ text: "Acción no válida." });
		try {
			if (action.kind === ACTIONS.CREATE && payload.event) {
				const created = await calendar.insert(
					action.id,
					payload.event,
					action.id,
					{ name: sender, telegramId: String(ctx.from.id) },
				);
				await repository.finishAction(
					action.id,
					created.id,
					action.fence_token,
					clock().getTime(),
				);
				await ctx.answerCallbackQuery({ text: "Guardado." });
				return ctx.reply(`Guardado: ${eventLabel(created)}`);
			}
			if (!payload.eventId || !payload.etag) throw new Error("Invalid action");
			if (action.kind === ACTIONS.DELETE) {
				await calendar.delete(payload.eventId, payload.etag);
				await repository.finishAction(
					action.id,
					payload.eventId,
					action.fence_token,
					clock().getTime(),
				);
				await ctx.answerCallbackQuery({ text: "Borrado." });
				return ctx.reply("Evento borrado.");
			}
			if (action.kind === ACTIONS.UPDATE && payload.event) {
				const updated = await calendar.patch(
					payload.eventId,
					payload.etag,
					payload.event,
					action.id,
				);
				await repository.finishAction(
					action.id,
					updated.id,
					action.fence_token,
					clock().getTime(),
				);
				await ctx.answerCallbackQuery({ text: "Actualizado." });
				return ctx.reply(`Actualizado: ${eventLabel(updated)}`);
			}
			throw new Error("Invalid action");
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === "El evento ya no existe." ||
					error.message ===
						"El evento cambió; vuelve a revisarlo antes de guardar." ||
					error.message ===
						"El evento cambió; vuelve a revisarlo antes de borrar.")
			) {
				await repository.finishAction(
					action.id,
					action.event_id,
					action.fence_token,
					clock().getTime(),
				);
				return ctx.reply(error.message);
			}
			await repository.markActionUncertain(
				action.id,
				action.fence_token,
				clock().getTime(),
			);
			return ctx.answerCallbackQuery({
				text: "No puedo confirmar el resultado. No repetiré la operación.",
			});
		}
	});
	return bot;
};
