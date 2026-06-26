import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestWorkspace } from "../helpers.test.js";
import type { Logger } from "../logger.js";
import { runGraveyardCloseCommand, runGraveyardCommand } from "./graveyard.js";

test("runGraveyardCommand lists graveyard accounts with close command hints", async () => {
  const workspace = await createTestWorkspace({ prefix: "graveyard-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFixtureFiles({
      cachePath,
      contextPath,
      graveyardAccounts: [
        {
          id: "111111111111",
          name: "OldApp",
          email: "old-app@example.com",
          state: "ACTIVE",
        },
      ],
    });
    const logger = createCollectingLogger();
    const result = await runGraveyardCommand({
      logger,
      cachePath,
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
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFixtureFiles({
      cachePath,
      contextPath,
      graveyardAccounts: [],
    });
    const logger = createCollectingLogger();
    const result = await runGraveyardCommand({
      logger,
      cachePath,
      contextPath,
    });
    assert.equal(result.accounts.length, 0);
    assert.ok(
      logger.logs.some((line) => line.includes("No accounts currently parked in Graveyard.")),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runGraveyardCommand throws error when cache file does not exist", async () => {
  const workspace = await createTestWorkspace({ prefix: "graveyard-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    // Write only the context file, not the cache file
    const context = {
      version: "1",
      generatedAt: "2026-05-01T00:00:00.000Z",
      organization: {
        id: "o-test123",
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
        cliVersion: "0.0.0-test",
      },
    };
    await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
    const logger = createCollectingLogger();
    await assert.rejects(
      () => runGraveyardCommand({ logger, cachePath, contextPath }),
      (error: Error) => {
        assert.ok(error.message.includes("No remote state cache found"));
        assert.ok(error.message.includes(cachePath));
        return true;
      },
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runGraveyardCloseCommand outputs close commands for ACTIVE accounts only", async () => {
  const workspace = await createTestWorkspace({ prefix: "graveyard-close-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFixtureFiles({
      cachePath,
      contextPath,
      graveyardAccounts: [
        { id: "111111111111", name: "OldApp", email: "old@example.com", state: "ACTIVE" },
        { id: "222222222222", name: "Archived", email: "arch@example.com", state: "SUSPENDED" },
      ],
    });
    const logger = createCollectingLogger();
    await runGraveyardCloseCommand({ logger, cachePath, contextPath });
    const output = logger.logs.join("\n");
    assert.ok(output.includes("aws organizations close-account --account-id 111111111111"));
    assert.ok(!output.includes("222222222222"), "SUSPENDED accounts must not appear");
  } finally {
    await workspace.cleanup();
  }
});

test("runGraveyardCloseCommand prints no-eligible message when all accounts are SUSPENDED", async () => {
  const workspace = await createTestWorkspace({ prefix: "graveyard-close-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFixtureFiles({
      cachePath,
      contextPath,
      graveyardAccounts: [
        { id: "333333333333", name: "Gone", email: "gone@example.com", state: "SUSPENDED" },
      ],
    });
    const logger = createCollectingLogger();
    await runGraveyardCloseCommand({ logger, cachePath, contextPath });
    assert.ok(logger.logs.some((l) => l.includes("No accounts eligible for closure")));
  } finally {
    await workspace.cleanup();
  }
});

test("runGraveyardCloseCommand outputs accounts sorted alphabetically", async () => {
  const workspace = await createTestWorkspace({ prefix: "graveyard-close-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFixtureFiles({
      cachePath,
      contextPath,
      graveyardAccounts: [
        { id: "222222222222", name: "Zeta", email: "z@example.com", state: "ACTIVE" },
        { id: "111111111111", name: "Alpha", email: "a@example.com", state: "ACTIVE" },
      ],
    });
    const logger = createCollectingLogger();
    await runGraveyardCloseCommand({ logger, cachePath, contextPath });
    const alphaIdx = logger.logs.findIndex((l) => l.includes("111111111111"));
    const zetaIdx = logger.logs.findIndex((l) => l.includes("222222222222"));
    assert.ok(alphaIdx < zetaIdx, "Alpha must appear before Zeta");
  } finally {
    await workspace.cleanup();
  }
});

test("runGraveyardCloseCommand throws error when cache file does not exist", async () => {
  const workspace = await createTestWorkspace({ prefix: "graveyard-close-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const context = {
      version: "1",
      generatedAt: "2026-05-01T00:00:00.000Z",
      organization: {
        id: "o-test123",
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
        cliVersion: "0.0.0-test",
      },
    };
    await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
    const logger = createCollectingLogger();
    await assert.rejects(
      () => runGraveyardCloseCommand({ logger, cachePath, contextPath }),
      (error: Error) => {
        assert.ok(error.message.includes("No remote state cache found"));
        return true;
      },
    );
  } finally {
    await workspace.cleanup();
  }
});

async function writeFixtureFiles(props: {
  cachePath: string;
  contextPath: string;
  graveyardAccounts: Array<{
    id: string;
    name: string;
    email: string;
    state: string;
  }>;
}): Promise<void> {
  const state = {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      organizationId: "o-test123",
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
        state: account.state,
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
      accessControlAttributes: [],
    },
  };
  const cache = {
    fetchedAt: "2026-05-01T00:00:00.000Z",
    state,
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
  const write = (...args: Array<any>): void => {
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
