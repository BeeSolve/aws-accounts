import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readStateCache, writeStateCache, isCacheFresh } from "./remoteStateCache.js";
import type { StateFile } from "./state.js";

function createSampleState(): StateFile {
  return {
    version: "1",
    generatedAt: "2026-05-06T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [
        { id: "ou-a", parentId: "r-root", arn: "arn:1", name: "Alpha" },
      ],
      accounts: [
        { id: "111111111111", arn: "arn:1", name: "A", email: "a@example.com", status: "ACTIVE", tags: [], parentId: "ou-a" },
      ],
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [],
      groups: [],
      groupMemberships: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: [],
      accessControlAttributes: [],
    },
  };
}

function getTmpCachePath(): string {
  return join(tmpdir(), `test-cache-${randomUUID()}.json`);
}

test("writeStateCache writes valid JSON with fetchedAt timestamp", async () => {
  const cachePath = getTmpCachePath();
  const state = createSampleState();

  await writeStateCache(cachePath, state);

  const content = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(typeof content.fetchedAt, "string");
  assert.ok(new Date(content.fetchedAt).getTime() > 0);
  assert.deepEqual(content.state, state);

  await unlink(cachePath);
});

test("readStateCache returns the written state", async () => {
  const cachePath = getTmpCachePath();
  const state = createSampleState();

  await writeStateCache(cachePath, state);
  const result = await readStateCache(cachePath);

  assert.notEqual(result, null);
  assert.deepEqual(result!.state, state);
  assert.equal(typeof result!.fetchedAt, "string");

  await unlink(cachePath);
});

test("readStateCache returns null for non-existent file", async () => {
  const cachePath = getTmpCachePath();
  const result = await readStateCache(cachePath);
  assert.equal(result, null);
});

test("readStateCache returns null for invalid JSON", async () => {
  const cachePath = getTmpCachePath();
  const { writeFile: writeFileFs } = await import("node:fs/promises");
  await writeFileFs(cachePath, "not valid json", "utf8");

  const result = await readStateCache(cachePath);
  assert.equal(result, null);

  await unlink(cachePath);
});

test("readStateCache returns null for valid JSON with invalid state", async () => {
  const cachePath = getTmpCachePath();
  const { writeFile: writeFileFs } = await import("node:fs/promises");
  await writeFileFs(cachePath, JSON.stringify({ fetchedAt: "2026-01-01T00:00:00.000Z", state: { invalid: true } }), "utf8");

  const result = await readStateCache(cachePath);
  assert.equal(result, null);

  await unlink(cachePath);
});

test("isCacheFresh returns true when cache is within TTL", () => {
  const now = new Date();
  const cache = {
    fetchedAt: now.toISOString(),
    state: createSampleState(),
  };

  assert.equal(isCacheFresh(cache, 300), true);
});

test("isCacheFresh returns false when cache exceeds TTL", () => {
  const pastDate = new Date(Date.now() - 600_000); // 10 minutes ago
  const cache = {
    fetchedAt: pastDate.toISOString(),
    state: createSampleState(),
  };

  assert.equal(isCacheFresh(cache, 300), false);
});

test("isCacheFresh returns true when elapsed equals TTL exactly", () => {
  // Use a timestamp just barely within TTL to avoid clock drift between
  // the two Date.now() calls (test setup vs isCacheFresh internals).
  const ttl = 60;
  const justWithinTtl = new Date(Date.now() - ttl * 1000 + 10);
  const cache = {
    fetchedAt: justWithinTtl.toISOString(),
    state: createSampleState(),
  };

  // elapsed <= TTL should be true
  assert.equal(isCacheFresh(cache, ttl), true);
});

test("isCacheFresh returns false when TTL is 0 and cache is not from the future", () => {
  const pastDate = new Date(Date.now() - 1000); // 1 second ago
  const cache = {
    fetchedAt: pastDate.toISOString(),
    state: createSampleState(),
  };

  assert.equal(isCacheFresh(cache, 0), false);
});
