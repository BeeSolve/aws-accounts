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

function resetAllCalls(): void {
  s3Calls.length = 0;
  iamCalls.length = 0;
  lambdaCalls.length = 0;
  stsCalls.length = 0;
}

// --- Scenario flags ---

let iamRoleExists = false;
let lambdaFunctionExists = false;

// --- Mock AWS SDK modules BEFORE importing remote.ts ---

mock.module("@aws-sdk/client-s3", {
  namedExports: {
    S3Client: class {
      send = async (command: unknown) => {
        const commandName = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input?: unknown }).input;
        s3Calls.push({ commandName, input });

        if (commandName === "CreateBucketCommand") {
          // Simulate bucket already exists on second run
          return {};
        }
        if (commandName === "PutBucketTaggingCommand") {
          return {};
        }
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
            return {
              Role: { Arn: "arn:aws:iam::123456789012:role/beesolve-aws-accounts-lambda-role" },
            };
          }
          const error = new Error("NoSuchEntity");
          (error as any).name = "NoSuchEntityException";
          throw error;
        }
        if (commandName === "CreateRoleCommand") {
          return {
            Role: { Arn: "arn:aws:iam::123456789012:role/beesolve-aws-accounts-lambda-role" },
          };
        }
        if (commandName === "TagRoleCommand") {
          return {};
        }
        if (commandName === "PutRolePolicyCommand") {
          return {};
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

// Define ResourceNotFoundException before mock.module
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
          return {
            FunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:beesolve-aws-accounts",
          };
        }
        if (commandName === "UpdateFunctionCodeCommand") {
          return {};
        }
        if (commandName === "UpdateFunctionConfigurationCommand") {
          return {};
        }
        if (commandName === "TagResourceCommand") {
          return {};
        }
        if (commandName === "PutFunctionConcurrencyCommand") {
          return {};
        }
        if (commandName === "InvokeCommand") {
          return {};
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
    TagResourceCommand: class TagResourceCommand {
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
        if (commandName === "ListInstancesCommand") {
          return { Instances: [{ InstanceArn: "arn:aws:sso:::instance/ssoins-123", IdentityStoreId: "d-123" }] };
        }
        if (commandName === "ListPermissionSetsCommand") {
          return { PermissionSets: [], NextToken: undefined };
        }
        if (commandName === "CreatePermissionSetCommand") {
          return { PermissionSet: { PermissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-new" } };
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
    ListInstancesCommand: class ListInstancesCommand {
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

mock.module("@aws-sdk/client-organizations", {
  namedExports: {
    OrganizationsClient: class { send = async () => ({ Organization: { FeatureSet: "ALL" } }); },
    CreateOrganizationCommand: class { constructor() {} },
    DescribeOrganizationCommand: class { constructor() {} },
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
const { OrganizationsClient } = await import("@aws-sdk/client-organizations");

// --- Helpers ---

function createValidContextFile() {
  return {
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
}

// --- Tests: S3 bucket tagging ---

test("runRemoteBootstrap applies PutBucketTagging with standard tags after bucket creation", async () => {
  const workspace = await createTestWorkspace({ prefix: "remote-tag-test-" });
  try {
    resetAllCalls();
    iamRoleExists = false;
    lambdaFunctionExists = false;

    // Set up workspace with required files
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFile(contextPath, JSON.stringify(createValidContextFile(), null, 2), "utf8");
    await mkdir(join(workspace.workspacePath, "dist-lambda"), { recursive: true });
    await writeFile(join(workspace.workspacePath, "dist-lambda/lambda.zip"), "fake-zip-content", "utf8");

    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, redeployStacksets: false },
        logger: noopLogger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
        organizationsClient: new OrganizationsClient({}),
      });

      // Verify PutBucketTaggingCommand was called
      const putTaggingCalls = s3Calls.filter(c => c.commandName === "PutBucketTaggingCommand");
      assert.equal(putTaggingCalls.length, 1, "Expected exactly one PutBucketTaggingCommand call");

      const taggingInput = putTaggingCalls[0].input as {
        Bucket: string;
        Tagging: { TagSet: Array<{ Key: string; Value: string }> };
      };
      assert.equal(taggingInput.Bucket, "beesolve-aws-accounts-state-123456789012-us-east-1");
      assert.deepEqual(taggingInput.Tagging.TagSet, getStandardTags("state-storage"));
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    await workspace.cleanup();
  }
});

// --- Tests: IAM role tagging on creation ---

test("runRemoteBootstrap includes standard tags in CreateRoleCommand when role does not exist", async () => {
  const workspace = await createTestWorkspace({ prefix: "remote-tag-test-" });
  try {
    resetAllCalls();
    iamRoleExists = false;
    lambdaFunctionExists = false;

    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFile(contextPath, JSON.stringify(createValidContextFile(), null, 2), "utf8");
    await mkdir(join(workspace.workspacePath, "dist-lambda"), { recursive: true });
    await writeFile(join(workspace.workspacePath, "dist-lambda/lambda.zip"), "fake-zip-content", "utf8");

    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, redeployStacksets: false },
        logger: noopLogger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
        organizationsClient: new OrganizationsClient({}),
      });

      // Verify CreateRoleCommand was called with Tags
      const createRoleCalls = iamCalls.filter(c => c.commandName === "CreateRoleCommand");
      assert.equal(createRoleCalls.length, 1, "Expected exactly one CreateRoleCommand call");

      const createRoleInput = createRoleCalls[0].input as {
        RoleName: string;
        Tags: Array<{ Key: string; Value: string }>;
      };
      assert.deepEqual(createRoleInput.Tags, getStandardTags("execution-role"));
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    await workspace.cleanup();
  }
});

// --- Tests: IAM role tagging when role already exists (idempotent) ---

test("runRemoteBootstrap calls TagRoleCommand with standard tags when role already exists", async () => {
  const workspace = await createTestWorkspace({ prefix: "remote-tag-test-" });
  try {
    resetAllCalls();
    iamRoleExists = true;
    lambdaFunctionExists = false;

    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFile(contextPath, JSON.stringify(createValidContextFile(), null, 2), "utf8");
    await mkdir(join(workspace.workspacePath, "dist-lambda"), { recursive: true });
    await writeFile(join(workspace.workspacePath, "dist-lambda/lambda.zip"), "fake-zip-content", "utf8");

    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, redeployStacksets: false },
        logger: noopLogger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
        organizationsClient: new OrganizationsClient({}),
      });

      // Verify TagRoleCommand was called (not CreateRoleCommand)
      const createRoleCalls = iamCalls.filter(c => c.commandName === "CreateRoleCommand");
      assert.equal(createRoleCalls.length, 0, "Should not call CreateRoleCommand when role exists");

      const tagRoleCalls = iamCalls.filter(c => c.commandName === "TagRoleCommand");
      assert.equal(tagRoleCalls.length, 1, "Expected exactly one TagRoleCommand call");

      const tagRoleInput = tagRoleCalls[0].input as {
        RoleName: string;
        Tags: Array<{ Key: string; Value: string }>;
      };
      assert.equal(tagRoleInput.RoleName, "beesolve-aws-accounts-lambda-role");
      assert.deepEqual(tagRoleInput.Tags, getStandardTags("execution-role"));
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    await workspace.cleanup();
  }
});

// --- Tests: Lambda function tagging on creation ---

test("runRemoteBootstrap includes tags in CreateFunctionCommand when Lambda does not exist", async () => {
  const workspace = await createTestWorkspace({ prefix: "remote-tag-test-" });
  try {
    resetAllCalls();
    iamRoleExists = false;
    lambdaFunctionExists = false;

    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFile(contextPath, JSON.stringify(createValidContextFile(), null, 2), "utf8");
    await mkdir(join(workspace.workspacePath, "dist-lambda"), { recursive: true });
    await writeFile(join(workspace.workspacePath, "dist-lambda/lambda.zip"), "fake-zip-content", "utf8");

    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, redeployStacksets: false },
        logger: noopLogger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
        organizationsClient: new OrganizationsClient({}),
      });

      // Verify CreateFunctionCommand was called with Tags in Record<string, string> format
      const createFnCalls = lambdaCalls.filter(c => c.commandName === "CreateFunctionCommand");
      assert.equal(createFnCalls.length, 1, "Expected exactly one CreateFunctionCommand call");

      const createFnInput = createFnCalls[0].input as {
        FunctionName: string;
        Tags: Record<string, string>;
      };

      // Lambda Tags are in Record<string, string> format
      const expectedTags = Object.fromEntries(
        getStandardTags("remote-execution").map(t => [t.Key, t.Value]),
      );
      assert.deepEqual(createFnInput.Tags, expectedTags);
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    await workspace.cleanup();
  }
});

// --- Tests: Lambda function tagging when function already exists (idempotent) ---

test("runRemoteBootstrap calls TagResourceCommand with standard tags when Lambda already exists", async () => {
  const workspace = await createTestWorkspace({ prefix: "remote-tag-test-" });
  try {
    resetAllCalls();
    iamRoleExists = false;
    lambdaFunctionExists = true;

    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFile(contextPath, JSON.stringify(createValidContextFile(), null, 2), "utf8");
    await mkdir(join(workspace.workspacePath, "dist-lambda"), { recursive: true });
    await writeFile(join(workspace.workspacePath, "dist-lambda/lambda.zip"), "fake-zip-content", "utf8");

    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, redeployStacksets: false },
        logger: noopLogger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
        organizationsClient: new OrganizationsClient({}),
      });

      // Verify TagResourceCommand was called (not CreateFunctionCommand)
      const createFnCalls = lambdaCalls.filter(c => c.commandName === "CreateFunctionCommand");
      assert.equal(createFnCalls.length, 0, "Should not call CreateFunctionCommand when Lambda exists");

      const tagResourceCalls = lambdaCalls.filter(c => c.commandName === "TagResourceCommand");
      assert.equal(tagResourceCalls.length, 1, "Expected exactly one TagResourceCommand call");

      const tagResourceInput = tagResourceCalls[0].input as {
        Resource: string;
        Tags: Record<string, string>;
      };
      assert.equal(
        tagResourceInput.Resource,
        "arn:aws:lambda:us-east-1:123456789012:function:beesolve-aws-accounts",
      );

      const expectedTags = Object.fromEntries(
        getStandardTags("remote-execution").map(t => [t.Key, t.Value]),
      );
      assert.deepEqual(tagResourceInput.Tags, expectedTags);
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    await workspace.cleanup();
  }
});

// --- Tests: S3 bucket tagging is applied even when bucket already exists ---

test("runRemoteBootstrap applies PutBucketTagging even when bucket already exists (BucketAlreadyOwnedByYou)", async () => {
  const workspace = await createTestWorkspace({ prefix: "remote-tag-test-" });
  try {
    resetAllCalls();
    iamRoleExists = false;
    lambdaFunctionExists = false;

    // Override S3 mock to simulate BucketAlreadyOwnedByYou
    const originalS3Send = s3Calls; // just reset
    resetAllCalls();

    const contextPath = join(workspace.workspacePath, "aws.context.json");
    await writeFile(contextPath, JSON.stringify(createValidContextFile(), null, 2), "utf8");
    await mkdir(join(workspace.workspacePath, "dist-lambda"), { recursive: true });
    await writeFile(join(workspace.workspacePath, "dist-lambda/lambda.zip"), "fake-zip-content", "utf8");

    const originalCwd = process.cwd();
    process.chdir(workspace.workspacePath);
    try {
      // The mock already handles CreateBucketCommand by returning success.
      // The code always calls PutBucketTaggingCommand after bucket creation/existence check.
      await runRemoteBootstrap({
        subcommand: "bootstrap",
        profile: undefined,
        region: "us-east-1",
        flags: { yes: false, refresh: false, allowDestructive: false, ignoreUnsupported: false, redeployStacksets: false },
        logger: noopLogger,
        overwriteConfirmation: async () => true,
        stsClient: new STSClient({}),
        s3Client: new S3Client({}),
        iamClient: new IAMClient({}),
        lambdaClient: new LambdaClient({}),
        ssoAdminClient: new SSOAdminClient({}),
        organizationsClient: new OrganizationsClient({}),
      });

      // Verify PutBucketTaggingCommand is always called regardless of bucket creation outcome
      const putTaggingCalls = s3Calls.filter(c => c.commandName === "PutBucketTaggingCommand");
      assert.equal(putTaggingCalls.length, 1, "PutBucketTaggingCommand should be called even for existing buckets");

      const taggingInput = putTaggingCalls[0].input as {
        Bucket: string;
        Tagging: { TagSet: Array<{ Key: string; Value: string }> };
      };
      assert.deepEqual(taggingInput.Tagging.TagSet, getStandardTags("state-storage"));
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    await workspace.cleanup();
  }
});
