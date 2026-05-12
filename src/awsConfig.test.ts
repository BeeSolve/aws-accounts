import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
  regenerateAwsConfigTypes,
  writeAwsConfigFromState,
} from "./awsConfig.js";
import { createTestWorkspace } from "./helpers.test.js";
import { noopLogger } from "./logger.js";
import { readStateFile } from "./state.js";

test("writeAwsConfigFromState generates aws.config.ts and aws.config.types.ts", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFixtureFiles({
      statePath,
      contextPath,
    });
    let confirmationCalls = 0;
    const result = await writeAwsConfigFromState({
      statePath,
      contextPath,
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => {
        confirmationCalls += 1;
        return true;
      },
    });

    assert.equal(result.configPath, configPath);
    assert.equal(result.typesPath, typesPath);
    assert.deepEqual(result.files, [
      { path: configPath, status: "written" },
      { path: typesPath, status: "written" },
    ]);
    assert.equal(confirmationCalls, 1);

    const configRaw = await readFile(configPath, "utf8");
    const typesRaw = await readFile(typesPath, "utf8");
    assert.match(configRaw, /const awsConfig:/);
    assert.match(typesRaw, /export const awsConfigSchema/);
    assert.match(configRaw, /"name": "root"/);
    assert.match(configRaw, /"members": \[/);
    assert.match(configRaw, /"alice"/);
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
    const result = await writeAwsConfigFromState({
      statePath,
      contextPath,
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => {
        confirmationCalls += 1;
        return true;
      },
    });
    assert.deepEqual(result.files, [
      { path: configPath, status: "unchanged" },
      { path: typesPath, status: "unchanged" },
    ]);
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
      statePath,
      contextPath,
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
          statePath,
          contextPath,
          configPath,
          typesPath,
          logger: noopLogger,
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
    const result = await regenerateAwsConfigTypes({
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => {
        confirmationCalls += 1;
        return true;
      },
    });
    assert.equal(result.changed, false);
    assert.deepEqual(result.files, [{ path: typesPath, status: "unchanged" }]);
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
    const result = await regenerateAwsConfigTypes({
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.files, [{ path: typesPath, status: "written" }]);
    const nextTypes = await readFile(typesPath, "utf8");
    assert.match(nextTypes, /Generated file\. Do not edit by hand\./);
  } finally {
    await workspace.cleanup();
  }
});

test("writeAwsConfigFromState reports would-write when confirmation is rejected", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFixtureFiles({
      statePath,
      contextPath,
    });
    const result = await writeAwsConfigFromState({
      statePath,
      contextPath,
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => false,
    });
    assert.deepEqual(result.files, [
      { path: configPath, status: "would-write" },
      { path: typesPath, status: "would-write" },
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test("regenerateAwsConfigTypes reports would-write when confirmation is rejected", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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
    const result = await regenerateAwsConfigTypes({
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => false,
    });
    assert.equal(result.changed, false);
    assert.deepEqual(result.files, [{ path: typesPath, status: "would-write" }]);
  } finally {
    await workspace.cleanup();
  }
});

test("mapAwsConfigToState emits sentinel ids for entities missing in current state", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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

    const [config, currentState, context] = await Promise.all([
      loadAwsConfigModelFromTsFile({
        configPath,
        typesPath,
      }),
      readStateFile(statePath),
      readAwsContextFromFile(contextPath),
    ]);
    config.organizationalUnits.push({
      name: "Sandbox",
      parentName: "root",
      accounts: [{ name: "SandboxAccount", email: "sandbox@example.com" }],
    });
    config.users.push({
      userName: "bob",
      displayName: "Bob",
      email: "bob@example.com",
    });
    config.groups.push({
      displayName: "Operators",
      members: [],
    });
    config.permissionSets.push({
      name: "ReadOnly",
      description: "Read-only access",
    });
    config.assignments.push({
      permissionSet: "ReadOnly",
      user: "bob",
      accounts: ["SandboxAccount"],
    });

    const mapped = mapAwsConfigToState({
      config,
      currentState,
      context,
    });

    assert.equal(
      mapped.organization.organizationalUnits.some(
        (ou) => ou.name === "Sandbox" && ou.id === "__pending_creation__",
      ),
      true,
    );
    assert.equal(
      mapped.organization.accounts.some(
        (account) =>
          account.name === "SandboxAccount" &&
          account.id === "__pending_creation__" &&
          account.arn === "__pending_creation__",
      ),
      true,
    );
    assert.equal(
      mapped.identityCenter.users.some(
        (user) =>
          user.userName === "bob" && user.userId === "__pending_creation__",
      ),
      true,
    );
    assert.equal(
      mapped.identityCenter.permissionSets.some(
        (permissionSet) =>
          permissionSet.name === "ReadOnly" &&
          permissionSet.permissionSetArn === "__pending_creation__",
      ),
      true,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("mapAwsConfigToState resolves synthetic root parent from context rootId", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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

    const [config, currentState, context] = await Promise.all([
      loadAwsConfigModelFromTsFile({
        configPath,
        typesPath,
      }),
      readStateFile(statePath),
      readAwsContextFromFile(contextPath),
    ]);
    context.organization.rootId = "r-alt-root";

    const mapped = mapAwsConfigToState({
      config,
      currentState,
      context,
    });

    assert.equal(mapped.organization.rootId, "r-alt-root");
    const topLevelOus = mapped.organization.organizationalUnits.filter(
      (ou) => ou.parentId === "r-alt-root",
    );
    assert.equal(topLevelOus.length > 0, true);
  } finally {
    await workspace.cleanup();
  }
});

test("mapAwsConfigToState keeps existing ids for unchanged config entities", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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

    const [config, currentState, context] = await Promise.all([
      loadAwsConfigModelFromTsFile({
        configPath,
        typesPath,
      }),
      readStateFile(statePath),
      readAwsContextFromFile(contextPath),
    ]);

    const mapped = mapAwsConfigToState({
      config,
      currentState,
      context,
    });

    assert.equal(
      mapped.organization.accounts.some(
        (account) =>
          account.name === "AppAccount" && account.id === "111111111111",
      ),
      true,
    );
    assert.equal(
      mapped.organization.organizationalUnits.some(
        (ou) => ou.name === "Pending" && ou.id === "ou-pending",
      ),
      true,
    );
    assert.equal(
      mapped.identityCenter.users.some(
        (user) => user.userName === "alice" && user.userId === "u-123",
      ),
      true,
    );
    assert.equal(
      mapped.identityCenter.groups.some(
        (group) => group.displayName === "Admins" && group.groupId === "g-123",
      ),
      true,
    );
    assert.equal(
      mapped.identityCenter.groupMemberships.some(
        (groupMembership) =>
          groupMembership.membershipId === "gm-123" &&
          groupMembership.groupId === "g-123" &&
          groupMembership.userId === "u-123",
      ),
      true,
    );
    assert.equal(
      mapped.identityCenter.permissionSets.some(
        (permissionSet) =>
          permissionSet.name === "AdminAccess" &&
          permissionSet.permissionSetArn ===
            "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
      ),
      true,
    );
    assert.equal(
      mapped.organization.accounts.some(
        (account) => account.id === "__pending_creation__",
      ),
      false,
    );
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
      groupMemberships: [
        {
          membershipId: "gm-123",
          groupId: "g-123",
          userId: "u-123",
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
