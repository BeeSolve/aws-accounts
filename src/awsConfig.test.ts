import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import {
  awsConfigModelSchema,
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
  regenerateAwsConfigTypes,
  writeAwsConfigFromState,
} from "./awsConfig.js";
import {
  createTestWorkspace,
  readConfigModelForTest,
  writeConfigModelForTest,
} from "./helpers.test.js";
import { noopLogger } from "./logger.js";
import { validateState } from "./state.js";

test("writeAwsConfigFromState generates aws.config.ts and aws.config.types.ts", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    const { state } = await writeFixtureFiles({
      contextPath,
    });
    let confirmationCalls = 0;
    const result = await writeAwsConfigFromState({
      state: validateState(state),
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
    assert.match(typesRaw, /@beesolve\/iam-policy-ts/);
    assert.match(typesRaw, /export \* as iam from "@beesolve\/iam-policy-ts"/);
    assert.match(configRaw, /\bname: "root"/);
    assert.match(configRaw, /\bmembers: \[/);
    assert.match(configRaw, /"alice"/);
  } finally {
    await workspace.cleanup();
  }
});

test("writeAwsConfigFromState renders IAM action helpers for known inline policy actions", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    const { state } = await writeFixtureFiles({
      contextPath,
    });

    const modifiedState = structuredClone(state) as {
      identityCenter: {
        permissionSets: Array<{
          name: string;
          inlinePolicy: string | null;
        }>;
      };
    } & typeof state;
    const adminAccess = modifiedState.identityCenter.permissionSets.find(
      (permissionSet) => permissionSet.name === "AdminAccess",
    );
    if (adminAccess == null) {
      throw new Error('Expected "AdminAccess" permission set.');
    }
    adminAccess.inlinePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "sso-directory:SearchUsers",
            "custom-service:DoThing",
          ],
          Resource: "*",
        },
      ],
    });

    await writeAwsConfigFromState({
      state: validateState(modifiedState),
      contextPath,
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });

    const configRaw = await readFile(configPath, "utf8");
    assert.match(configRaw, /iam\.s3\("GetObject"\)/);
    assert.match(configRaw, /iam\.ssoDirectory\("SearchUsers"\)/);
    assert.match(configRaw, /"custom-service:DoThing"/);
  } finally {
    await workspace.cleanup();
  }
});

test("writeAwsConfigFromState no-op does not call confirmation", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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
    const result = await writeAwsConfigFromState({
      state: validateState(state),
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
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    const { state } = await writeFixtureFiles({
      contextPath,
    });
    const contextRaw = await readFile(contextPath, "utf8");
    const context = JSON.parse(contextRaw) as {
      organization: { graveyardOuId: string };
    };
    context.organization.graveyardOuId = "ou-graveyard-mismatch";
    await writeFile(
      contextPath,
      `${JSON.stringify(context, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      () =>
        writeAwsConfigFromState({
          state: validateState(state),
          contextPath,
          configPath,
          typesPath,
          logger: noopLogger,
          overwriteConfirmation: async () => true,
        }),
      /Graveyard OU id/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("regenerateAwsConfigTypes reports no changes when types are up to date", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    const { state } = await writeFixtureFiles({
      contextPath,
    });
    const result = await writeAwsConfigFromState({
      state: validateState(state),
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

    const [config, currentState, context] = await Promise.all([
      loadAwsConfigModelFromTsFile({
        configPath,
        typesPath,
      }),
      Promise.resolve(validateState(state)),
      readAwsContextFromFile(contextPath),
    ]);
    config.organizationalUnits.push({
      name: "Sandbox",
      parentName: "root",
      accounts: [{ name: "SandboxAccount", email: "sandbox@example.com", tags: [] }],
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
      awsManagedPolicies: [],
      customerManagedPolicies: [],
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

    const [config, currentState, context] = await Promise.all([
      loadAwsConfigModelFromTsFile({
        configPath,
        typesPath,
      }),
      Promise.resolve(validateState(state)),
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

    const [config, currentState, context] = await Promise.all([
      loadAwsConfigModelFromTsFile({
        configPath,
        typesPath,
      }),
      Promise.resolve(validateState(state)),
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

test("mapAwsConfigToState matches existing member account by email when config name differs", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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

    const [config, currentState, context] = await Promise.all([
      loadAwsConfigModelFromTsFile({
        configPath,
        typesPath,
      }),
      Promise.resolve(validateState(state)),
      readAwsContextFromFile(contextPath),
    ]);

    const renamedConfig = structuredClone(config);
    const pendingOu = renamedConfig.organizationalUnits.find(
      (organizationalUnit) => organizationalUnit.name === "Pending",
    );
    const appAccount = pendingOu?.accounts.find(
      (account) => account.name === "AppAccount",
    );
    if (appAccount == null) {
      throw new Error('Expected account "AppAccount".');
    }
    appAccount.name = "RenamedInConfigOnly";
    for (const assignment of renamedConfig.assignments) {
      assignment.accounts = assignment.accounts.map((accountName) =>
        accountName === "AppAccount" ? "RenamedInConfigOnly" : accountName,
      );
    }

    const parsedConfig = v.parse(awsConfigModelSchema, renamedConfig);
    const mapped = mapAwsConfigToState({
      config: parsedConfig,
      currentState,
      context,
    });

    const mappedAccount = mapped.organization.accounts.find(
      (account) => account.id === "111111111111",
    );
    assert.equal(mappedAccount?.name, "RenamedInConfigOnly");
    assert.equal(mappedAccount?.email, "app@example.com");
  } finally {
    await workspace.cleanup();
  }
});

test("permission set policy state round-trips between state and config", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
  try {
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    const { state } = await writeFixtureFiles({
      contextPath,
    });

    const rawState = structuredClone(state) as {
      version: string;
      generatedAt: string;
      organization: typeof state.organization;
      identityCenter: Omit<typeof state.identityCenter, "permissionSets"> & {
        permissionSets: Array<{
          permissionSetArn: string;
          name: string;
          description: string;
          inlinePolicy: string | null;
          awsManagedPolicies: string[];
          customerManagedPolicies: Array<{ name: string; path: string }>;
        }>;
      };
    };
    rawState.identityCenter.permissionSets[0] = {
      ...rawState.identityCenter.permissionSets[0],
      inlinePolicy:
        '{"Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":"*"}],"Version":"2012-10-17"}',
      awsManagedPolicies: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
      customerManagedPolicies: [
        {
          name: "SupportReadOnly",
          path: "/beesolve/",
        },
      ],
    };
    await writeAwsConfigFromState({
      state: validateState(rawState),
      contextPath,
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });

    const [config, currentState, context, configRaw] = await Promise.all([
      loadAwsConfigModelFromTsFile({
        configPath,
        typesPath,
      }),
      Promise.resolve(validateState(rawState)),
      readAwsContextFromFile(contextPath),
      readFile(configPath, "utf8"),
    ]);

    assert.match(configRaw, /\binlinePolicy: \{/);
    assert.match(configRaw, /\bVersion: "2012-10-17"/);
    assert.match(
      configRaw,
      /"arn:aws:iam::aws:policy\/ReadOnlyAccess"/,
    );
    assert.match(configRaw, /\bcustomerManagedPolicies: \[/);
    assert.deepEqual(config.permissionSets[0]?.inlinePolicy, {
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: "*",
        },
      ],
      Version: "2012-10-17",
    });

    const mapped = mapAwsConfigToState({
      config,
      currentState,
      context,
    });
    assert.equal(
      mapped.identityCenter.permissionSets[0]?.inlinePolicy,
      '{"Statement":[{"Action":["s3:GetObject"],"Effect":"Allow","Resource":"*"}],"Version":"2012-10-17"}',
    );
    assert.deepEqual(mapped.identityCenter.permissionSets[0]?.awsManagedPolicies, [
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
    assert.deepEqual(
      mapped.identityCenter.permissionSets[0]?.customerManagedPolicies,
      [
        {
          name: "SupportReadOnly",
          path: "/beesolve/",
        },
      ],
    );
  } finally {
    await workspace.cleanup();
  }
});

test("loadAwsConfigModelFromTsFile validates inline policy documents against IAM schema", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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

    await updateConfigModel({
      configPath,
      typesPath,
      update: (config) => {
        const adminAccess = config.permissionSets.find(
          (permissionSet) => permissionSet.name === "AdminAccess",
        );
        if (adminAccess == null) {
          throw new Error('Expected "AdminAccess" permission set.');
        }
        adminAccess.inlinePolicy = {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Permit",
              Action: "s3:GetObject",
              Resource: "*",
            },
          ],
        };
      },
    });

    await assert.rejects(
      () =>
        loadAwsConfigModelFromTsFile({
          configPath,
          typesPath,
        }),
      /aws\.config\.ts validation failed/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("loadAwsConfigModelFromTsFile supports IAM action helper functions", async () => {
  const workspace = await createTestWorkspace({ prefix: "aws-config-test-" });
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

    await writeFile(
      configPath,
      `import * as v from "valibot";
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

const awsConfig: AwsConfig = v.parse(awsConfigSchema, {
  organizationalUnits: [
    {
      name: "root",
      parentName: null,
      accounts: [],
    },
    {
      name: "Pending",
      parentName: "root",
      accounts: [
        {
          name: "AppAccount",
          email: "app@example.com",
          tags: [],
        },
      ],
    },
    {
      name: "Graveyard",
      parentName: "root",
      accounts: [],
    },
  ],
  users: [
    {
      userName: "alice",
      displayName: "Alice",
      email: "alice@example.com",
    },
  ],
  groups: [
    {
      displayName: "Admins",
      members: ["alice"],
    },
  ],
  permissionSets: [
    {
      name: "AdminAccess",
      description: "Admin",
      inlinePolicy: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              iam.s3("GetObject"),
              iam.identitystore("CreateGroupMembership"),
              iam.ssoDirectory("SearchUsers"),
            ],
            Resource: "*",
          },
        ],
      },
      awsManagedPolicies: [],
      customerManagedPolicies: [],
    },
  ],
  assignments: [
    {
      permissionSet: "AdminAccess",
      group: "Admins",
      accounts: ["AppAccount"],
    },
  ],
  accessControlAttributes: [],
  delegatedAdministrators: [],
  policies: {
    serviceControlPolicies: [],
    resourceControlPolicies: [],
    tagPolicies: [],
    aiServicesOptOutPolicies: [],
    backupPolicies: [],
  },
} satisfies AwsConfig);

export default awsConfig;
`,
      "utf8",
    );

    const config = await loadAwsConfigModelFromTsFile({
      configPath,
      typesPath,
    });

    assert.deepEqual(config.permissionSets[0]?.inlinePolicy, {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "identitystore:CreateGroupMembership",
            "sso-directory:SearchUsers",
          ],
          Resource: "*",
        },
      ],
    });
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

async function updateConfigModel(props: {
  configPath: string;
  typesPath?: string;
  update: (config: {
    organizationalUnits: Array<{
      name: string;
      parentName: string | null;
      accounts: Array<{
        name: string;
        email: string;
        tags: Array<{ key: string; value: string }>;
      }>;
    }>;
    users: Array<{ userName: string; displayName: string; email: string }>;
    groups: Array<{ displayName: string; members: string[] }>;
    permissionSets: Array<{
      name: string;
      description: string;
      inlinePolicy?: Record<string, unknown>;
      awsManagedPolicies: string[];
      customerManagedPolicies: Array<{ name: string; path: string }>;
    }>;
    assignments: Array<{
      permissionSet: string;
      group?: string;
      user?: string;
      accounts: string[];
    }>;
  }) => void;
}): Promise<void> {
  const typesPath =
    props.typesPath ?? join(dirname(props.configPath), "aws.config.types.ts");
  void typesPath;
  const parsedConfig = (await readConfigModelForTest({
    configPath: props.configPath,
  })) as {
    organizationalUnits: Array<{
      name: string;
      parentName: string | null;
      accounts: Array<{
        name: string;
        email: string;
        tags: Array<{ key: string; value: string }>;
      }>;
    }>;
    users: Array<{ userName: string; displayName: string; email: string }>;
    groups: Array<{ displayName: string; members: string[] }>;
    permissionSets: Array<{
      name: string;
      description: string;
      inlinePolicy?: Record<string, unknown>;
      awsManagedPolicies: string[];
      customerManagedPolicies: Array<{ name: string; path: string }>;
    }>;
    assignments: Array<{
      permissionSet: string;
      group?: string;
      user?: string;
      accounts: string[];
    }>;
  };
  props.update(parsedConfig);
  await writeConfigModelForTest({
    configPath: props.configPath,
    config: parsedConfig,
  });
}
