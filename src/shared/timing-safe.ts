const encoder = new TextEncoder();

/** Constant-time string comparison for secrets (Workers Web Crypto). */
export const timingSafeEqual = (left: string, right: string): boolean => {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	if (a.byteLength !== b.byteLength) return false;
	return crypto.subtle.timingSafeEqual(a, b);
};
