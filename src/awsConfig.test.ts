import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  regenerateAwsConfigTypes,
  writeAwsConfigFromState,
} from "./awsConfig.js";
import { createTestWorkspace } from "./helpers.test.js";

test("writeAwsConfigFromState generates aws.config.ts and aws.config.types.ts", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFixtureFiles({
      statePath: statePath,
      contextPath: contextPath,
    });
    let confirmationCalls = 0;
    const result = await writeAwsConfigFromState({
      statePath: statePath,
      contextPath: contextPath,
      configPath: configPath,
      typesPath: typesPath,
      overwriteConfirmation: async () => {
        confirmationCalls += 1;
        return true;
      },
    });

    assert.equal(result.configPath, configPath);
    assert.equal(result.typesPath, typesPath);
    assert.equal(confirmationCalls, 1);

    const configRaw = await readFile(configPath, "utf8");
    const typesRaw = await readFile(typesPath, "utf8");
    assert.match(configRaw, /const awsConfig:/);
    assert.match(typesRaw, /export const awsConfigSchema/);
    assert.match(configRaw, /"name": "root"/);
  } finally {
    await workspace.cleanup();
  }
});

test("writeAwsConfigFromState no-op does not call confirmation", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFixtureFiles({
      statePath: statePath,
      contextPath: contextPath,
    });
    await writeAwsConfigFromState({
      statePath: statePath,
      contextPath: contextPath,
      configPath: configPath,
      typesPath: typesPath,
      overwriteConfirmation: async () => true,
    });

    let confirmationCalls = 0;
    await writeAwsConfigFromState({
      statePath: statePath,
      contextPath: contextPath,
      configPath: configPath,
      typesPath: typesPath,
      overwriteConfirmation: async () => {
        confirmationCalls += 1;
        return true;
      },
    });
    assert.equal(confirmationCalls, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("writeAwsConfigFromState fails on context mismatch", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFixtureFiles({
      statePath: statePath,
      contextPath: contextPath,
    });
    const contextRaw = await readFile(contextPath, "utf8");
    const context = JSON.parse(contextRaw) as {
      organization: { pendingOuId: string };
    };
    context.organization.pendingOuId = "ou-pending-mismatch";
    await writeFile(
      contextPath,
      `${JSON.stringify(context, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      () =>
        writeAwsConfigFromState({
          statePath: statePath,
          contextPath: contextPath,
          configPath: configPath,
          typesPath: typesPath,
          overwriteConfirmation: async () => true,
        }),
      /Pending OU id/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("regenerateAwsConfigTypes reports no changes when types are up to date", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFixtureFiles({
      statePath: statePath,
      contextPath: contextPath,
    });
    await writeAwsConfigFromState({
      statePath: statePath,
      contextPath: contextPath,
      configPath: configPath,
      typesPath: typesPath,
      overwriteConfirmation: async () => true,
    });

    let confirmationCalls = 0;
    const result = await regenerateAwsConfigTypes({
      configPath: configPath,
      typesPath: typesPath,
      overwriteConfirmation: async () => {
        confirmationCalls += 1;
        return true;
      },
    });
    assert.equal(result.changed, false);
    assert.equal(confirmationCalls, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("regenerateAwsConfigTypes writes when types are stale", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFixtureFiles({
      statePath: statePath,
      contextPath: contextPath,
    });
    await writeAwsConfigFromState({
      statePath: statePath,
      contextPath: contextPath,
      configPath: configPath,
      typesPath: typesPath,
      overwriteConfirmation: async () => true,
    });

    const previousTypes = await readFile(typesPath, "utf8");
    await writeFile(typesPath, `// stale\n${previousTypes}`, "utf8");
    const result = await regenerateAwsConfigTypes({
      configPath: configPath,
      typesPath: typesPath,
      overwriteConfirmation: async () => true,
    });
    assert.equal(result.changed, true);
    const nextTypes = await readFile(typesPath, "utf8");
    assert.match(nextTypes, /Generated file\. Do not edit by hand\./);
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
          emails: ["alice@example.com"],
        },
      ],
      groups: [
        {
          groupId: "g-123",
          displayName: "Admins",
        },
      ],
      permissionSets: [
        {
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          name: "AdminAccess",
          description: "Admin",
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
    writeFile(
      props.contextPath,
      `${JSON.stringify(context, null, 2)}\n`,
      "utf8",
    ),
  ]);
}
