import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { writeAwsConfigFromState } from "../awsConfig.js";
import { createTestWorkspace } from "../helpers.test.js";
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
          throw new Error("Expected Pending and Engineering OUs in test config.");
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
      logger.logs.some((line) => line.includes('create OU "Platform" under Engineering')),
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
    };
    assert.ok(Array.isArray(parsed.operations));
    assert.ok(Array.isArray(parsed.unsupported));
  } finally {
    await workspace.cleanup();
  }
});

test("runPlanCommand human output includes unsupported categories", async () => {
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
          emails: ["bob@example.com"],
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
    assert.equal(result.plan.operations.length, 0);
    assert.equal(result.plan.unsupported.length, 1);
    assert.ok(logger.logs.some((line) => line.includes("Unsupported diffs:")));
    assert.ok(
      logger.logs.some((line) =>
        line.includes('new IdC user "bob" [unsupportedMutation]'),
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
