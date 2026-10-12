export interface OAuthStateRow {
	state_hash: string;
}

export interface CredentialRow {
	encrypted_refresh_token: string;
	updated_at: number;
}

export interface PendingActionRow {
	id: string;
	owner_id: string;
	chat_id: string;
	kind: string;
	payload: string;
	status: string;
	event_id: string | null;
	expires_at: number;
	fence_token: string;
}

const UPDATE_CLAIM_STATUS = {
	CLAIMED: "claimed",
	COMPLETED: "completed",
	RETRY: "retry",
} as const;

export type UpdateClaim =
	| { status: (typeof UPDATE_CLAIM_STATUS)["CLAIMED"]; fenceToken: string }
	| { status: (typeof UPDATE_CLAIM_STATUS)["COMPLETED"] }
	| { status: (typeof UPDATE_CLAIM_STATUS)["RETRY"] };

export const randomId = (): string => crypto.randomUUID().replace(/-/g, "");

export const sha256 = async (value: string): Promise<string> => {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

export class Repository {
	constructor(private readonly db: D1Database) {}

	async saveOAuthState(state: string, now: number): Promise<void> {
		await this.db
			.prepare("INSERT INTO oauth_states(state_hash, expires_at) VALUES (?, ?)")
			.bind(await sha256(state), now + 10 * 60_000)
			.run();
	}

	async consumeOAuthState(state: string, now: number): Promise<boolean> {
		const row = await this.db
			.prepare(
				"UPDATE oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at >= ? RETURNING state_hash",
			)
			.bind(now, await sha256(state), now)
			.first<OAuthStateRow>();
		return row !== null;
	}

	async getCredential(): Promise<CredentialRow | null> {
		return this.db
			.prepare(
				"SELECT encrypted_refresh_token, updated_at FROM google_credentials WHERE account = 'family'",
			)
			.first<CredentialRow>();
	}

	async saveCredential(
		encryptedRefreshToken: string,
		now: number,
	): Promise<void> {
		await this.db
			.prepare(
				"INSERT INTO google_credentials(account, encrypted_refresh_token, updated_at) VALUES ('family', ?, ?) ON CONFLICT(account) DO UPDATE SET encrypted_refresh_token = excluded.encrypted_refresh_token, updated_at = excluded.updated_at",
			)
			.bind(encryptedRefreshToken, now)
			.run();
	}

	async saveConversation(
		userId: string,
		chatId: string,
		draft: string,
		now: number,
	): Promise<void> {
		await this.db
			.prepare(
				"INSERT INTO conversations(user_id, chat_id, draft, expires_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, draft = excluded.draft, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
			)
			.bind(userId, chatId, draft, now + 30 * 60_000, now)
			.run();
	}

	async getConversation(
		userId: string,
		chatId: string,
		now: number,
	): Promise<string | null> {
		const row = await this.db
			.prepare(
				"SELECT draft FROM conversations WHERE user_id = ? AND chat_id = ? AND expires_at >= ?",
			)
			.bind(userId, chatId, now)
			.first<{ draft: string }>();
		return row?.draft ?? null;
	}

	async cancelConversation(userId: string, chatId: string): Promise<void> {
		await this.db
			.prepare("DELETE FROM conversations WHERE user_id = ? AND chat_id = ?")
			.bind(userId, chatId)
			.run();
	}

	async createAction(
		ownerId: string,
		chatId: string,
		kind: string,
		payload: string,
		now: number,
	): Promise<string> {
		const id = randomId();
		await this.db
			.prepare(
				"INSERT INTO pending_actions(id, owner_id, chat_id, kind, payload, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
			)
			.bind(id, ownerId, chatId, kind, payload, now + 15 * 60_000, now)
			.run();
		return id;
	}

	async getAction(
		id: string,
		ownerId: string,
		chatId: string,
	): Promise<PendingActionRow | null> {
		return this.db
			.prepare(
				"SELECT id, owner_id, chat_id, kind, payload, status, event_id, expires_at, COALESCE(fence_token, '') AS fence_token FROM pending_actions WHERE id = ? AND owner_id = ? AND chat_id = ?",
			)
			.bind(id, ownerId, chatId)
			.first<PendingActionRow>();
	}

	async getLatestPendingAction(
		ownerId: string,
		chatId: string,
		kinds: string[],
		now: number,
	): Promise<PendingActionRow | null> {
		if (!kinds.length) return null;
		const placeholders = kinds.map(() => "?").join(", ");
		return this.db
			.prepare(
				`SELECT id, owner_id, chat_id, kind, payload, status, event_id, expires_at, COALESCE(fence_token, '') AS fence_token FROM pending_actions WHERE owner_id = ? AND chat_id = ? AND status = 'pending' AND expires_at >= ? AND kind IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(ownerId, chatId, now, ...kinds)
			.first<PendingActionRow>();
	}

	async updatePendingActionPayload(
		id: string,
		ownerId: string,
		chatId: string,
		payload: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db
			.prepare(
				"UPDATE pending_actions SET payload = ?, expires_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND chat_id = ? AND status = 'pending' AND expires_at >= ?",
			)
			.bind(payload, now + 15 * 60_000, now, id, ownerId, chatId, now)
			.run();
		return (result.meta.changes ?? 0) === 1;
	}

	async claimAction(
		id: string,
		ownerId: string,
		chatId: string,
		kind: string,
		now: number,
	): Promise<PendingActionRow | null> {
		const fenceToken = randomId();
		return this.db
			.prepare(
				"UPDATE pending_actions SET status = 'executing', lease_until = ?, fence_token = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND chat_id = ? AND kind = ? AND ((status = 'pending' AND expires_at >= ?) OR (status IN ('executing', 'uncertain') AND lease_until < ?)) RETURNING id, owner_id, chat_id, kind, payload, status, event_id, expires_at, fence_token",
			)
			.bind(now + 60_000, fenceToken, now, id, ownerId, chatId, kind, now, now)
			.first<PendingActionRow>();
	}

	async finishAction(
		id: string,
		eventId: string | null,
		fenceToken: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db
			.prepare(
				"UPDATE pending_actions SET status = 'done', event_id = ?, lease_until = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'executing' AND fence_token = ?",
			)
			.bind(eventId, now, now, id, fenceToken)
			.run();
		return (result.meta.changes ?? 0) === 1;
	}

	async markActionUncertain(
		id: string,
		fenceToken: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db
			.prepare(
				"UPDATE pending_actions SET status = 'uncertain', lease_until = ?, updated_at = ? WHERE id = ? AND status = 'executing' AND fence_token = ?",
			)
			.bind(now, now, id, fenceToken)
			.run();
		return (result.meta.changes ?? 0) === 1;
	}

	async cancelAction(
		id: string,
		ownerId: string,
		chatId: string,
		now: number,
	): Promise<boolean> {
		const [result] = await this.db.batch([
			this.db
				.prepare(
					"UPDATE pending_actions SET status = 'done', lease_until = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND chat_id = ? AND status = 'pending' AND expires_at >= ?",
				)
				.bind(now, now, id, ownerId, chatId, now),
			this.db
				.prepare(
					"DELETE FROM conversations WHERE user_id = ? AND chat_id = ? AND EXISTS (SELECT 1 FROM pending_actions WHERE id = ? AND owner_id = ? AND chat_id = ? AND status = 'done' AND event_id IS NULL AND completed_at = ?)",
				)
				.bind(ownerId, chatId, id, ownerId, chatId, now),
		]);
		return (result.meta.changes ?? 0) === 1;
	}

	async claimUpdate(updateId: number, now: number): Promise<UpdateClaim> {
		const fenceToken = randomId();
		const inserted = await this.db
			.prepare(
				"INSERT OR IGNORE INTO processed_updates(update_id, status, created_at, updated_at, lease_until, fence_token) VALUES (?, 'processing', ?, ?, ?, ?)",
			)
			.bind(updateId, now, now, now + 60_000, fenceToken)
			.run();
		if ((inserted.meta.changes ?? 0) === 1)
			return { status: UPDATE_CLAIM_STATUS.CLAIMED, fenceToken };
		const row = await this.db
			.prepare("SELECT status FROM processed_updates WHERE update_id = ?")
			.bind(updateId)
			.first<{ status: string }>();
		if (row?.status === "done")
			return { status: UPDATE_CLAIM_STATUS.COMPLETED };
		const recovered = await this.db
			.prepare(
				"UPDATE processed_updates SET updated_at = ?, lease_until = ?, fence_token = ? WHERE update_id = ? AND status = 'processing' AND lease_until < ?",
			)
			.bind(now, now + 60_000, fenceToken, updateId, now)
			.run();
		if ((recovered.meta.changes ?? 0) === 1)
			return { status: UPDATE_CLAIM_STATUS.CLAIMED, fenceToken };
		return { status: UPDATE_CLAIM_STATUS.RETRY };
	}

	async completeUpdate(
		updateId: number,
		fenceToken: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db
			.prepare(
				"UPDATE processed_updates SET status = 'done', updated_at = ?, lease_until = NULL WHERE update_id = ? AND status = 'processing' AND fence_token = ?",
			)
			.bind(now, updateId, fenceToken)
			.run();
		return (result.meta.changes ?? 0) === 1;
	}

	async cleanup(now: number): Promise<void> {
		await this.db
			.prepare(
				"DELETE FROM oauth_states WHERE expires_at < ? AND consumed_at IS NOT NULL",
			)
			.bind(now - 86_400_000)
			.run();
		await this.db
			.prepare("DELETE FROM conversations WHERE expires_at < ?")
			.bind(now - 86_400_000)
			.run();
	}
}
