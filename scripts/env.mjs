import { readFile } from "node:fs/promises";

const fromFile = async () => {
	try {
		const file = await readFile(".dev.vars", "utf8");
		return Object.fromEntries(
			file
				.split(/\r?\n/)
				.filter((line) => line && !line.startsWith("#") && line.includes("="))
				.map((line) => {
					const separator = line.indexOf("=");
					return [line.slice(0, separator), line.slice(separator + 1)];
				}),
		);
	} catch {
		return {};
	}
};

export const localEnv = async () => ({ ...(await fromFile()), ...process.env });
