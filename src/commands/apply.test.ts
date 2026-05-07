import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MoveAccountCommand,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";
import { writeAwsConfigFromState } from "../awsConfig.js";
import { createTestWorkspace } from "../helpers.test.js";
import { runApplyCommand } from "./apply.js";

test("runApplyCommand refuses destructive unsupported diffs regardless of flag", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        if (pending == null) {
          throw new Error("Expected Pending OU.");
        }
        pending.accounts = [];
      },
    });

    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({}),
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          ignoreUnsupported: true,
          planConfirmation: async () => true,
        }),
      /destructive unsupported diffs/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand refuses non-destructive unsupported diffs without flag", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        config.users.push({
          userName: "bob",
          displayName: "Bob",
          emails: ["bob@example.com"],
        });
      },
    });

    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({}),
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /Re-run with --ignore-unsupported/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand proceeds with ignoreUnsupported for supported operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        config.users.push({
          userName: "bob",
          displayName: "Bob",
          emails: ["bob@example.com"],
        });
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.accounts = [...pending.accounts];
        pending.accounts = [];
      },
    });

    const seenMoveInputs: Array<{
      AccountId?: string;
      SourceParentId?: string;
      DestinationParentId?: string;
    }> = [];
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        onMoveAccount: async (input) => {
          seenMoveInputs.push(input);
        },
      }),
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      ignoreUnsupported: true,
      planConfirmation: async () => true,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 2);
    assert.equal(seenMoveInputs.length, 2);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand returns cancelled when confirmation is rejected", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.accounts = [...pending.accounts];
        pending.accounts = [];
      },
    });

    let moveCalls = 0;
    const beforeState = await readFile(paths.statePath, "utf8");
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        onMoveAccount: async () => {
          moveCalls += 1;
        },
      }),
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      ignoreUnsupported: false,
      planConfirmation: async () => false,
    });
    const afterState = await readFile(paths.statePath, "utf8");
    assert.equal(result.status, "cancelled");
    assert.equal(moveCalls, 0);
    assert.equal(afterState, beforeState);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand applies one move and writes next state", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.accounts = [...pending.accounts];
        pending.accounts = [];
      },
    });

    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({}),
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 2);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: { accounts: Array<{ name: string; parentId: string }> };
    };
    const appAccount = persisted.organization.accounts.find(
      (account) => account.name === "AppAccount",
    );
    assert.equal(appAccount?.parentId, "ou-engineering");
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand persists partial state on operation failure", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.accounts = [
          ...engineering.accounts,
          ...pending.accounts.filter((account) => account.name === "AppAccount"),
        ];
        pending.accounts = pending.accounts.filter(
          (account) => account.name !== "AppAccount",
        );

        const graveyard = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Graveyard",
        );
        if (graveyard == null) {
          throw new Error("Expected Graveyard OU.");
        }
        graveyard.accounts = [
          ...graveyard.accounts,
          ...pending.accounts.filter((account) => account.name === "DataAccount"),
        ];
        pending.accounts = pending.accounts.filter(
          (account) => account.name !== "DataAccount",
        );
      },
    });

    let moveCallCount = 0;
    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({
            onMoveAccount: async () => {
              moveCallCount += 1;
              if (moveCallCount === 2) {
                throw new Error("synthetic move failure");
              }
            },
          }),
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /Run 'npm run cli -- scan' to verify, then re-run apply/,
    );
    assert.equal(moveCallCount, 2);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: { accounts: Array<{ name: string; parentId: string }> };
    };
    const appAccount = persisted.organization.accounts.find(
      (account) => account.name === "AppAccount",
    );
    const dataAccount = persisted.organization.accounts.find(
      (account) => account.name === "DataAccount",
    );
    assert.equal(appAccount?.parentId, "ou-engineering");
    assert.equal(dataAccount?.parentId, "ou-pending");
  } finally {
    await workspace.cleanup();
  }
});

function getFixturePaths(props: { workspacePath: string }): {
  statePath: string;
  contextPath: string;
  configPath: string;
  typesPath: string;
} {
  return {
    statePath: join(props.workspacePath, "state.json"),
    contextPath: join(props.workspacePath, "aws.context.json"),
    configPath: join(props.workspacePath, "aws.config.ts"),
    typesPath: join(props.workspacePath, "aws.config.types.ts"),
  };
}

function createOrganizationsClientMock(props: {
  onMoveAccount?: (input: {
    AccountId?: string;
    SourceParentId?: string;
    DestinationParentId?: string;
  }) => Promise<void>;
}): OrganizationsClient {
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof MoveAccountCommand) {
        if (props.onMoveAccount != null) {
          await props.onMoveAccount(command.input);
        }
        return {};
      }
      throw new Error("Unexpected Organizations command in test.");
    },
  };
  return mock as OrganizationsClient;
}

async function updateConfigModel(props: {
  configPath: string;
  update: (config: {
    organizationalUnits: Array<{
      name: string;
      parentName: string | null;
      accounts: Array<{ name: string; email: string }>;
    }>;
    users: Array<{ userName: string; displayName: string; emails: string[] }>;
    groups: Array<{ displayName: string }>;
    permissionSets: Array<{ name: string; description: string }>;
    assignments: Array<{
      permissionSet: string;
      group?: string;
      user?: string;
      accounts: string[];
    }>;
  }) => void;
}): Promise<void> {
  const rawConfig = await readFile(props.configPath, "utf8");
  const matched = rawConfig.match(
    /v\.parse\(awsConfigSchema,\s*([\s\S]*?)\s*satisfies AwsConfig\);/,
  );
  if (matched == null || matched[1] == null) {
    throw new Error("Could not extract awsConfig JSON payload from aws.config.ts.");
  }
  const parsedConfig = JSON.parse(matched[1]) as {
    organizationalUnits: Array<{
      name: string;
      parentName: string | null;
      accounts: Array<{ name: string; email: string }>;
    }>;
    users: Array<{ userName: string; displayName: string; emails: string[] }>;
    groups: Array<{ displayName: string }>;
    permissionSets: Array<{ name: string; description: string }>;
    assignments: Array<{
      permissionSet: string;
      group?: string;
      user?: string;
      accounts: string[];
    }>;
  };
  props.update(parsedConfig);
  const nextConfig = rawConfig.replace(
    matched[1],
    JSON.stringify(parsedConfig, null, 2),
  );
  await writeFile(props.configPath, nextConfig, "utf8");
}

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
        {
          id: "ou-engineering",
          parentId: "r-root",
          arn: "arn:aws:organizations:::ou/engineering",
          name: "Engineering",
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
        {
          id: "222222222222",
          arn: "arn:aws:organizations:::account/222222222222",
          name: "DataAccount",
          email: "data@example.com",
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
