import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  regenerateAwsConfigTypes,
  writeAwsConfigFromState,
} from "../awsConfig.js";
import {
  createTestWorkspace,
  readConfigModelForTest,
  writeConfigModelForTest,
} from "../helpers.test.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import { runPlanCommand } from "./plan.js";

test("runPlanCommand prints human-readable move operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error(
            "Expected Pending and Engineering OUs in test config.",
          );
        }
        engineering.accounts = [...pending.accounts];
        pending.accounts = [];
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 1);
    assert.equal(result.plan.unsupported.length, 0);
    assert.ok(
      logger.logs.some((line) =>
        line.includes('move account "AppAccount" (111111111111)'),
      ),
    );
    assert.ok(
      logger.logs.some((line) => line.includes("from Pending -> Engineering")),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand prints human-readable createOu and createAccount operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        config.organizationalUnits.push({
          name: "Platform",
          parentName: "Engineering",
          accounts: [],
        });
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (engineering == null) {
          throw new Error("Expected Engineering OU in test config.");
        }
        engineering.accounts = [
          ...engineering.accounts,
          { name: "BrandNew", email: "brandnew@example.com" },
        ];
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 2);
    assert.equal(result.plan.unsupported.length, 0);
    assert.ok(
      logger.logs.some((line) =>
        line.includes('create OU "Platform" under Engineering'),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes(
          'create account "BrandNew" (brandnew@example.com) in Engineering',
        ),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand prints human-readable renameOu operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (engineering == null) {
          throw new Error("Expected Engineering OU in test config.");
        }
        engineering.name = "CoreEngineering";
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 1);
    assert.equal(result.plan.unsupported.length, 0);
    assert.ok(
      logger.logs.some((line) =>
        line.includes('rename OU "Engineering" -> "CoreEngineering"'),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand prints human-readable deleteOu operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        config.organizationalUnits = config.organizationalUnits.filter(
          (organizationalUnit) => organizationalUnit.name !== "Engineering",
        );
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 1);
    assert.equal(result.plan.unsupported.length, 0);
    assert.ok(
      logger.logs.some((line) =>
        line.includes("Destructive operations detected: 1"),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes('[destructive] delete OU "Engineering" from root'),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand allows deleting non-reserved Pending OU", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error(
            "Expected Pending and Engineering OUs in test config.",
          );
        }
        engineering.accounts = [...engineering.accounts, ...pending.accounts];
        config.organizationalUnits = config.organizationalUnits.filter(
          (organizationalUnit) => organizationalUnit.name !== "Pending",
        );
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 2);
    assert.equal(result.plan.unsupported.length, 0);
    assert.equal(
      logger.logs.some((line) => line.includes("delete it manually in AWS")),
      false,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand reports OU reparent as unsupported mutation", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (engineering == null) {
          throw new Error("Expected Engineering OU in test config.");
        }
        engineering.parentName = "Pending";
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 0);
    assert.equal(result.plan.unsupported.length, 1);
    assert.ok(
      logger.logs.some((line) =>
        line.includes(
          'OU "Engineering" changed parent from "root" to "Pending" [unsupportedMutation]',
        ),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand prints machine-readable JSON with --json output", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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

    const logger = createCollectingLogger();
    await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "json",
    });
    assert.equal(logger.logs.length, 1);
    const parsed = JSON.parse(logger.logs[0]) as {
      operations: unknown[];
      unsupported: unknown[];
      summary: {
        operationCount: number;
        unsupportedCount: number;
        destructiveOperationCount: number;
        destructiveUnsupportedCount: number;
        hasDestructiveChanges: boolean;
      };
    };
    assert.ok(Array.isArray(parsed.operations));
    assert.ok(Array.isArray(parsed.unsupported));
    assert.equal(parsed.summary.operationCount, parsed.operations.length);
    assert.equal(parsed.summary.unsupportedCount, parsed.unsupported.length);
    assert.equal(parsed.summary.destructiveOperationCount, 0);
    assert.equal(parsed.summary.destructiveUnsupportedCount, 0);
    assert.equal(parsed.summary.hasDestructiveChanges, false);
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand includes destructive summary metadata in --json output", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        if (pending == null) {
          throw new Error('Expected fixture OU "Pending".');
        }
        pending.accounts = pending.accounts.filter(
          (account) => account.name !== "AppAccount",
        );
      },
    });

    const logger = createCollectingLogger();
    await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "json",
    });
    const parsed = JSON.parse(logger.logs[0]) as {
      summary: {
        destructiveOperationCount: number;
        destructiveUnsupportedCount: number;
        hasDestructiveChanges: boolean;
      };
    };
    assert.equal(parsed.summary.destructiveOperationCount, 1);
    assert.equal(parsed.summary.destructiveUnsupportedCount, 0);
    assert.equal(parsed.summary.hasDestructiveChanges, true);
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand prints human-readable IdC operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
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
          description: "Read only",
          awsManagedPolicies: [],
          customerManagedPolicies: [],
        });
      },
    });
    await regenerateAwsConfigTypes({
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath,
      update: (config) => {
        const operators = config.groups.find(
          (group) => group.displayName === "Operators",
        );
        if (operators == null) {
          throw new Error('Expected "Operators" group.');
        }
        operators.members = ["bob"];
        config.assignments.push({
          permissionSet: "ReadOnly",
          user: "bob",
          accounts: ["AppAccount"],
        });
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 5);
    assert.equal(result.plan.unsupported.length, 0);
    assert.ok(
      logger.logs.some((line) => line.includes('create IdC user "bob"')),
    );
    assert.ok(
      logger.logs.some((line) => line.includes('create IdC group "Operators"')),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes('add user "bob" to IdC group "Operators"'),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes('create IdC permission set "ReadOnly"'),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes(
          'grant IdC assignment "ReadOnly" to user "bob" on "AppAccount"',
        ),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand prints human-readable permission set policy operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
  try {
    const statePath = join(workspace.workspacePath, "state.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFixtureFiles({
      statePath,
      contextPath,
    });
    const rawState = JSON.parse(await readFile(statePath, "utf8")) as {
      identityCenter: {
        accountAssignments: Array<{
          accountId: string;
          permissionSetArn: string;
          principalId: string;
          principalType: "GROUP" | "USER";
        }>;
      };
    };
    rawState.identityCenter.accountAssignments.push({
      accountId: "111111111111",
      permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
      principalId: "g-123",
      principalType: "GROUP",
    });
    await writeFile(statePath, `${JSON.stringify(rawState, null, 2)}\n`, "utf8");
    await writeAwsConfigFromState({
      statePath,
      contextPath,
      configPath,
      typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath,
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
              Effect: "Allow",
              Action: ["ec2:Describe*"],
              Resource: "*",
            },
          ],
        };
        adminAccess.awsManagedPolicies = [
          "arn:aws:iam::aws:policy/ReadOnlyAccess",
        ];
        adminAccess.customerManagedPolicies = [
          {
            name: "SupportReadOnly",
            path: "/beesolve/",
          },
        ];
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 4);
    assert.equal(result.plan.unsupported.length, 0);
    assert.ok(
      logger.logs.some((line) =>
        line.includes('put inline policy on IdC permission set "AdminAccess"'),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes(
          'attach managed policy "arn:aws:iam::aws:policy/ReadOnlyAccess" to IdC permission set "AdminAccess"',
        ),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes(
          'attach customer-managed policy "/beesolve/SupportReadOnly" to IdC permission set "AdminAccess"',
        ),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes(
          'provision IdC permission set "AdminAccess" to all provisioned accounts',
        ),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand prints destructive IdC delete operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        config.users = [];
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.operations.length, 1);
    assert.equal(result.plan.unsupported.length, 0);
    assert.ok(
      logger.logs.some((line) =>
        line.includes("Destructive operations detected: 1"),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes('[destructive] delete IdC user "alice"'),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand prints destructive account removal to Graveyard", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        if (pending == null) {
          throw new Error('Expected fixture OU "Pending".');
        }
        pending.accounts = pending.accounts.filter(
          (account) => account.name !== "AppAccount",
        );
      },
    });

    const logger = createCollectingLogger();
    const result = await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: "human",
    });
    assert.equal(result.plan.unsupported.length, 0);
    assert.equal(result.plan.operations.length, 1);
    assert.ok(
      logger.logs.some((line) =>
        line.includes("Destructive operations detected: 1"),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes(
          '[destructive] move removed account "AppAccount" (111111111111) from Pending -> Graveyard',
        ),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes("WARNING: this tool does not close AWS accounts."),
      ),
    );
    assert.ok(
      logger.logs.some((line) =>
        line.includes('Manual action required: open AWS Organizations -> "Graveyard"'),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

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

async function updateConfigModel(props: {
  configPath: string;
  typesPath?: string;
  update: (config: {
    organizationalUnits: Array<{
      name: string;
      parentName: string | null;
      accounts: Array<{ name: string; email: string }>;
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
      accounts: Array<{ name: string; email: string }>;
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
