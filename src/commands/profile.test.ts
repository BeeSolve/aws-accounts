import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createTestWorkspace } from "../helpers.test.js";
import type { Logger } from "../logger.js";
import { runProfileCommand } from "./profile.js";

const DEFAULT_SSO_START_URL = "https://d-test123.awsapps.com/start";
const DEFAULT_SSO_SESSION = "beesolve";

test("runProfileCommand throws when state cache is missing", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeContextFile(contextPath);
    const logger = createCollectingLogger();
    await assert.rejects(
      () =>
        runProfileCommand({
          logger,
          cachePath,
          contextPath,
          ssoStartUrl: DEFAULT_SSO_START_URL,
          ssoSession: DEFAULT_SSO_SESSION,
          isTty: true,
        }),
      (error: Error) => {
        assert.ok(error.message.includes("No remote state cache found"));
        assert.ok(error.message.includes(cachePath));
        return true;
      },
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runProfileCommand throws when stdin is not a TTY", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeProfileFixture({
      cachePath,
      contextPath,
      assignments: [
        {
          accountId: "111111111111",
          accountName: "Production",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-111",
          permissionSetName: "AdministratorAccess",
        },
      ],
    });
    const logger = createCollectingLogger();
    await assert.rejects(
      () =>
        runProfileCommand({
          logger,
          cachePath,
          contextPath,
          ssoStartUrl: DEFAULT_SSO_START_URL,
          ssoSession: DEFAULT_SSO_SESSION,
          isTty: false,
        }),
      (error: Error) => {
        assert.ok(error.message.includes("interactive terminal"));
        return true;
      },
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runProfileCommand logs message when no account assignments exist", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeProfileFixture({ cachePath, contextPath, assignments: [] });
    const logger = createCollectingLogger();
    await runProfileCommand({
      logger,
      cachePath,
      contextPath,
      ssoStartUrl: DEFAULT_SSO_START_URL,
      ssoSession: DEFAULT_SSO_SESSION,
      isTty: true,
    });
    assert.ok(logger.logs.some((line) => line.includes("No account assignments found")));
  } finally {
    await workspace.cleanup();
  }
});

test("runProfileCommand outputs profile block with all required INI fields", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeProfileFixture({
      cachePath,
      contextPath,
      assignments: [
        {
          accountId: "111111111111",
          accountName: "Production",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-111",
          permissionSetName: "AdministratorAccess",
        },
      ],
    });
    const logger = createCollectingLogger();
    await withFakeStdin("1", async () => {
      await runProfileCommand({
        logger,
        cachePath,
        contextPath,
        ssoStartUrl: DEFAULT_SSO_START_URL,
        ssoSession: DEFAULT_SSO_SESSION,
        isTty: true,
      });
    });
    const output = logger.logs.join("\n");
    assert.ok(output.includes("[profile "), "missing [profile] header");
    assert.ok(output.includes("sso_session = "), "missing sso_session");
    assert.ok(output.includes("sso_account_id = "), "missing sso_account_id");
    assert.ok(output.includes("sso_role_name = "), "missing sso_role_name");
    assert.ok(output.includes("[sso-session "), "missing [sso-session] header");
    assert.ok(output.includes("sso_start_url = "), "missing sso_start_url");
    assert.ok(output.includes("sso_region = "), "missing sso_region");
    assert.ok(output.includes("sso_registration_scopes = "), "missing sso_registration_scopes");
  } finally {
    await workspace.cleanup();
  }
});

test("runProfileCommand profile block contains correct values from input", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeProfileFixture({
      cachePath,
      contextPath,
      assignments: [
        {
          accountId: "222222222222",
          accountName: "Staging",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-222",
          permissionSetName: "ReadOnlyAccess",
        },
      ],
    });
    const logger = createCollectingLogger();
    await withFakeStdin("1", async () => {
      await runProfileCommand({
        logger,
        cachePath,
        contextPath,
        ssoStartUrl: DEFAULT_SSO_START_URL,
        ssoSession: DEFAULT_SSO_SESSION,
        isTty: true,
      });
    });
    const output = logger.logs.join("\n");
    assert.ok(output.includes("sso_account_id = 222222222222"));
    assert.ok(output.includes("sso_role_name = ReadOnlyAccess"));
    assert.ok(output.includes(`sso_start_url = ${DEFAULT_SSO_START_URL}`));
    assert.ok(output.includes(`sso_session = ${DEFAULT_SSO_SESSION}`));
    assert.ok(output.includes(`[sso-session ${DEFAULT_SSO_SESSION}]`));
    assert.ok(output.includes("sso_region = eu-central-1"));
    assert.ok(output.includes("sso_registration_scopes = sso:account:access"));
  } finally {
    await workspace.cleanup();
  }
});

test("runProfileCommand derives kebab-case profile name from account and permission-set", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeProfileFixture({
      cachePath,
      contextPath,
      assignments: [
        {
          accountId: "111111111111",
          accountName: "My Account Alpha",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-111",
          permissionSetName: "Admin Access",
        },
      ],
    });
    const logger = createCollectingLogger();
    await withFakeStdin("1", async () => {
      await runProfileCommand({
        logger,
        cachePath,
        contextPath,
        ssoStartUrl: DEFAULT_SSO_START_URL,
        ssoSession: DEFAULT_SSO_SESSION,
        isTty: true,
      });
    });
    const output = logger.logs.join("\n");
    assert.ok(
      output.includes("[profile my-account-alpha-admin-access]"),
      `expected kebab-case profile name, got:\n${output}`,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runProfileCommand derives kebab-case profile name from camelCase permission-set name", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeProfileFixture({
      cachePath,
      contextPath,
      assignments: [
        {
          accountId: "111111111111",
          accountName: "Production",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-111",
          permissionSetName: "AdministratorAccess",
        },
      ],
    });
    const logger = createCollectingLogger();
    await withFakeStdin("1", async () => {
      await runProfileCommand({
        logger,
        cachePath,
        contextPath,
        ssoStartUrl: DEFAULT_SSO_START_URL,
        ssoSession: DEFAULT_SSO_SESSION,
        isTty: true,
      });
    });
    const output = logger.logs.join("\n");
    assert.ok(
      output.includes("[profile production-administrator-access]"),
      `expected camelCase split to kebab-case, got:\n${output}`,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runProfileCommand lists entries sorted alphabetically by account then permission-set", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeProfileFixture({
      cachePath,
      contextPath,
      assignments: [
        {
          accountId: "333333333333",
          accountName: "Zeta",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-333",
          permissionSetName: "ReadOnly",
        },
        {
          accountId: "111111111111",
          accountName: "Alpha",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-111",
          permissionSetName: "Admin",
        },
        {
          accountId: "222222222222",
          accountName: "Alpha",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-222",
          permissionSetName: "ReadOnly",
        },
      ],
    });
    const logger = createCollectingLogger();
    await withFakeStdin("1", async () => {
      await runProfileCommand({
        logger,
        cachePath,
        contextPath,
        ssoStartUrl: DEFAULT_SSO_START_URL,
        ssoSession: DEFAULT_SSO_SESSION,
        isTty: true,
      });
    });
    const listLines = logger.logs.filter((line) => /^\s+\d+\./.test(line));
    assert.equal(listLines.length, 3);
    assert.ok(
      listLines[0]?.includes("Alpha") && listLines[0].includes("Admin"),
      "first: Alpha/Admin",
    );
    assert.ok(
      listLines[1]?.includes("Alpha") && listLines[1].includes("ReadOnly"),
      "second: Alpha/ReadOnly",
    );
    assert.ok(listLines[2]?.includes("Zeta"), "third: Zeta");
  } finally {
    await workspace.cleanup();
  }
});

test("runProfileCommand deduplicates entries with the same account and permission-set", async () => {
  const workspace = await createTestWorkspace({ prefix: "profile-test-" });
  try {
    const cachePath = join(workspace.workspacePath, ".remote-state-cache.json");
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const sharedArn = "arn:aws:sso:::permissionSet/ssoins-123/ps-111";
    await writeProfileFixture({
      cachePath,
      contextPath,
      assignments: [
        {
          accountId: "111111111111",
          accountName: "Production",
          permissionSetArn: sharedArn,
          permissionSetName: "Admin",
        },
        {
          accountId: "111111111111",
          accountName: "Production",
          permissionSetArn: sharedArn,
          permissionSetName: "Admin",
          principalId: "u-duplicate",
        },
      ],
    });
    const logger = createCollectingLogger();
    await withFakeStdin("1", async () => {
      await runProfileCommand({
        logger,
        cachePath,
        contextPath,
        ssoStartUrl: DEFAULT_SSO_START_URL,
        ssoSession: DEFAULT_SSO_SESSION,
        isTty: true,
      });
    });
    const listLines = logger.logs.filter((line) => /^\s+\d+\./.test(line));
    assert.equal(listLines.length, 1, "duplicate assignment should produce only one entry");
  } finally {
    await workspace.cleanup();
  }
});

async function withFakeStdin<T>(lines: string | string[], fn: () => Promise<T>): Promise<T> {
  const lineQueue = typeof lines === "string" ? [lines] : [...lines];
  let index = 0;
  const originalStdin = process.stdin;
  // Deliver one line per _read() call so each rl.question gets its own 'line' event.
  // Without this, readline processes all buffered data in one tick and the second
  // 'line' event fires before the next rl.question listener is registered.
  const mock = new Readable({
    read() {
      if (index < lineQueue.length) {
        this.push(`${lineQueue[index++]}\n`);
      }
    },
  });
  Object.defineProperty(process, "stdin", { value: mock, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
  }
}

type AssignmentFixture = {
  accountId: string;
  accountName: string;
  permissionSetArn: string;
  permissionSetName: string;
  principalId?: string;
};

async function writeProfileFixture(props: {
  cachePath: string;
  contextPath: string;
  assignments: AssignmentFixture[];
}): Promise<void> {
  const accountsById = new Map<string, { id: string; name: string }>();
  const permissionSetsByArn = new Map<string, { arn: string; name: string }>();

  for (const assignment of props.assignments) {
    accountsById.set(assignment.accountId, {
      id: assignment.accountId,
      name: assignment.accountName,
    });
    permissionSetsByArn.set(assignment.permissionSetArn, {
      arn: assignment.permissionSetArn,
      name: assignment.permissionSetName,
    });
  }

  const state = {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      organizationId: "o-test123",
      rootId: "r-root",
      organizationalUnits: [
        {
          id: "ou-active",
          parentId: "r-root",
          arn: "arn:aws:organizations:::ou/active",
          name: "Active",
        },
      ],
      accounts: [...accountsById.values()].map((account) => ({
        id: account.id,
        arn: `arn:aws:organizations:::account/${account.id}`,
        name: account.name,
        email: `${account.name.toLowerCase().replace(/\s+/g, "-")}@example.com`,
        state: "ACTIVE",
        parentId: "ou-active",
        tags: [],
      })),
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-test123",
      users: [],
      groups: [],
      groupMemberships: [],
      permissionSets: [...permissionSetsByArn.values()].map((ps) => ({
        permissionSetArn: ps.arn,
        name: ps.name,
        description: "",
        sessionDuration: null,
        inlinePolicy: null,
        awsManagedPolicies: [],
        customerManagedPolicies: [],
        permissionsBoundary: null,
      })),
      accountAssignments: props.assignments.map((assignment) => ({
        accountId: assignment.accountId,
        permissionSetArn: assignment.permissionSetArn,
        principalId: assignment.principalId ?? "u-test",
        principalType: "USER",
      })),
      accessRoles: [],
      accessControlAttributes: [],
    },
  };

  const cache = {
    fetchedAt: "2026-05-01T00:00:00.000Z",
    state,
  };

  const context = {
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
      identityStoreId: "d-test123",
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

  await Promise.all([
    writeFile(props.cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8"),
    writeFile(props.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8"),
  ]);
}

async function writeContextFile(contextPath: string): Promise<void> {
  const context = {
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
      identityStoreId: "d-test123",
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
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

function createCollectingLogger(): Logger & { logs: string[] } {
  const logs: string[] = [];
  const write = (...args: unknown[]): void => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  return { log: write, info: write, warn: write, error: write, debug: write, trace: write, logs };
}
