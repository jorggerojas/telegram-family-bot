const WEEKDAYS = {
	domingo: 0,
	lunes: 1,
	martes: 2,
	miercoles: 3,
	miércoles: 3,
	jueves: 4,
	viernes: 5,
	sabado: 6,
	sábado: 6,
} as const;

const PROXIMITY = {
	OVERLAP: "OVERLAP",
	NEAR_BEFORE: "NEAR_BEFORE",
	NEAR_AFTER: "NEAR_AFTER",
	CLEAR: "CLEAR",
} as const;

export type Proximity = (typeof PROXIMITY)[keyof typeof PROXIMITY];

export interface LocalDateTime {
	day: number;
	month?: number;
	year?: number;
	hour?: number;
	minute?: number;
	weekday?: keyof typeof WEEKDAYS;
}

export interface Interval {
	start: Date;
	end: Date;
}

export interface CalendarBoundary {
	dateTime?: string;
	date?: string;
}

interface ResolvedDate {
	start: Date;
	allDay: boolean;
}

type DateResolution =
	| { ok: true; value: ResolvedDate }
	| { ok: false; reason: string };

const zoneParts = (date: Date, timeZone: string): Record<string, string> =>
	Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(date)
			.map(({ type, value }) => [type, value]),
	);

const partNumber = (parts: Record<string, string>, name: string): number =>
	Number(parts[name]);

interface ZoneDateParts {
	day: number;
	month: number;
	year: number;
	hour: number;
	minute: number;
}

const currentParts = (now: Date, timeZone: string): ZoneDateParts => {
	const parts = zoneParts(now, timeZone);
	return {
		day: partNumber(parts, "day"),
		month: partNumber(parts, "month"),
		year: partNumber(parts, "year"),
		hour: partNumber(parts, "hour"),
		minute: partNumber(parts, "minute"),
	};
};

const sameWallTime = (
	date: Date,
	target: Required<LocalDateTime>,
	timeZone: string,
): boolean => {
	const parts = zoneParts(date, timeZone);
	return (
		partNumber(parts, "day") === target.day &&
		partNumber(parts, "month") === target.month &&
		partNumber(parts, "year") === target.year &&
		partNumber(parts, "hour") === target.hour &&
		partNumber(parts, "minute") === target.minute
	);
};

const dateInZone = (
	target: Required<LocalDateTime>,
	timeZone: string,
): Date[] => {
	const intendedUtc = Date.UTC(
		target.year,
		target.month - 1,
		target.day,
		target.hour,
		target.minute,
	);
	// Cover IANA offsets roughly UTC−12…UTC+14 (DST folds produce two matches).
	const candidates: Date[] = [];
	for (let minutes = -18 * 60; minutes <= 18 * 60; minutes += 1) {
		const candidate = new Date(intendedUtc + minutes * 60_000);
		if (sameWallTime(candidate, target, timeZone)) candidates.push(candidate);
	}
	return candidates;
};

const validCalendarDay = (
	year: number,
	month: number,
	day: number,
): boolean => {
	const value = new Date(Date.UTC(year, month - 1, day));
	return (
		value.getUTCFullYear() === year &&
		value.getUTCMonth() === month - 1 &&
		value.getUTCDate() === day
	);
};

export const civilMidnight = (value: string, timeZone: string): Date | null => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const [, yearText, monthText, dayText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	if (!validCalendarDay(year, month, day)) return null;
	const candidates = dateInZone(
		{
			year,
			month,
			day,
			hour: 0,
			minute: 0,
			weekday: "lunes",
		},
		timeZone,
	);
	return candidates.length === 1 ? candidates[0] : null;
};

const calendarBoundary = (
	value: CalendarBoundary,
	timeZone: string,
): Date | null => {
	if (value.dateTime) {
		const date = new Date(value.dateTime);
		return Number.isNaN(date.valueOf()) ? null : date;
	}
	return value.date ? civilMidnight(value.date, timeZone) : null;
};

export const calendarInterval = (
	start: CalendarBoundary,
	end: CalendarBoundary,
	timeZone: string,
): Interval | null => {
	const startDate = calendarBoundary(start, timeZone);
	const endDate = calendarBoundary(end, timeZone);
	return startDate && endDate ? { start: startDate, end: endDate } : null;
};

export const resolveSpanishDate = (
	input: LocalDateTime,
	now: Date,
	timeZone: string,
): DateResolution => {
	const current = currentParts(now, timeZone);
	const year = input.year ?? current.year;
	const month = input.month ?? current.month;
	const hour = input.hour ?? 0;
	const minute = input.minute ?? 0;
	if (
		!validCalendarDay(year, month, input.day) ||
		hour > 23 ||
		hour < 0 ||
		minute > 59 ||
		minute < 0
	) {
		return { ok: false, reason: "La fecha u hora no existe." };
	}
	const target: Required<LocalDateTime> = {
		day: input.day,
		month,
		year,
		hour,
		minute,
		weekday: input.weekday ?? "lunes",
	};
	const candidates = dateInZone(target, timeZone);
	if (candidates.length !== 1) {
		return {
			ok: false,
			reason: "Esa hora es ambigua o no existe por el cambio horario.",
		};
	}
	const start = candidates[0];
	if (start.getTime() < now.getTime())
		return { ok: false, reason: "No puedo crear citas en el pasado." };
	if (input.weekday) {
		const weekday = new Intl.DateTimeFormat("en-US", {
			timeZone,
			weekday: "long",
		})
			.format(start)
			.toLocaleLowerCase("en-US");
		const actual = [
			"sunday",
			"monday",
			"tuesday",
			"wednesday",
			"thursday",
			"friday",
			"saturday",
		].indexOf(weekday);
		if (actual !== WEEKDAYS[input.weekday])
			return {
				ok: false,
				reason: "El día de la semana no coincide con la fecha.",
			};
	}
	return { ok: true, value: { start, allDay: input.hour === undefined } };
};

export const classifyProximity = (
	start: Date,
	end: Date,
	existing: Interval,
): Proximity => {
	if (existing.start < end && existing.end > start) return PROXIMITY.OVERLAP;
	if (
		existing.end >= new Date(start.getTime() - 60 * 60_000) &&
		existing.end <= start
	)
		return PROXIMITY.NEAR_BEFORE;
	if (
		existing.start >= end &&
		existing.start <= new Date(end.getTime() + 60 * 60_000)
	)
		return PROXIMITY.NEAR_AFTER;
	return PROXIMITY.CLEAR;
};

export const localDate = (date: Date, timeZone: string): string => {
	const parts = zoneParts(date, timeZone);
	return `${parts.year}-${parts.month}-${parts.day}`;
};

export const nextLocalDate = (date: Date, timeZone: string): string => {
	const { year, month, day } = localDateTime(date, timeZone);
	const next = new Date(Date.UTC(year, month - 1, day + 1));
	return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
};

export const addLocalDays = (
	date: string,
	days: number,
	timeZone: string,
): string | null => {
	let current = civilMidnight(date, timeZone);
	if (!current || !Number.isSafeInteger(days) || days < 0) return null;
	let result = date;
	for (let index = 0; index < days; index += 1) {
		result = nextLocalDate(current, timeZone);
		current = civilMidnight(result, timeZone);
		if (!current) return null;
	}
	return result;
};

export const localDateTime = (
	date: Date,
	timeZone: string,
): Required<
	Pick<LocalDateTime, "day" | "month" | "year" | "hour" | "minute">
> => {
	const parts = zoneParts(date, timeZone);
	return {
		day: partNumber(parts, "day"),
		month: partNumber(parts, "month"),
		year: partNumber(parts, "year"),
		hour: partNumber(parts, "hour"),
		minute: partNumber(parts, "minute"),
	};
};

export const formatLocal = (date: Date, timeZone: string): string =>
	new Intl.DateTimeFormat("es-ES", {
		timeZone,
		dateStyle: "short",
		timeStyle: "short",
		hourCycle: "h23",
	}).format(date);
