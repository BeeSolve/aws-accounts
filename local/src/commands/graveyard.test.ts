import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestWorkspace } from "../helpers.test.js";
import type { Logger } from "../logger.js";
import { runGraveyardCommand } from "./graveyard.js";

test("runGraveyardCommand lists graveyard accounts with close command hints", async () => {
  const workspace = await createTestWorkspace({ prefix: "graveyard-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFixtureFiles({
      statePath,
      contextPath,
      graveyardAccounts: [
        {
          id: "111111111111",
          name: "OldApp",
          email: "old-app@example.com",
          status: "ACTIVE",
        },
      ],
    });
    const logger = createCollectingLogger();
    const result = await runGraveyardCommand({
      logger,
      statePath,
      contextPath,
    });
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]?.id, "111111111111");
    assert.ok(
      logger.logs.some((line) =>
        line.includes("aws organizations close-account --account-id 111111111111"),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runGraveyardCommand prints empty state message", async () => {
  const workspace = await createTestWorkspace({ prefix: "graveyard-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFixtureFiles({
      statePath,
      contextPath,
      graveyardAccounts: [],
    });
    const logger = createCollectingLogger();
    const result = await runGraveyardCommand({
      logger,
      statePath,
      contextPath,
    });
    assert.equal(result.accounts.length, 0);
    assert.ok(
      logger.logs.some((line) =>
        line.includes("No accounts currently parked in Graveyard."),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

async function writeFixtureFiles(props: {
  statePath: string;
  contextPath: string;
  graveyardAccounts: Array<{
    id: string;
    name: string;
    email: string;
    status: string;
  }>;
}): Promise<void> {
  const state = {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [
        {
          id: "ou-pending",
          parentId: "r-root",
          arn: "arn:aws:organizations:::ou/pending",
          name: "Pending",
        },
        {
          id: "ou-graveyard",
          parentId: "r-root",
          arn: "arn:aws:organizations:::ou/graveyard",
          name: "Graveyard",
        },
      ],
      accounts: props.graveyardAccounts.map((account) => ({
        id: account.id,
        arn: `arn:aws:organizations:::account/${account.id}`,
        name: account.name,
        email: account.email,
        status: account.status,
        tags: [],
        parentId: "ou-graveyard",
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
    },
  };
  const context = {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      managementAccountId: "999999999999",
      rootId: "r-root",
      graveyardOuId: "ou-graveyard",
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
    },
    deployment: {
      profile: "default",
      region: "eu-central-1",
      lambdaArn: "",
      stateBucketName: "",
      stateCacheTtlSeconds: 300,
    },
  };
  await Promise.all([
    writeFile(props.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    writeFile(props.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8"),
  ]);
}

function createCollectingLogger(): Logger & { logs: string[] } {
  const logs: string[] = [];
  const write = (...args: any[]): void => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    log: write,
    info: write,
    warn: write,
    error: write,
    debug: write,
    trace: write,
    logs,
  };
}
