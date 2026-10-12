import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../src/shared/database";

const now = 1_800_000_000_000;
type TestEnv = typeof env & {
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

describe("D1 durable action claims", () => {
	beforeEach(async () => {
		await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM pending_actions"),
			env.DB.prepare("DELETE FROM processed_updates"),
			env.DB.prepare("DELETE FROM conversations"),
		]);
	});

	it("allows one concurrent action claimant and fences stale finishers", async () => {
		const repository = new Repository(env.DB);
		const id = await repository.createAction("100", "100", "create", "{}", now);
		const claims = await Promise.all([
			repository.claimAction(id, "100", "100", "create", now),
			repository.claimAction(id, "100", "100", "create", now),
		]);
		const claim = claims.find((value) => value !== null);
		expect(claim).not.toBeNull();
		expect(claims.filter((value) => value !== null)).toHaveLength(1);
		if (!claim) throw new Error("claim expected");

		await repository.markActionUncertain(id, claim.fence_token, now);
		const reclaimed = await repository.claimAction(
			id,
			"100",
			"100",
			"create",
			now + 1,
		);
		expect(reclaimed).not.toBeNull();
		if (!reclaimed) throw new Error("reclaim expected");
		expect(
			await repository.finishAction(id, "event", claim.fence_token, now),
		).toBe(false);
		expect(
			await repository.finishAction(
				id,
				"event",
				reclaimed.fence_token,
				now + 1,
			),
		).toBe(true);
	});

	it("recovers confirmed uncertainty after preview expiry but never executes expired pending work", async () => {
		const repository = new Repository(env.DB);
		const pending = await repository.createAction(
			"100",
			"100",
			"create",
			"{}",
			now,
		);
		expect(
			await repository.claimAction(
				pending,
				"100",
				"100",
				"create",
				now + 15 * 60_000 + 1,
			),
		).toBeNull();

		const confirmed = await repository.createAction(
			"100",
			"100",
			"create",
			"{}",
			now,
		);
		const claim = await repository.claimAction(
			confirmed,
			"100",
			"100",
			"create",
			now + 1,
		);
		if (!claim) throw new Error("claim expected");
		await repository.markActionUncertain(confirmed, claim.fence_token, now + 1);
		expect(
			await repository.claimAction(
				confirmed,
				"100",
				"100",
				"create",
				now + 15 * 60_000 + 2,
			),
		).not.toBeNull();
	});

	it("cancels only a live owner action and its matching conversation", async () => {
		const repository = new Repository(env.DB);
		await repository.saveConversation("100", "100", "draft", now);
		const id = await repository.createAction("100", "100", "create", "{}", now);
		expect(await repository.cancelAction(id, "200", "200", now)).toBe(false);
		expect(await repository.getConversation("100", "100", now)).toBe("draft");
		expect(await repository.cancelAction(id, "100", "100", now)).toBe(true);
		expect(await repository.getConversation("100", "100", now)).toBeNull();
	});

	it("loads and updates the latest pending create for the same owner chat", async () => {
		const repository = new Repository(env.DB);
		const older = await repository.createAction(
			"100",
			"100",
			"create",
			'{"event":{"summary":"old"}}',
			now,
		);
		const newer = await repository.createAction(
			"100",
			"100",
			"create",
			'{"event":{"summary":"new"}}',
			now + 1,
		);
		await repository.createAction(
			"200",
			"200",
			"create",
			'{"event":{"summary":"other"}}',
			now + 2,
		);
		const latest = await repository.getLatestPendingAction(
			"100",
			"100",
			["create"],
			now + 3,
		);
		expect(latest?.id).toBe(newer);
		expect(latest?.id).not.toBe(older);
		expect(
			await repository.updatePendingActionPayload(
				newer,
				"100",
				"100",
				'{"event":{"summary":"moved"}}',
				now + 3,
			),
		).toBe(true);
		const updated = await repository.getAction(newer, "100", "100");
		expect(updated?.payload).toContain("moved");
		expect(
			await repository.updatePendingActionPayload(
				newer,
				"100",
				"100",
				'{"event":{"summary":"late"}}',
				now + 15 * 60_000 + 10,
			),
		).toBe(false);
	});

	it("fences duplicate Telegram update completion after lease recovery", async () => {
		const repository = new Repository(env.DB);
		const first = await repository.claimUpdate(42, now);
		expect(first.status).toBe("claimed");
		if (first.status !== "claimed") throw new Error("first claim expected");
		const second = await repository.claimUpdate(42, now + 60_001);
		expect(second.status).toBe("claimed");
		if (second.status !== "claimed")
			throw new Error("reclaimed claim expected");
		expect(
			await repository.completeUpdate(42, first.fenceToken, now + 60_001),
		).toBe(false);
		expect(
			await repository.completeUpdate(42, second.fenceToken, now + 60_001),
		).toBe(true);
	});
});
