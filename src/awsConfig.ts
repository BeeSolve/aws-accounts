import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { iamPolicyDocumentSchema } from "@beesolve/iam-policy-ts";
import { build as esbuildBuild } from "esbuild";
import * as v from "valibot";

import {
  assertStateMatchesContext,
  mapAwsConfigToState as mapAwsConfigToStateImpl,
  mapStateToAwsConfig as mapStateToAwsConfigImpl,
} from "./awsConfigMapping.js";
import {
  renderAwsConfigTs,
  renderAwsConfigTypesTs,
  renderTsValue as renderTsValueImpl,
  sortAwsConfigModel,
} from "./awsConfigRender.js";
import { getErrorCode } from "./helpers.js";
import type { Logger } from "./logger.js";
import type { StateFile } from "./state.js";

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());

const deploymentSchema = v.strictObject({
  profile: v.string(),
  region: v.string(),
  lambdaArn: v.string(),
  stateBucketName: v.string(),
  stateCacheTtlSeconds: v.number(),
  lambdaMemoryMb: v.optional(v.number()),
  lambdaTimeoutSeconds: v.optional(v.number()),
  logsRetentionDays: v.optional(v.number()),
  cliVersion: v.string(),
});

export type Deployment = v.InferOutput<typeof deploymentSchema>;

const awsContextSchema = v.strictObject({
  version: nonEmptyString,
  generatedAt: nonEmptyString,
  organization: v.strictObject({
    id: v.optional(nonEmptyString),
    managementAccountId: nonEmptyString,
    rootId: nonEmptyString,
    graveyardOuId: nonEmptyString,
  }),
  identityCenter: v.strictObject({
    instanceArn: nonEmptyString,
    identityStoreId: nonEmptyString,
  }),
  deployment: v.optional(deploymentSchema),
  versionCheckLastRunAt: v.optional(nonEmptyString),
});

export type AwsContextFile = v.InferOutput<typeof awsContextSchema>;

export const awsConfigModelSchema = v.strictObject({
  organizationalUnits: v.array(
    v.strictObject({
      name: v.string(),
      parentName: v.nullable(v.string()),
      accounts: v.array(
        v.strictObject({
          name: v.string(),
          email: v.string(),
          tags: v.array(
            v.strictObject({
              key: v.string(),
              value: v.string(),
            }),
          ),
          alternateContacts: v.optional(
            v.array(
              v.strictObject({
                contactType: v.picklist(["BILLING", "OPERATIONS", "SECURITY"]),
                name: v.string(),
                email: v.string(),
                phone: v.string(),
                title: v.optional(v.string()),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
  users: v.array(
    v.strictObject({
      userName: v.string(),
      displayName: v.string(),
      email: v.string(),
    }),
  ),
  groups: v.array(
    v.strictObject({
      displayName: v.string(),
      description: v.optional(v.string()),
      members: v.array(v.string()),
    }),
  ),
  permissionSets: v.array(
    v.strictObject({
      name: v.string(),
      description: v.string(),
      sessionDuration: v.optional(v.string()),
      inlinePolicy: v.optional(iamPolicyDocumentSchema),
      awsManagedPolicies: v.array(v.string()),
      customerManagedPolicies: v.array(
        v.strictObject({
          name: v.string(),
          path: v.string(),
        }),
      ),
      permissionsBoundary: v.optional(
        v.union([
          v.strictObject({ managedPolicyArn: v.string() }),
          v.strictObject({
            customerManagedPolicyName: v.string(),
            customerManagedPolicyPath: v.string(),
          }),
        ]),
      ),
    }),
  ),
  assignments: v.array(
    v.strictObject({
      permissionSet: v.string(),
      group: v.optional(v.string()),
      user: v.optional(v.string()),
      accounts: v.array(v.string()),
    }),
  ),
  accessControlAttributes: v.array(
    v.strictObject({
      key: v.string(),
      source: v.array(v.string()),
    }),
  ),
  delegatedAdministrators: v.array(
    v.strictObject({
      account: v.string(),
      servicePrincipal: v.string(),
    }),
  ),
  policies: v.strictObject({
    serviceControlPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.string()),
      }),
    ),
    resourceControlPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.string()),
      }),
    ),
    tagPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.string()),
      }),
    ),
    aiServicesOptOutPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.string()),
      }),
    ),
    backupPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.string()),
      }),
    ),
  }),
  securityBaseline: v.optional(
    v.strictObject({
      stackSets: v.array(
        v.strictObject({
          name: v.string(),
          templateKey: v.string(),
          targets: v.array(v.string()),
          parameters: v.array(
            v.strictObject({
              key: v.string(),
              value: v.string(),
            }),
          ),
        }),
      ),
      configDeliveryBucket: v.optional(
        v.strictObject({
          accountName: v.string(),
        }),
      ),
      cloudTrailBucket: v.optional(
        v.strictObject({
          accountName: v.string(),
        }),
      ),
    }),
  ),
});

export type AwsConfigModel = v.InferOutput<typeof awsConfigModelSchema>;

type WriteAwsConfigFromStateInput = {
  state: StateFile;
  contextPath: string;
  configPath: string;
  typesPath: string;
  logger: Logger;
  overwriteConfirmation: (props: { fileSummaries: Array<string> }) => Promise<boolean>;
};

type WriteAwsConfigFromStateResult = {
  configPath: string;
  typesPath: string;
  files: Array<FileWriteResult>;
};

type RegenerateAwsConfigTypesInput = {
  configPath: string;
  typesPath: string;
  logger: Logger;
  overwriteConfirmation: (props: { fileSummaries: Array<string> }) => Promise<boolean>;
};

type RegenerateAwsConfigTypesResult = {
  typesPath: string;
  changed: boolean;
  files: Array<FileWriteResult>;
};

type AwsConfigTypesModule = {
  awsConfigSchema: v.GenericSchema;
};

const moduleDirectoryPath = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRootPath = resolve(moduleDirectoryPath, "..");

type ChangedFile = {
  path: string;
  previousBytes: number;
  nextBytes: number;
  content: string;
};

type FileWriteStatus = "written" | "unchanged" | "would-write";

type FileWriteResult = {
  path: string;
  status: FileWriteStatus;
};

export async function writeAwsConfigFromState(
  props: WriteAwsConfigFromStateInput,
): Promise<WriteAwsConfigFromStateResult> {
  const state = props.state;
  const context = await readAwsContextFile(props.contextPath);
  assertStateMatchesContext({
    state,
    context,
  });

  const mappedConfig = mapStateToAwsConfig({ state });
  const sortedConfig = sortAwsConfigModel({
    config: mappedConfig,
  });
  const nextConfigContent = renderAwsConfigTs({
    config: sortedConfig,
  });
  const nextTypesContent = renderAwsConfigTypesTs({
    config: sortedConfig,
  });

  const [currentConfigContent, currentTypesContent] = await Promise.all([
    readIfExists(props.configPath),
    readIfExists(props.typesPath),
  ]);

  const changedFiles: Array<ChangedFile> = [];
  if (currentConfigContent !== nextConfigContent) {
    changedFiles.push({
      path: props.configPath,
      previousBytes: Buffer.byteLength(currentConfigContent ?? "", "utf8"),
      nextBytes: Buffer.byteLength(nextConfigContent, "utf8"),
      content: nextConfigContent,
    });
  }
  if (currentTypesContent !== nextTypesContent) {
    changedFiles.push({
      path: props.typesPath,
      previousBytes: Buffer.byteLength(currentTypesContent ?? "", "utf8"),
      nextBytes: Buffer.byteLength(nextTypesContent, "utf8"),
      content: nextTypesContent,
    });
  }

  if (changedFiles.length === 0) {
    props.logger.log("No changes.");
    return {
      configPath: props.configPath,
      typesPath: props.typesPath,
      files: [
        {
          path: props.configPath,
          status: "unchanged",
        },
        {
          path: props.typesPath,
          status: "unchanged",
        },
      ],
    };
  }

  const fileSummaries = changedFiles.map(
    (file) => `${file.path}: ${file.previousBytes} -> ${file.nextBytes} bytes`,
  );
  for (const fileSummary of fileSummaries) {
    props.logger.log(fileSummary);
  }
  props.logger.log(`Review with: git diff ${props.configPath} ${props.typesPath}`);

  const shouldWrite = await props.overwriteConfirmation({
    fileSummaries,
  });
  if (!shouldWrite) {
    props.logger.log("Config write cancelled.");
    return {
      configPath: props.configPath,
      typesPath: props.typesPath,
      files: [
        {
          path: props.configPath,
          status: currentConfigContent === nextConfigContent ? "unchanged" : "would-write",
        },
        {
          path: props.typesPath,
          status: currentTypesContent === nextTypesContent ? "unchanged" : "would-write",
        },
      ],
    };
  }

  await Promise.all(changedFiles.map((file) => writeFile(file.path, file.content, "utf8")));
  return {
    configPath: props.configPath,
    typesPath: props.typesPath,
    files: [
      {
        path: props.configPath,
        status: currentConfigContent === nextConfigContent ? "unchanged" : "written",
      },
      {
        path: props.typesPath,
        status: currentTypesContent === nextTypesContent ? "unchanged" : "written",
      },
    ],
  };
}

export async function regenerateAwsConfigTypes(
  props: RegenerateAwsConfigTypesInput,
): Promise<RegenerateAwsConfigTypesResult> {
  const loadedConfig = await loadAwsConfigFromTsFile({
    configPath: props.configPath,
    schema: awsConfigModelSchema,
  });
  const sortedConfig = sortAwsConfigModel({
    config: loadedConfig,
  });
  const nextTypesContent = renderAwsConfigTypesTs({
    config: sortedConfig,
  });
  const currentTypesContent = await readIfExists(props.typesPath);
  if (currentTypesContent === nextTypesContent) {
    props.logger.log("No changes.");
    return {
      typesPath: props.typesPath,
      changed: false,
      files: [
        {
          path: props.typesPath,
          status: "unchanged",
        },
      ],
    };
  }

  const fileSummary = `${props.typesPath}: ${Buffer.byteLength(currentTypesContent ?? "", "utf8")} -> ${Buffer.byteLength(nextTypesContent, "utf8")} bytes`;
  props.logger.log(fileSummary);
  props.logger.log(`Review with: git diff ${props.typesPath}`);

  const shouldWrite = await props.overwriteConfirmation({
    fileSummaries: [fileSummary],
  });
  if (!shouldWrite) {
    props.logger.log("Types write cancelled.");
    return {
      typesPath: props.typesPath,
      changed: false,
      files: [
        {
          path: props.typesPath,
          status: "would-write",
        },
      ],
    };
  }

  await writeFile(props.typesPath, nextTypesContent, "utf8");
  return {
    typesPath: props.typesPath,
    changed: true,
    files: [
      {
        path: props.typesPath,
        status: "written",
      },
    ],
  };
}

export function mapStateToAwsConfig(props: { state: StateFile }): AwsConfigModel {
  return mapStateToAwsConfigImpl(props);
}

export function mapAwsConfigToState(props: {
  config: AwsConfigModel;
  currentState: StateFile;
  context: AwsContextFile;
}): StateFile {
  return mapAwsConfigToStateImpl(props);
}

export function renderTsValue(
  value: unknown,
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  return renderTsValueImpl(value, props);
}

async function readAwsContextFile(path: string): Promise<AwsContextFile> {
  const rawContent = await readFile(path, "utf8");
  const parsed = JSON.parse(rawContent) as unknown;
  return v.parse(awsContextSchema, parsed);
}

export async function loadAwsConfigModelFromTsFile(props: {
  configPath: string;
  typesPath: string;
}): Promise<AwsConfigModel> {
  const typesModule = await loadAwsConfigTypesModule({
    typesPath: props.typesPath,
  });
  return await loadAwsConfigFromTsFile({
    configPath: props.configPath,
    schema: typesModule.awsConfigSchema,
  });
}

export async function readAwsContextFromFile(path: string): Promise<AwsContextFile> {
  return readAwsContextFile(path);
}

const versionCheckTtlMs = 24 * 60 * 60 * 1000;

export async function checkForNewVersionIfNeeded(props: {
  contextPath: string;
  logger: Logger;
}): Promise<void> {
  try {
    let lastCheckedAt: string | undefined;
    let rawContext: Record<string, unknown> | undefined;
    try {
      const raw = await readFile(props.contextPath, "utf8");
      rawContext = JSON.parse(raw) as Record<string, unknown>;
      lastCheckedAt =
        typeof rawContext.versionCheckLastRunAt === "string"
          ? rawContext.versionCheckLastRunAt
          : undefined;
    } catch {
      // context file absent — proceed without TTL guard
    }

    if (lastCheckedAt != null) {
      const elapsed = Date.now() - new Date(lastCheckedAt).getTime();
      if (elapsed < versionCheckTtlMs) return;
    }

    const [currentVersion, latestVersion] = await Promise.all([
      readPackageVersion(),
      fetchLatestNpmVersion(),
    ]);

    if (rawContext != null) {
      await writeFile(
        props.contextPath,
        JSON.stringify({ ...rawContext, versionCheckLastRunAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    }

    if (latestVersion !== currentVersion) {
      props.logger.log("");
      props.logger.log(
        `A new version of aws-accounts is available: ${latestVersion} (you have ${currentVersion}). Run: npx @beesolve/aws-accounts@latest upgrade`,
      );
    }
  } catch {
    // version check is best-effort — never block or crash the CLI
  }
}

async function fetchLatestNpmVersion(): Promise<string> {
  const response = await fetch("https://registry.npmjs.org/@beesolve/aws-accounts/latest");
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string") throw new Error("Unexpected npm registry response.");
  return body.version;
}

export async function readPackageVersion(): Promise<string> {
  const thisFile = fileURLToPath(import.meta.url);
  // thisFile = <root>/dist/awsConfig.js → go up 2 levels to package root
  const packageDir = dirname(dirname(thisFile));
  const raw = await readFile(join(packageDir, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string") {
    throw new Error("Could not read version from package.json.");
  }
  return pkg.version;
}

async function loadAwsConfigTypesModule(props: {
  typesPath: string;
}): Promise<AwsConfigTypesModule> {
  const loadedModule = await loadTsModule({
    modulePath: props.typesPath,
  });
  if (
    loadedModule == null ||
    typeof loadedModule !== "object" ||
    "awsConfigSchema" in loadedModule === false
  ) {
    throw new Error(`Types module "${props.typesPath}" does not export awsConfigSchema.`);
  }
  const moduleWithSchema = loadedModule as {
    awsConfigSchema?: v.GenericSchema;
  };
  if (moduleWithSchema.awsConfigSchema == null) {
    throw new Error(`Types module "${props.typesPath}" does not export awsConfigSchema.`);
  }
  return {
    awsConfigSchema: moduleWithSchema.awsConfigSchema,
  };
}

async function loadAwsConfigFromTsFile(props: {
  configPath: string;
  schema: v.GenericSchema;
}): Promise<AwsConfigModel> {
  let loadedModule: unknown;
  try {
    loadedModule = await loadTsModule({
      modulePath: props.configPath,
    });
  } catch (error) {
    if (isValiErrorLike(error)) {
      throw new Error(
        `aws.config.ts validation failed: ${error instanceof Error ? error.message : String(error)}. If you recently edited names/references, re-run regenerate after fixing the config.`,
      );
    }
    throw error;
  }
  if (
    loadedModule == null ||
    typeof loadedModule !== "object" ||
    "default" in loadedModule === false
  ) {
    throw new Error(`Config module "${props.configPath}" must export a default config object.`);
  }
  const moduleWithDefault = loadedModule as { default?: unknown };
  if (moduleWithDefault.default == null) {
    throw new Error(`Config module "${props.configPath}" must export a default config object.`);
  }
  try {
    const validatedConfig = v.parse(props.schema, moduleWithDefault.default);
    return v.parse(awsConfigModelSchema, validatedConfig);
  } catch (error) {
    if (isValiErrorLike(error)) {
      throw new Error(
        `aws.config.ts validation failed: ${error instanceof Error ? error.message : String(error)}. If you recently edited names/references, re-run regenerate after fixing the config.`,
      );
    }
    throw error;
  }
}

async function loadTsModule(props: { modulePath: string }): Promise<unknown> {
  const resolvedModulePath = resolve(props.modulePath);
  const temporaryOutputPath = join(`aws-accounts-${randomUUID()}.mjs`);
  const temporaryOutputAtProjectRoot = join(projectRootPath, temporaryOutputPath);
  try {
    await esbuildBuild({
      entryPoints: [resolvedModulePath],
      outfile: temporaryOutputAtProjectRoot,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      absWorkingDir: projectRootPath,
      nodePaths: [join(projectRootPath, "node_modules")],
      external: ["@beesolve/aws-accounts", "@beesolve/aws-accounts/*"],
      write: true,
    });
    const moduleUrl = pathToFileURL(temporaryOutputAtProjectRoot).href;
    return await import(moduleUrl);
  } finally {
    await safeUnlink(temporaryOutputAtProjectRoot);
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
}

function resolveAccountNamesInPolicyContent(
  content: Record<string, unknown>,
  accountByName: Record<string, { id: string }>,
): Record<string, unknown> {
  const statements = (content as { Statement?: Array<unknown> }).Statement;
  if (!Array.isArray(statements)) return content;
  return {
    ...content,
    Statement: statements.map((stmt) => {
      if (stmt == null || typeof stmt !== "object") return stmt;
      const s = stmt as Record<string, unknown>;
      const condition = s.Condition as Record<string, unknown> | undefined;
      if (condition == null) return stmt;
      const sne = condition.StringNotEquals as Record<string, unknown> | undefined;
      if (sne == null) return stmt;
      const accounts = sne["aws:PrincipalAccount"];
      if (!Array.isArray(accounts)) return stmt;
      return {
        ...s,
        Condition: {
          ...condition,
          StringNotEquals: {
            ...sne,
            "aws:PrincipalAccount": accounts.map((name: string) => accountByName[name]?.id ?? name),
          },
        },
      };
    }),
  };
}

function resolveAccountIdsInPolicyContent(
  content: Record<string, unknown>,
  accountById: Record<string, { name: string }>,
): Record<string, unknown> {
  const statements = (content as { Statement?: Array<unknown> }).Statement;
  if (!Array.isArray(statements)) return content;
  return {
    ...content,
    Statement: statements.map((stmt) => {
      if (stmt == null || typeof stmt !== "object") return stmt;
      const s = stmt as Record<string, unknown>;
      const condition = s.Condition as Record<string, unknown> | undefined;
      if (condition == null) return stmt;
      const sne = condition.StringNotEquals as Record<string, unknown> | undefined;
      if (sne == null) return stmt;
      const accounts = sne["aws:PrincipalAccount"];
      if (!Array.isArray(accounts)) return stmt;
      return {
        ...s,
        Condition: {
          ...condition,
          StringNotEquals: {
            ...sne,
            "aws:PrincipalAccount": accounts.map((id: string) => accountById[id]?.name ?? id),
          },
        },
      };
    }),
  };
}

function isValiErrorLike(error: unknown): error is Error {
  return error instanceof v.ValiError || (error instanceof Error && error.name === "ValiError");
}

export async function regenerateTypesFromState(props: {
  state: StateFile;
  contextPath: string;
  configPath: string;
  typesPath: string;
  logger: Logger;
}): Promise<void> {
  try {
    const mappedConfig = mapStateToAwsConfig({ state: props.state });
    const sortedConfig = sortAwsConfigModel({ config: mappedConfig });
    const nextTypesContent = renderAwsConfigTypesTs({ config: sortedConfig });

    const currentTypesContent = await readIfExists(props.typesPath);

    if (currentTypesContent === nextTypesContent) {
      return;
    }

    await writeFile(props.typesPath, nextTypesContent, "utf8");
    props.logger.log("Updated aws.config.types.ts");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    props.logger.log(`Warning: Failed to regenerate types: ${message}`);
  }
}
