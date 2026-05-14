import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import fc from "fast-check";
import { readStateCache, writeStateCache, isCacheFresh } from "./remoteStateCache.js";
import type { StateFile } from "./state.js";
import type { StateCacheFile } from "./remoteStateCache.js";

// --- Generators ---

/** Generate a non-empty string (matching the nonEmptyString schema in state.ts) */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

/** Generate a valid OrganizationalUnit */
const organizationalUnitArb = fc.record({
  id: nonEmptyStringArb,
  parentId: nonEmptyStringArb,
  arn: nonEmptyStringArb,
  name: nonEmptyStringArb,
});

/** Generate a valid AccountTag */
const accountTagArb = fc.record({
  key: nonEmptyStringArb,
  value: fc.string({ maxLength: 50 }),
});

/** Generate a valid Account */
const accountArb = fc.record({
  id: nonEmptyStringArb,
  arn: nonEmptyStringArb,
  name: nonEmptyStringArb,
  email: nonEmptyStringArb,
  status: nonEmptyStringArb,
  parentId: nonEmptyStringArb,
  tags: fc.array(accountTagArb, { maxLength: 5 }),
});

/** Generate a valid User */
const userArb = fc.record({
  userId: nonEmptyStringArb,
  userName: nonEmptyStringArb,
  displayName: fc.string({ maxLength: 50 }),
  email: fc.string({ maxLength: 50 }),
});

/** Generate a valid Group */
const groupArb = fc.record({
  groupId: nonEmptyStringArb,
  displayName: nonEmptyStringArb,
  description: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
});

/** Generate a valid GroupMembership */
const groupMembershipArb = fc.record({
  membershipId: nonEmptyStringArb,
  groupId: nonEmptyStringArb,
  userId: nonEmptyStringArb,
});

/** Generate a valid CustomerManagedPolicyReference */
const customerManagedPolicyReferenceArb = fc.record({
  name: nonEmptyStringArb,
  path: nonEmptyStringArb,
});

/** Generate a valid PermissionSet */
const permissionSetArb = fc.record({
  permissionSetArn: nonEmptyStringArb,
  name: nonEmptyStringArb,
  description: fc.string({ maxLength: 50 }),
  inlinePolicy: fc.option(nonEmptyStringArb, { nil: null }),
  awsManagedPolicies: fc.array(nonEmptyStringArb, { maxLength: 3 }),
  customerManagedPolicies: fc.array(customerManagedPolicyReferenceArb, { maxLength: 3 }),
});

/** Generate a valid AccountAssignment */
const accountAssignmentArb = fc.record({
  accountId: nonEmptyStringArb,
  permissionSetArn: nonEmptyStringArb,
  principalId: nonEmptyStringArb,
  principalType: fc.constantFrom("GROUP" as const, "USER" as const),
});

/** Generate a valid AccessRole */
const accessRoleArb = fc.record({
  accountId: nonEmptyStringArb,
  permissionSetArn: nonEmptyStringArb,
  principalId: nonEmptyStringArb,
  principalType: fc.constantFrom("GROUP" as const, "USER" as const),
  roleName: nonEmptyStringArb,
});

/** Generate a valid StateFile */
const stateFileArb: fc.Arbitrary<StateFile> = fc.record({
  version: nonEmptyStringArb,
  generatedAt: nonEmptyStringArb,
  organization: fc.record({
    rootId: nonEmptyStringArb,
    organizationalUnits: fc.array(organizationalUnitArb, { maxLength: 5 }),
    accounts: fc.array(accountArb, { maxLength: 5 }),
  }),
  identityCenter: fc.record({
    instanceArn: nonEmptyStringArb,
    identityStoreId: nonEmptyStringArb,
    users: fc.array(userArb, { maxLength: 5 }),
    groups: fc.array(groupArb, { maxLength: 5 }),
    groupMemberships: fc.array(groupMembershipArb, { maxLength: 5 }),
    permissionSets: fc.array(permissionSetArb, { maxLength: 3 }),
    accountAssignments: fc.array(accountAssignmentArb, { maxLength: 5 }),
    accessRoles: fc.array(accessRoleArb, { maxLength: 5 }),
  }),
});

// --- Property Tests ---

/**
 * Feature: remote-execution-v2, Property 2: Cache freshness determination
 *
 * For any timestamp and TTL, isCacheFresh returns true iff elapsed ≤ TTL.
 *
 * **Validates: Requirements 5.1, 5.2, 7.3**
 */
test("Property 2: Cache freshness determination — isCacheFresh returns true iff elapsed ≤ TTL", () => {
  const minimalState: StateFile = {
    version: "1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [],
      accounts: [],
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-1",
      identityStoreId: "d-1",
      users: [],
      groups: [],
      groupMemberships: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: [],
    },
  };

  // Generate elapsed time in ms and TTL in seconds.
  // We use a fixed "now" reference to make assertions deterministic.
  const elapsedMsArb = fc.integer({ min: 0, max: 10_000_000 }); // 0 to ~2.7 hours in ms
  const ttlSecondsArb = fc.integer({ min: 0, max: 10_000 }); // 0 to ~2.7 hours in seconds

  fc.assert(
    fc.property(elapsedMsArb, ttlSecondsArb, (elapsedMs, ttlSeconds) => {
      // Create a fetchedAt timestamp that is exactly `elapsedMs` milliseconds before a fixed reference point.
      const now = 1_700_000_000_000; // fixed reference point
      const fetchedAtMs = now - elapsedMs;
      const fetchedAt = new Date(fetchedAtMs).toISOString();

      const cache: StateCacheFile = {
        fetchedAt,
        state: minimalState,
      };

      // Monkey-patch Date.now to return our fixed reference point
      const originalDateNow = Date.now;
      Date.now = () => now;
      try {
        const result = isCacheFresh(cache, ttlSeconds);
        const expected = elapsedMs <= ttlSeconds * 1000;
        assert.equal(result, expected,
          `elapsed=${elapsedMs}ms, ttl=${ttlSeconds}s (${ttlSeconds * 1000}ms): expected ${expected}, got ${result}`);
      } finally {
        Date.now = originalDateNow;
      }
    }),
    { numRuns: 200 },
  );
});

/**
 * Feature: remote-execution-v2, Property 3: State cache round-trip
 *
 * For any valid StateFile, write then read produces identical object.
 *
 * **Validates: Requirements 5.5, 7.2**
 */
test("Property 3: State cache round-trip — write then read produces identical StateFile", async () => {
  await fc.assert(
    fc.asyncProperty(stateFileArb, async (generatedState) => {
      // Normalize through JSON round-trip to match real-world usage:
      // real StateFile objects always come from JSON.parse (API responses, file reads).
      // fast-check generates objects with null prototypes that wouldn't exist in practice.
      const state: StateFile = JSON.parse(JSON.stringify(generatedState));

      const cachePath = join(tmpdir(), `pbt-cache-${randomUUID()}.json`);
      try {
        await writeStateCache(cachePath, state);
        const result = await readStateCache(cachePath);

        assert.notEqual(result, null, "readStateCache should not return null after write");
        assert.deepEqual(result!.state, state, "Round-trip state should be identical");
        assert.equal(typeof result!.fetchedAt, "string", "fetchedAt should be a string");
        // Verify fetchedAt is a valid ISO timestamp
        const parsedDate = new Date(result!.fetchedAt);
        assert.ok(!isNaN(parsedDate.getTime()), "fetchedAt should be a valid ISO timestamp");
      } finally {
        await unlink(cachePath).catch(() => {});
      }
    }),
    { numRuns: 100 },
  );
});
