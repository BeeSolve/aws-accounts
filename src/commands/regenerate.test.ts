import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runRegenerateCommand } from "./regenerate.js";
import { writeAwsConfigFromState } from "../awsConfig.js";
import { createTestWorkspace } from "../helpers.test.js";
import { noopLogger } from "../logger.js";
import { validateState } from "../state.js";

test("runRegenerateCommand returns unchanged when types are current", async () => {
  const workspace = await createTestWorkspace({ prefix: "regenerate-test-" });
  try {
      const contextPath = join(workspace.workspacePath, "aws.context.json");
      const configPath = join(workspace.workspacePath, "aws.config.ts");
      const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
      const { state } = await writeFixtureFiles({
        contextPath,
      });
      await writeAwsConfigFromState({
        state: validateState(state),
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
      const contextPath = join(workspace.workspacePath, "aws.context.json");
      const configPath = join(workspace.workspacePath, "aws.config.ts");
      const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
      const { state } = await writeFixtureFiles({
        contextPath,
      });
      await writeAwsConfigFromState({
        state: validateState(state),
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
  contextPath: string;
}): Promise<{ state: ReturnType<typeof getFixtureState> }> {
  const state = getFixtureState();
  await writeFile(
    props.contextPath,
    `${JSON.stringify(getFixtureContext(), null, 2)}\n`,
    "utf8",
  );
  return { state };
}

function getFixtureState() {
  return {
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
      accounts: [
        {
          id: "111111111111",
          arn: "arn:aws:organizations:::account/111111111111",
          name: "AppAccount",
          email: "app@example.com",
          state: "ACTIVE",
          tags: [],
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
          sessionDuration: null,
          inlinePolicy: null,
          awsManagedPolicies: [],
          customerManagedPolicies: [],
          permissionsBoundary: null,
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
      accessControlAttributes: [],
    },
  };
}

function getFixtureContext() {
  return {
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
}
