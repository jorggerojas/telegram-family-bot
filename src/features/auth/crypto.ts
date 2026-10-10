const encoder = new TextEncoder();
const decoder = new TextDecoder();

const decodeBase64 = (value: string): Uint8Array =>
	Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const encodeBase64 = (value: ArrayBuffer): string =>
	btoa(String.fromCharCode(...new Uint8Array(value)));

const keyFor = (base64Key: string): Promise<CryptoKey> =>
	crypto.subtle.importKey("raw", decodeBase64(base64Key), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);

export const encryptSecret = async (
	value: string,
	base64Key: string,
): Promise<string> => {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await keyFor(base64Key),
		encoder.encode(value),
	);
	return `${encodeBase64(iv.buffer)}.${encodeBase64(ciphertext)}`;
};

export const decryptSecret = async (
	value: string,
	base64Key: string,
): Promise<string> => {
	const [iv, ciphertext] = value.split(".");
	if (!iv || !ciphertext) throw new Error("Encrypted secret is malformed.");
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: decodeBase64(iv) },
		await keyFor(base64Key),
		decodeBase64(ciphertext),
	);
	return decoder.decode(plaintext);
};
