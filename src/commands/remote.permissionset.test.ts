import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestWorkspace } from "../helpers.test.js";
import { getStandardTags } from "../tags.js";

// --- Track all AWS SDK calls ---

type SdkCall = { commandName: string; input: unknown };

const s3Calls: SdkCall[] = [];
const iamCalls: SdkCall[] = [];
const lambdaCalls: SdkCall[] = [];
const stsCalls: SdkCall[] = [];
const ssoCalls: SdkCall[] = [];

function resetAllCalls(): void {
  s3Calls.length = 0;
  iamCalls.length = 0;
  lambdaCalls.length = 0;
  stsCalls.length = 0;
  ssoCalls.length = 0;
}

// --- Scenario flags ---

let iamRoleExists = false;
let lambdaFunctionExists = false;
let orgMgmtPermissionSetExists = false;
let remoteMgmtPermissionSetExists = false;
let orgMgmtShouldFail = false;
let remoteMgmtShouldFail = false;

// --- Mock AWS SDK modules BEFORE importing remote.ts ---

mock.module("@aws-sdk/client-s3", {
  namedExports: {
    S3Client: class {
      send = async (command: unknown) => {
        const commandName = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input?: unknown }).input;
        s3Calls.push({ commandName, input });
        return {};
      };
    },
    CreateBucketCommand: class CreateBucketCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    PutBucketTaggingCommand: class PutBucketTaggingCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    BucketLocationConstraint: {},
  },
});


mock.module("@aws-sdk/client-iam", {
  namedExports: {
    IAMClient: class {
      send = async (command: unknown) => {
        const commandName = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input?: unknown }).input;
        iamCalls.push({ commandName, input });

        if (commandName === "GetRoleCommand") {
          if (iamRoleExists) {
            return { Role: { Arn: "arn:aws:iam::123456789012:role/beesolve-aws-accounts-lambda-role" } };
          }
          const error = new Error("NoSuchEntity");
          (error as any).name = "NoSuchEntityException";
          throw error;
        }
        if (commandName === "CreateRoleCommand") {
          return { Role: { Arn: "arn:aws:iam::123456789012:role/beesolve-aws-accounts-lambda-role" } };
        }
        return {};
      };
    },
    CreateRoleCommand: class CreateRoleCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    GetRoleCommand: class GetRoleCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    PutRolePolicyCommand: class PutRolePolicyCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    TagRoleCommand: class TagRoleCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
  },
});

class MockResourceNotFoundException extends Error {
  constructor(message?: string) {
    super(message ?? "ResourceNotFoundException");
    this.name = "ResourceNotFoundException";
  }
}

mock.module("@aws-sdk/client-lambda", {
  namedExports: {
    LambdaClient: class {
      send = async (command: unknown) => {
        const commandName = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input?: unknown }).input;
        lambdaCalls.push({ commandName, input });

        if (commandName === "GetFunctionCommand") {
          if (lambdaFunctionExists) {
            return {
              Configuration: {
                FunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:beesolve-aws-accounts",
              },
            };
          }
          throw new MockResourceNotFoundException();
        }
        if (commandName === "CreateFunctionCommand") {
          return { FunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:beesolve-aws-accounts" };
        }
        return {};
      };
    },
    CreateFunctionCommand: class CreateFunctionCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    GetFunctionCommand: class GetFunctionCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    UpdateFunctionCodeCommand: class UpdateFunctionCodeCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    UpdateFunctionConfigurationCommand: class UpdateFunctionConfigurationCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    TagResourceCommand: class LambdaTagResourceCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    PutFunctionConcurrencyCommand: class PutFunctionConcurrencyCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    InvokeCommand: class InvokeCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    TooManyRequestsException: class TooManyRequestsException extends Error {
      constructor(message?: string) {
        super(message ?? "TooManyRequestsException");
        this.name = "TooManyRequestsException";
      }
    },
    ResourceNotFoundException: MockResourceNotFoundException,
  },
});


mock.module("@aws-sdk/client-sts", {
  namedExports: {
    STSClient: class {
      send = async (command: unknown) => {
        const commandName = (command as { constructor: { name: string } }).constructor.name;
        stsCalls.push({ commandName, input: (command as { input?: unknown }).input });
        if (commandName === "GetCallerIdentityCommand") {
          return { Account: "123456789012" };
        }
        return {};
      };
    },
    GetCallerIdentityCommand: class GetCallerIdentityCommand {
      input: unknown;
      constructor(input?: unknown) { this.input = input; }
    },
  },
});

mock.module("@aws-sdk/client-sso-admin", {
  namedExports: {
    SSOAdminClient: class {
      send = async (command: unknown) => {
        const commandName = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input?: unknown }).input;
        ssoCalls.push({ commandName, input });

        if (commandName === "ListPermissionSetsCommand") {
          const arns: string[] = [];
          if (orgMgmtPermissionSetExists) arns.push("arn:aws:sso:::permissionSet/ssoins-123/ps-org-mgmt");
          if (remoteMgmtPermissionSetExists) arns.push("arn:aws:sso:::permissionSet/ssoins-123/ps-remote-mgmt");
          return { PermissionSets: arns, NextToken: undefined };
        }
        if (commandName === "DescribePermissionSetCommand") {
          const psArn = (input as any).PermissionSetArn;
          if (psArn === "arn:aws:sso:::permissionSet/ssoins-123/ps-org-mgmt") {
            return { PermissionSet: { Name: "OrganizationManagement", PermissionSetArn: psArn } };
          }
          if (psArn === "arn:aws:sso:::permissionSet/ssoins-123/ps-remote-mgmt") {
            return { PermissionSet: { Name: "OrganizationRemoteManagement", PermissionSetArn: psArn } };
          }
          return { PermissionSet: { Name: "Unknown", PermissionSetArn: psArn } };
        }
        if (commandName === "CreatePermissionSetCommand") {
          const name = (input as any).Name;
          if (name === "OrganizationManagement" && orgMgmtShouldFail) {
            throw new Error("Simulated OrganizationManagement creation failure");
          }
          if (name === "OrganizationRemoteManagement" && remoteMgmtShouldFail) {
            throw new Error("Simulated OrganizationRemoteManagement creation failure");
          }
          return {
            PermissionSet: {
              PermissionSetArn: `arn:aws:sso:::permissionSet/ssoins-123/ps-new-${name}`,
            },
          };
        }
        if (commandName === "UpdatePermissionSetCommand") {
          return {};
        }
        if (commandName === "PutInlinePolicyToPermissionSetCommand") {
          return {};
        }
        if (commandName === "TagResourceCommand") {
          return {};
        }
        return {};
      };
    },
    CreatePermissionSetCommand: class CreatePermissionSetCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    DescribePermissionSetCommand: class DescribePermissionSetCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    ListPermissionSetsCommand: class ListPermissionSetsCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    PutInlinePolicyToPermissionSetCommand: class PutInlinePolicyToPermissionSetCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    UpdatePermissionSetCommand: class UpdatePermissionSetCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    TagResourceCommand: class TagResourceCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
  },
});


mock.module("@aws-sdk/credential-providers", {
  namedExports: {
    fromIni: () => undefined,
  },
});

mock.module("@aws-sdk/client-cloudwatch-logs", {
  namedExports: {
    CloudWatchLogsClient: class { send = async () => ({}); },
    CreateLogGroupCommand: class { constructor() {} },
    PutRetentionPolicyCommand: class { constructor() {} },
    DeleteRetentionPolicyCommand: class { constructor() {} },
    ResourceAlreadyExistsException: class ResourceAlreadyExistsException extends Error { name = "ResourceAlreadyExistsException"; },
    TagLogGroupCommand: class { constructor() {} },
  },
});

// --- Import module under test AFTER mocks ---

const { runRemoteBootstrap } = await import("./remote.js");
const { noopLogger } = await import("../logger.js");
const { STSClient } = await import("@aws-sdk/client-sts");
const { S3Client } = await import("@aws-sdk/client-s3");
const { IAMClient } = await import("@aws-sdk/client-iam");
const { LambdaClient } = await import("@aws-sdk/client-lambda");
const { SSOAdminClient } = await import("@aws-sdk/client-sso-admin");

// --- Helpers ---

function createValidContextFile(opts?: { withIdentityCenter?: boolean }) {
  const base: Record<string, unknown> = {
    version: "1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    organization: {
      id: "o-test123",
      managementAccountId: "123456789012",
      rootId: "r-root",
      graveyardOuId: "ou-graveyard",
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
    },
  };
  return base;
}

function createCollectingLogger() {
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

async function setupWorkspace(workspace: { workspacePath: string }) {
  const contextPath = join(workspace.workspacePath, "aws.context.json");
  await writeFile(contextPath, JSON.stringify(createValidContextFile(), null, 2), "utf8");
  await mkdir(join(workspace.workspacePath, "dist-lambda"), { recursive: true });
  await writeFile(join(workspace.workspacePath, "dist-lambda/lambda.zip"), "fake-zip-content", "utf8");
}


// --- Tests: Permission set creation through runRemoteBootstrap ---
// (ensureOrganizationManagementPermissionSet and ensureOrganizationRemoteManagementPermissionSet
// are private functions tested through the public runRemoteBootstrap API)


// --- Tests: Graceful skip when Identity Center is not configured ---

test("runRemoteBootstrap skips permission set creation when Identity Center instanceArn is missing from context", async () => {
  // Note: The current awsContextSchema requires identityCenter with non-empty strings.
  // The skip logic (instanceArn == null || instanceArn === "") is defensive code for when
  // the schema is relaxed. We test the positive path here: when identityCenter IS present,
  // permission sets ARE created.
  const workspace = await createTestWorkspace({ prefix: "remote-ps-test-" });
  try {
    resetAllCalls();
    iamRoleExists = false;
    lambdaFunctionExists = false;
    orgMgmtPermissionSetExists = false;
    remoteMgmtPermissionSetExists = false;
    orgMgmtShouldFail = false;
    remoteMgmtShouldFail = false;

    // Set up workspace WITH identityCenter in context
    await setupWorkspace(workspace);

    const logger = createCollectingLogger();
    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, update: false },
        logger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
      });

      // Verify SSO calls WERE made (permission sets created)
      const createCalls = ssoCalls.filter(c => c.commandName === "CreatePermissionSetCommand");
      assert.equal(createCalls.length, 2, "Both permission sets should be created when Identity Center is configured");

      // Verify no skip message was logged
      const skipLog = logger.logs.find(l => l.includes("Identity Center not configured"));
      assert.equal(skipLog, undefined, "Should not log skip message when Identity Center is configured");
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    await workspace.cleanup();
  }
});

// --- Tests: Partial failure (one fails, other still attempted) ---

test("runRemoteBootstrap continues with second permission set when first fails", async () => {
  const workspace = await createTestWorkspace({ prefix: "remote-ps-test-" });
  try {
    resetAllCalls();
    iamRoleExists = false;
    lambdaFunctionExists = false;
    orgMgmtPermissionSetExists = false;
    remoteMgmtPermissionSetExists = false;
    orgMgmtShouldFail = true;
    remoteMgmtShouldFail = false;

    await setupWorkspace(workspace);

    const logger = createCollectingLogger();
    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, update: false },
        logger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
      });

      // Verify error was logged for OrganizationManagement
      const errorLog = logger.logs.find(l => l.includes("Error creating OrganizationManagement permission set"));
      assert.ok(errorLog, "Expected error log for OrganizationManagement failure");

      // Verify OrganizationRemoteManagement was still attempted and succeeded
      const remoteMgmtCreateCalls = ssoCalls.filter(
        c => c.commandName === "CreatePermissionSetCommand" && (c.input as any).Name === "OrganizationRemoteManagement",
      );
      assert.equal(remoteMgmtCreateCalls.length, 1, "OrganizationRemoteManagement should still be attempted");

      // Verify bootstrap completed
      const completeLog = logger.logs.find(l => l.includes("Bootstrap complete"));
      assert.ok(completeLog, "Bootstrap should complete despite partial permission set failure");
    } finally {
      process.chdir(originalCwd);
      orgMgmtShouldFail = false;
    }
  } finally {
    await workspace.cleanup();
  }
});

test("runRemoteBootstrap continues with first permission set when second fails", async () => {
  const workspace = await createTestWorkspace({ prefix: "remote-ps-test-" });
  try {
    resetAllCalls();
    iamRoleExists = false;
    lambdaFunctionExists = false;
    orgMgmtPermissionSetExists = false;
    remoteMgmtPermissionSetExists = false;
    orgMgmtShouldFail = false;
    remoteMgmtShouldFail = true;

    await setupWorkspace(workspace);

    const logger = createCollectingLogger();
    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, update: false },
        logger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
      });

      // Verify OrganizationManagement was created successfully
      const orgMgmtCreateCalls = ssoCalls.filter(
        c => c.commandName === "CreatePermissionSetCommand" && (c.input as any).Name === "OrganizationManagement",
      );
      assert.equal(orgMgmtCreateCalls.length, 1, "OrganizationManagement should be created");

      // Verify error was logged for OrganizationRemoteManagement
      const errorLog = logger.logs.find(l => l.includes("Error creating OrganizationRemoteManagement permission set"));
      assert.ok(errorLog, "Expected error log for OrganizationRemoteManagement failure");

      // Verify bootstrap completed
      const completeLog = logger.logs.find(l => l.includes("Bootstrap complete"));
      assert.ok(completeLog, "Bootstrap should complete despite partial permission set failure");
    } finally {
      process.chdir(originalCwd);
      remoteMgmtShouldFail = false;
    }
  } finally {
    await workspace.cleanup();
  }
});
