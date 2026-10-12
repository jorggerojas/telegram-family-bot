import type { FamilyMember } from "../../config/config";
import { madridLocalDateTime } from "../../shared/scheduling";
import type { Interpretation } from "./interpret";

const MONTHS = {
	enero: 1,
	febrero: 2,
	marzo: 3,
	abril: 4,
	mayo: 5,
	junio: 6,
	julio: 7,
	agosto: 8,
	septiembre: 9,
	setiembre: 9,
	octubre: 10,
	noviembre: 11,
	diciembre: 12,
} as const;

const WEEKDAYS = {
	domingo: 0,
	lunes: 1,
	martes: 2,
	miércoles: 3,
	miercoles: 3,
	jueves: 4,
	viernes: 5,
	sábado: 6,
	sabado: 6,
} as const;

const HOUR_WORDS = {
	una: 1,
	dos: 2,
	tres: 3,
	cuatro: 4,
	cinco: 5,
	seis: 6,
	siete: 7,
	ocho: 8,
	nueve: 9,
	diez: 10,
	once: 11,
	doce: 12,
} as const;

type ExplicitWeekday = keyof typeof WEEKDAYS;
type Extracted = Partial<
	Pick<
		Interpretation,
		| "day"
		| "month"
		| "year"
		| "weekday"
		| "hour"
		| "minute"
		| "duration_minutes"
		| "title"
	>
> & {
	ambiguousTime?: boolean;
	ambiguousDate?: boolean;
	needsMonth?: boolean;
	weekdayMentioned?: boolean;
	dateMentioned?: boolean;
};

const text = (value: string): string =>
	value.toLocaleLowerCase("es-ES").normalize("NFC");

const dateParts = (date: Date): [number, number, number] => {
	const value = madridLocalDateTime(date);
	return [value.year, value.month, value.day];
};

const addDays = (
	year: number,
	month: number,
	day: number,
	days: number,
): [number, number, number] => {
	const value = new Date(Date.UTC(year, month - 1, day + days));
	return [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()];
};

const weekdayFor = (year: number, month: number, day: number): number =>
	new Date(Date.UTC(year, month - 1, day)).getUTCDay();

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

const relativeDate = (value: string, now: Date): Extracted => {
	const [year, month, day] = dateParts(now);
	if (/\bhoy\b/.test(value)) return { year, month, day };
	if (/\bpasado mañana\b/.test(value)) {
		const [nextYear, nextMonth, nextDay] = addDays(year, month, day, 2);
		return { year: nextYear, month: nextMonth, day: nextDay };
	}
	if (/\bmañana\b/.test(value)) {
		const [nextYear, nextMonth, nextDay] = addDays(year, month, day, 1);
		return { year: nextYear, month: nextMonth, day: nextDay };
	}
	const weeks = value.match(/\bdentro de (una|dos|1|2) semanas?\b/);
	if (weeks) {
		const amount = weeks[1] === "dos" || weeks[1] === "2" ? 14 : 7;
		const [nextYear, nextMonth, nextDay] = addDays(year, month, day, amount);
		return { year: nextYear, month: nextMonth, day: nextDay };
	}
	const lastFriday = /\b(?:el )?último viernes del mes\b/.test(value);
	if (lastFriday) {
		const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
		const offset = (weekdayFor(year, month, last) - WEEKDAYS.viernes + 7) % 7;
		return { year, month, day: last - offset, weekday: "viernes" };
	}
	const named = value.match(
		/\b(próximo|proximo|este) (lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/,
	);
	if (!named) return {};
	const weekday = named[2] as ExplicitWeekday;
	const currentWeekday = weekdayFor(year, month, day);
	let offset = (WEEKDAYS[weekday] - currentWeekday + 7) % 7;
	if (named[1] !== "este" && offset === 0) offset = 7;
	const [nextYear, nextMonth, nextDay] = addDays(year, month, day, offset);
	return { year: nextYear, month: nextMonth, day: nextDay, weekday };
};

const explicitTitle = (
	value: string,
	sender: FamilyMember,
): string | undefined => {
	const owner = /\b(?:alex|sam)\b/.exec(value)?.[0];
	const person =
		owner === "Alex" || owner === "Sam"
			? owner
			: owner === "jorge"
				? "Alex"
				: owner === "ana"
					? "Sam"
					: sender;
	if (/\bdentista\b/.test(value)) return `Cita con dentista de ${person}`;
	if (/\bdoctora?\b|\bm[eé]dico\b/.test(value))
		return `Cita médica de ${person}`;
	if (/\bpeluquer[ií]a\b/.test(value)) return `Peluquería de ${person}`;
	if (/\bcomida con mis padres\b/.test(value))
		return `Comida con los padres de ${person}`;
	return undefined;
};

const applyMeridiem = (
	result: Extracted,
	hour: number,
	meridiem: string | undefined,
): void => {
	const period = meridiem?.replaceAll(".", "");
	result.hour =
		period === "pm" || period === "tarde"
			? hour === 12
				? 12
				: hour + 12
			: period === "am" || period === "mañana"
				? hour === 12
					? 0
					: hour
				: period === "noche"
					? hour === 12
						? 0
						: hour + 12
					: hour;
	result.minute ??= 0;
};

const extractBareDay = (value: string, now: Date): Extracted => {
	const [year, month, today] = dateParts(now);
	const thisMonth = value.match(/\b(\d{1,2})\s+de\s+este\s+mes\b/);
	if (thisMonth) {
		const day = Number(thisMonth[1]);
		if (day >= 1 && day <= 31 && validCalendarDay(year, month, day))
			return { day, month, year };
	}
	const bare = value.match(
		/\b(?:para\s+el|el|día|dia)\s+(\d{1,2})\b(?!\s*(?:[:.]\d{2}|de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)|de\s+este\s+mes))/,
	);
	if (!bare) return {};
	const day = Number(bare[1]);
	if (day < 1 || day > 31 || !validCalendarDay(year, month, day)) return {};
	if (day < today) return { day, needsMonth: true, ambiguousDate: true };
	return { day, month, year };
};

const extract = (
	message: string,
	sender: FamilyMember,
	now: Date,
): Extracted => {
	const value = text(message);
	const result: Extracted = { ...relativeDate(value, now) };
	const namedDay = value.match(
		/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?\b/,
	);
	if (namedDay) {
		result.day = Number(namedDay[1]);
		result.month = MONTHS[namedDay[2] as keyof typeof MONTHS];
		result.year = namedDay[3] ? Number(namedDay[3]) : dateParts(now)[0];
	}
	if (result.day === undefined) {
		const bare = extractBareDay(value, now);
		Object.assign(result, bare);
	}
	const weekday = value.match(
		/\b(domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)\b/,
	)?.[1] as ExplicitWeekday | undefined;
	if (weekday) {
		result.weekday = weekday;
		result.weekdayMentioned = true;
	}
	const weekdayNumber = value.match(
		/\b(?:domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)\s+(\d{1,2})\b/,
	);
	if (weekdayNumber && !namedDay) {
		result.day = Number(weekdayNumber[1]);
		result.ambiguousDate = true;
	}
	if (weekday && !namedDay && !weekdayNumber && result.day === undefined) {
		const [year, month, day] = dateParts(now);
		let offset = (WEEKDAYS[weekday] - weekdayFor(year, month, day) + 7) % 7;
		if (offset === 0) offset = 7;
		const [nextYear, nextMonth, nextDay] = addDays(year, month, day, offset);
		result.year = nextYear;
		result.month = nextMonth;
		result.day = nextDay;
		result.weekday = undefined;
	}
	if (
		weekday &&
		typeof result.day === "number" &&
		typeof result.month === "number" &&
		typeof result.year === "number" &&
		!result.ambiguousDate &&
		!result.needsMonth
	) {
		const actual = weekdayFor(result.year, result.month, result.day);
		if (actual !== WEEKDAYS[weekday]) {
			result.ambiguousDate = true;
			result.weekday = undefined;
		}
	}
	const numericTime = value.match(
		/\b(?:para|a)\s*las\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|a\.m\.|pm|p\.m\.|de la mañana|de la tarde|de la noche)?\b/,
	);
	if (numericTime) {
		applyMeridiem(
			result,
			Number(numericTime[1]),
			numericTime[3]?.replace("de la ", ""),
		);
		if (numericTime[2]) result.minute = Number(numericTime[2]);
	} else {
		const numericClock = value.match(
			/\b(\d{1,2})[:.](\d{2})\s*(am|a\.m\.|pm|p\.m\.)?\b/,
		);
		if (numericClock) {
			applyMeridiem(result, Number(numericClock[1]), numericClock[3]);
			result.minute = Number(numericClock[2]);
		}
	}
	if (/\bmediod[ií]a\b/.test(value)) {
		result.hour = 12;
		result.minute = 0;
	}
	const namedTime = value.match(
		/\b(una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s+de la\s+(mañana|tarde|noche)\b/,
	);
	if (namedTime) {
		applyMeridiem(
			result,
			HOUR_WORDS[namedTime[1] as keyof typeof HOUR_WORDS],
			namedTime[2],
		);
	}
	if (
		/\b(?:para|a) las (una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/.test(
			value,
		) &&
		!/\bde la (?:mañana|tarde|noche)\b/.test(value)
	) {
		result.hour = undefined;
		result.minute = undefined;
		result.ambiguousTime = true;
	}
	if (/\bpor la mañana\b/.test(value) && !numericTime && !namedTime)
		result.ambiguousTime = true;
	const relativeNumber = value.match(
		/\b(?:mañana|pasado mañana)\s+(\d{1,2})\b(?![:.]\d)/,
	);
	if (!numericTime && relativeNumber && Number(relativeNumber[1]) <= 23) {
		result.hour = Number(relativeNumber[1]);
		result.minute = 0;
	}
	const duration = value.match(
		/\b(?:durante|por) (\d+)\s*(min(?:utos)?|horas?)\b/,
	);
	if (duration) {
		const amount = Number(duration[1]);
		result.duration_minutes = duration[2].startsWith("hora")
			? amount * 60
			: amount;
	}
	result.title = explicitTitle(value, sender);
	if (
		result.day !== undefined ||
		result.month !== undefined ||
		result.year !== undefined ||
		result.weekdayMentioned ||
		result.needsMonth ||
		result.ambiguousDate ||
		/\bal\s+\d{1,2}\b/.test(value)
	)
		result.dateMentioned = true;
	return result;
};

const merge = (value: Extracted, target: Extracted): Extracted => ({
	...value,
	...Object.fromEntries(
		Object.entries(target).filter(([, component]) => component !== undefined),
	),
});

const applyCreateDefaults = (
	value: Interpretation,
	now: Date,
	needsMonth: boolean,
): Interpretation => {
	if (value.intent !== "CREATE_EVENT" || value.all_day) return value;
	const current = madridLocalDateTime(now);
	let day = value.day;
	let month = value.month;
	let year = value.year;
	if (needsMonth) return value;
	if (day !== null && month === null) {
		month = current.month;
		year ??= current.year;
	}
	if (day === null && value.hour !== null) {
		const minute = value.minute ?? 0;
		const passed =
			value.hour < current.hour ||
			(value.hour === current.hour && minute <= current.minute);
		const [nextYear, nextMonth, nextDay] = passed
			? addDays(current.year, current.month, current.day, 1)
			: [current.year, current.month, current.day];
		day = nextDay;
		month = nextMonth;
		year = nextYear;
	}
	return { ...value, day, month, year };
};

export const normalizeInterpretation = (
	model: Interpretation,
	message: string,
	sender: FamilyMember,
	now: Date,
	previousDraft: string | null = null,
): Interpretation => {
	const current = extract(message, sender, now);
	const explicit = merge(
		previousDraft ? extract(previousDraft, sender, now) : {},
		current,
	);
	if (current.hour !== undefined) explicit.ambiguousTime = false;
	const timeOnly =
		explicit.hour !== undefined && explicit.dateMentioned !== true;
	if (
		current.day !== undefined &&
		!current.ambiguousDate &&
		!current.needsMonth
	)
		explicit.ambiguousDate = false;
	const weekday = explicit.weekdayMentioned ? (explicit.weekday ?? null) : null;
	const value: Interpretation = applyCreateDefaults(
		{
			...model,
			day: timeOnly ? null : (explicit.day ?? model.day),
			month: timeOnly ? null : (explicit.month ?? model.month),
			year: timeOnly ? null : (explicit.year ?? model.year),
			all_day: explicit.hour !== undefined ? false : model.all_day,
			weekday,
			hour: explicit.ambiguousTime ? null : (explicit.hour ?? model.hour),
			minute: explicit.ambiguousTime ? null : (explicit.minute ?? model.minute),
			duration_minutes: explicit.duration_minutes ?? model.duration_minutes,
			title: explicit.title ?? model.title,
		},
		now,
		Boolean(explicit.needsMonth),
	);
	const missing = new Set(value.missing);
	if (value.intent === "CREATE_EVENT") {
		missing.clear();
		if (!value.title) missing.add("title");
		if (explicit.needsMonth) missing.add("month");
		else if (value.day === null || explicit.ambiguousDate) missing.add("date");
		if (!value.all_day && (value.hour === null || explicit.ambiguousTime))
			missing.add("time");
	}
	return { ...value, missing: [...missing] };
};
