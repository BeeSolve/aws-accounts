import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestWorkspace } from "./helpers.test.js";
import type { Logger } from "./logger.js";
import type { StateFile } from "./state.js";
import { regenerateTypesFromState } from "./awsConfig.js";

// --- Collecting logger ---

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

// --- Minimal valid state ---

function createMinimalState(): StateFile {
  return {
    version: "1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    organization: {
      organizationId: "o-test123",
      rootId: "r-root",
      organizationalUnits: [],
      accounts: [],
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
}

// --- Tests ---

test("regenerateTypesFromState writes file and logs when content changes", async () => {
  const workspace = await createTestWorkspace({ prefix: "regen-test-" });
  try {
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await writeFile(typesPath, "// old content\n", "utf8");

    const logger = createCollectingLogger();
    await regenerateTypesFromState({
      state: createMinimalState(),
      contextPath: join(workspace.workspacePath, "aws.context.json"),
      configPath: join(workspace.workspacePath, "aws.config.ts"),
      typesPath,
      logger,
    });

    const written = await readFile(typesPath, "utf8");
    assert.notEqual(written, "// old content\n");

    const updateLog = logger.logs.find((l) => l.includes("Updated aws.config.types.ts"));
    assert.ok(updateLog, `Expected "Updated aws.config.types.ts" log, got: ${JSON.stringify(logger.logs)}`);
  } finally {
    await workspace.cleanup();
  }
});

test("regenerateTypesFromState logs warning on failure without throwing", async () => {
  const workspace = await createTestWorkspace({ prefix: "regen-test-" });
  try {
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    const logger = createCollectingLogger();

    // Pass an invalid state to trigger an error inside mapStateToAwsConfig
    await regenerateTypesFromState({
      state: { invalid: true } as unknown as StateFile,
      contextPath: join(workspace.workspacePath, "aws.context.json"),
      configPath: join(workspace.workspacePath, "aws.config.ts"),
      typesPath,
      logger,
    });

    const warningLog = logger.logs.find((l) => l.includes("Failed to regenerate types"));
    assert.ok(warningLog, `Expected warning log containing "Failed to regenerate types", got: ${JSON.stringify(logger.logs)}`);
  } finally {
    await workspace.cleanup();
  }
});

test("regenerateTypesFromState does not log when types are unchanged", async () => {
  const workspace = await createTestWorkspace({ prefix: "regen-test-" });
  try {
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");

    // First, generate the types to know what the output looks like
    const logger1 = createCollectingLogger();
    await regenerateTypesFromState({
      state: createMinimalState(),
      contextPath: join(workspace.workspacePath, "aws.context.json"),
      configPath: join(workspace.workspacePath, "aws.config.ts"),
      typesPath,
      logger: logger1,
    });

    // Now run again — file already has the correct content
    const logger2 = createCollectingLogger();
    await regenerateTypesFromState({
      state: createMinimalState(),
      contextPath: join(workspace.workspacePath, "aws.context.json"),
      configPath: join(workspace.workspacePath, "aws.config.ts"),
      typesPath,
      logger: logger2,
    });

    assert.equal(logger2.logs.length, 0, `Expected no logs on second run, got: ${JSON.stringify(logger2.logs)}`);
  } finally {
    await workspace.cleanup();
  }
});
