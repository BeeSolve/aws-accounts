import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { writeAwsConfigFromState } from "../awsConfig.js";
import { createTestWorkspace } from "../helpers.test.js";
import { runPlanCommand } from "./plan.js";

test("runPlanCommand prints human-readable move operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "plan-test-" });
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
    await updateConfigModel({
      configPath: configPath,
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

    const { logs } = await captureConsoleLogs(async () => {
      const result = await runPlanCommand({
        configPath: configPath,
        typesPath: typesPath,
        statePath: statePath,
        contextPath: contextPath,
        output: "human",
      });
      assert.equal(result.plan.operations.length, 1);
      assert.equal(result.plan.unsupported.length, 0);
    });
    assert.ok(
      logs.some((line) => line.includes('move account "AppAccount" (111111111111)')),
    );
    assert.ok(logs.some((line) => line.includes("from Pending -> Engineering")));
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

    const { logs } = await captureConsoleLogs(async () => {
      await runPlanCommand({
        configPath: configPath,
        typesPath: typesPath,
        statePath: statePath,
        contextPath: contextPath,
        output: "json",
      });
    });
    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]) as {
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
    await updateConfigModel({
      configPath: configPath,
      update: (config) => {
        config.users.push({
          userName: "bob",
          displayName: "Bob",
          emails: ["bob@example.com"],
        });
      },
    });

    const { logs } = await captureConsoleLogs(async () => {
      const result = await runPlanCommand({
        configPath: configPath,
        typesPath: typesPath,
        statePath: statePath,
        contextPath: contextPath,
        output: "human",
      });
      assert.equal(result.plan.operations.length, 0);
      assert.equal(result.plan.unsupported.length, 1);
    });
    assert.ok(logs.some((line) => line.includes("Unsupported diffs:")));
    assert.ok(
      logs.some((line) =>
        line.includes('new IdC user "bob" [unsupportedMutation]'),
      ),
    );
  } finally {
    await workspace.cleanup();
  }
});

async function captureConsoleLogs(
  callback: () => Promise<void>,
): Promise<{ logs: string[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await callback();
    return {
      logs: logs,
    };
  } finally {
    console.log = originalLog;
  }
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
