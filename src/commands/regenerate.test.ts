import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runRegenerateCommand } from "./regenerate.js";
import { writeAwsConfigFromState } from "../awsConfig.js";
import { createTestWorkspace } from "../helpers.test.js";
import { noopLogger } from "../logger.js";

test("runRegenerateCommand returns unchanged when types are current", async () => {
  const workspace = await createTestWorkspace({ prefix: "regenerate-test-" });
  try {
      const statePath = join(workspace.workspacePath, "state.json");
      const contextPath = join(workspace.workspacePath, "aws.context.json");
      const configPath = join(workspace.workspacePath, "aws.config.ts");
      const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
      await writeFixtureFiles({
        statePath,
        contextPath,
      });
      await writeAwsConfigFromState({
        statePath,
        contextPath,
        configPath,
        typesPath,
        logger: noopLogger,
        overwriteConfirmation: async () => true,
      });

      let confirmationCalls = 0;
      const result = await runRegenerateCommand({
        logger: noopLogger,
        configPath,
        typesPath,
        overwriteConfirmation: async () => {
          confirmationCalls += 1;
          return true;
        },
      });
      assert.equal(result.typesPath, typesPath);
      assert.equal(result.changed, false);
      assert.deepEqual(result.files, [{ path: typesPath, status: "unchanged" }]);
      assert.equal(confirmationCalls, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("runRegenerateCommand writes updated types when stale", async () => {
  const workspace = await createTestWorkspace({ prefix: "regenerate-test-" });
  try {
      const statePath = join(workspace.workspacePath, "state.json");
      const contextPath = join(workspace.workspacePath, "aws.context.json");
      const configPath = join(workspace.workspacePath, "aws.config.ts");
      const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
      await writeFixtureFiles({
        statePath,
        contextPath,
      });
      await writeAwsConfigFromState({
        statePath,
        contextPath,
        configPath,
        typesPath,
        logger: noopLogger,
        overwriteConfirmation: async () => true,
      });

      const previousTypes = await readFile(typesPath, "utf8");
      await writeFile(typesPath, `// stale\n${previousTypes}`, "utf8");
      const result = await runRegenerateCommand({
        logger: noopLogger,
        configPath,
        typesPath,
        overwriteConfirmation: async () => true,
      });
      assert.equal(result.changed, true);
      assert.deepEqual(result.files, [{ path: typesPath, status: "written" }]);
      const typesRaw = await readFile(typesPath, "utf8");
      assert.match(typesRaw, /Generated file\. Do not edit by hand\./);
  } finally {
    await workspace.cleanup();
  }
});

async function writeFixtureFiles(props: {
  statePath: string;
  contextPath: string;
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
      accounts: [
        {
          id: "111111111111",
          arn: "arn:aws:organizations:::account/111111111111",
          name: "AppAccount",
          email: "app@example.com",
          status: "ACTIVE",
          parentId: "ou-pending",
        },
      ],
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [
        {
          userId: "u-123",
          userName: "alice",
          displayName: "Alice",
          email: "alice@example.com",
        },
      ],
      groups: [
        {
          groupId: "g-123",
          displayName: "Admins",
        },
      ],
      groupMemberships: [],
      permissionSets: [
        {
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          name: "AdminAccess",
          description: "Admin",
          inlinePolicy: null,
          awsManagedPolicies: [],
          customerManagedPolicies: [],
        },
      ],
      accountAssignments: [
        {
          accountId: "111111111111",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          principalId: "g-123",
          principalType: "GROUP",
        },
      ],
      accessRoles: [],
    },
  };
  const context = {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      managementAccountId: "999999999999",
      rootId: "r-root",
      pendingOuId: "ou-pending",
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
    },
  };
  await Promise.all([
    writeFile(props.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    writeFile(props.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8"),
  ]);
}
