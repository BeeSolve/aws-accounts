import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fc from "fast-check";

import type { Logger } from "../logger.js";
import { runGraveyardCloseCommand } from "./graveyard.js";

const nonEmptyStringArb = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

const accountIdArb = fc.stringMatching(/^\d{12}$/);

const accountArb = fc.record({
  id: accountIdArb,
  name: nonEmptyStringArb,
  state: fc.constantFrom("ACTIVE" as const, "SUSPENDED" as const),
  parentId: fc.constantFrom("ou-graveyard", "ou-other"),
});

/**
 * Property 4: Graveyard close safety
 *
 * For any mix of ACTIVE/SUSPENDED accounts in and out of the graveyard OU,
 * runGraveyardCloseCommand only emits closure commands for ACTIVE graveyard accounts.
 *
 * Validates: Requirements 8.1, 8.2
 */
test("Property 4: Graveyard close safety — only ACTIVE graveyard accounts produce closure commands", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(accountArb, { selector: (a) => a.id, maxLength: 10 }),
      async (accounts) => {
        const cachePath = join(tmpdir(), `pbt-graveyard-${randomUUID()}.json`);
        const contextPath = join(tmpdir(), `pbt-graveyard-ctx-${randomUUID()}.json`);
        try {
          await writeFixtures({ cachePath, contextPath, accounts });
          const logger = createCollectingLogger();
          await runGraveyardCloseCommand({ logger, cachePath, contextPath });
          const output = logger.logs.join("\n");

          for (const account of accounts) {
            const appearsInOutput = output.includes(`--account-id ${account.id}`);
            const shouldAppear = account.parentId === "ou-graveyard" && account.state === "ACTIVE";
            assert.equal(
              appearsInOutput,
              shouldAppear,
              `account ${account.id} (parentId=${account.parentId}, state=${account.state}): expected in output=${shouldAppear}`,
            );
          }
        } finally {
          await Promise.all([
            unlink(cachePath).catch(() => {}),
            unlink(contextPath).catch(() => {}),
          ]);
        }
      },
    ),
    { numRuns: 100 },
  );
});

async function writeFixtures(props: {
  cachePath: string;
  contextPath: string;
  accounts: Array<{ id: string; name: string; state: string; parentId: string }>;
}): Promise<void> {
  const cache = {
    fetchedAt: "2026-05-01T00:00:00.000Z",
    state: {
      version: "1",
      generatedAt: "2026-05-01T00:00:00.000Z",
      organization: {
        organizationId: "o-test123",
        rootId: "r-root",
        organizationalUnits: [
          {
            id: "ou-graveyard",
            parentId: "r-root",
            arn: "arn:aws:organizations:::ou/graveyard",
            name: "Graveyard",
          },
          {
            id: "ou-other",
            parentId: "r-root",
            arn: "arn:aws:organizations:::ou/other",
            name: "Other",
          },
        ],
        accounts: props.accounts.map((a) => ({
          id: a.id,
          arn: `arn:aws:organizations:::account/${a.id}`,
          name: a.name,
          email: `${a.id}@example.com`,
          state: a.state,
          parentId: a.parentId,
          tags: [],
        })),
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
    },
  };

  const context = {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      id: "o-test123",
      managementAccountId: "999999999999",
      rootId: "r-root",
      graveyardOuId: "ou-graveyard",
    },
    identityCenter: { instanceArn: "arn:aws:sso:::instance/ssoins-123", identityStoreId: "d-123" },
    deployment: {
      profile: "default",
      region: "eu-central-1",
      lambdaArn: "",
      stateBucketName: "",
      stateCacheTtlSeconds: 300,
      cliVersion: "0.0.0-test",
    },
  };

  await Promise.all([
    writeFile(props.cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8"),
    writeFile(props.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8"),
  ]);
}

function createCollectingLogger(): Logger & { logs: Array<string> } {
  const logs: Array<string> = [];
  const write = (...args: Array<unknown>): void => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  return { log: write, info: write, warn: write, error: write, debug: write, trace: write, logs };
}
