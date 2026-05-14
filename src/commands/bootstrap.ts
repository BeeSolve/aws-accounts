import {
  CreateOrganizationalUnitCommand,
  DescribeOrganizationCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  ListInstancesCommand,
  SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import type { Logger } from "../logger.js";

const graveyardOuName = "Graveyard";

const contextFilePath = "aws.context.json";

type BootstrapCommandInput = {
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  logger: Logger;
  profile: string;
  region: string;
  instanceArn?: string;
  outputPath?: string;
  planConfirmation: (props: { planLines: string[] }) => Promise<boolean>;
};

type BootstrapCommandResult = {
  outputPath: string;
  graveyardOuId: string;
  graveyardCreated: boolean;
  identityCenterCaptured: boolean;
};

export async function runBootstrapCommand(
  props: BootstrapCommandInput,
): Promise<BootstrapCommandResult> {
  const resolvedOutputPath = props.outputPath ?? contextFilePath;
  props.logger.log("Reading organization...");
  const [organizationDescription, rootsResponse] = await Promise.all([
    props.organizationsClient.send(new DescribeOrganizationCommand({})),
    props.organizationsClient.send(new ListRootsCommand({})),
  ]);
  const masterAccountId =
    organizationDescription.Organization?.MasterAccountId?.trim();
  if (masterAccountId == null) {
    throw new Error("Could not resolve organization management account id.");
  }

  const rootId = rootsResponse.Roots?.[0]?.Id?.trim();
  if (rootId == null) {
    throw new Error("Could not resolve organization root id.");
  }

  const initialDiscovery = await discoverBootstrapState({
    organizationsClient: props.organizationsClient,
    rootId,
  });
  if (initialDiscovery.analysis.ok === false) {
    throw new Error(initialDiscovery.analysis.reason);
  }

  const planLines = buildBootstrapPlanLines({
    analysis: initialDiscovery.analysis,
    rootId,
  });
  for (const line of planLines) {
    props.logger.log(line);
  }
  if (planLines.length > 0) {
    const confirmed = await props.planConfirmation({ planLines });
    if (confirmed !== true) {
      throw new Error("Bootstrap aborted.");
    }
  }

  await createMissingRequiredOus({
    organizationsClient: props.organizationsClient,
    logger: props.logger,
    rootId,
    analysis: initialDiscovery.analysis,
  });

  const finalDiscovery = await discoverBootstrapState({
    organizationsClient: props.organizationsClient,
    rootId,
  });
  if (finalDiscovery.analysis.ok === false) {
    throw new Error(finalDiscovery.analysis.reason);
  }
  if (finalDiscovery.analysis.graveyardOuId == null) {
    throw new Error(
      'Bootstrap failed: "Graveyard" organizational unit must exist under root after bootstrap.',
    );
  }

  const [instancesResponse, existingContext] = await Promise.all([
    props.ssoAdminClient.send(new ListInstancesCommand({})),
    readExistingAwsContext({
      path: resolvedOutputPath,
    }),
  ]);
  const identityCenter = resolveIdentityCenterForBootstrap({
    instances: instancesResponse.Instances ?? [],
    requestedInstanceArn: props.instanceArn,
  });

  const nextContext = buildAwsContextFile({
    managementAccountId: masterAccountId,
    rootId,
    graveyardOuId: finalDiscovery.analysis.graveyardOuId,
    identityCenter,
    profile: props.profile,
    region: props.region,
    existingDeployment: existingContext?.deployment,
  });

  if (existingContext != null) {
    assertAwsContextCompatibleWithExisting({
      existing: existingContext,
      next: nextContext,
    });
  }

  props.logger.log(`Writing ${resolvedOutputPath}...`);
  await writeAwsContextFile({
    path: resolvedOutputPath,
    context: nextContext,
  });

  return {
    outputPath: resolvedOutputPath,
    graveyardOuId: finalDiscovery.analysis.graveyardOuId,
    graveyardCreated: initialDiscovery.analysis.needsGraveyardCreate,
    identityCenterCaptured: identityCenter != null,
  };
}

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());

const organizationContextSchema = v.strictObject({
  managementAccountId: nonEmptyString,
  rootId: nonEmptyString,
  graveyardOuId: nonEmptyString,
});

const identityCenterContextSchema = v.strictObject({
  instanceArn: nonEmptyString,
  identityStoreId: nonEmptyString,
});

const deploymentContextSchema = v.strictObject({
  profile: v.string(),
  region: v.string(),
  lambdaArn: v.string(),
  stateBucketName: v.string(),
  stateCacheTtlSeconds: v.number(),
});

const awsContextSchema = v.strictObject({
  version: nonEmptyString,
  generatedAt: nonEmptyString,
  organization: organizationContextSchema,
  identityCenter: identityCenterContextSchema,
  deployment: v.optional(deploymentContextSchema),
});

type AwsContextFile = v.InferOutput<typeof awsContextSchema>;

function validateAwsContextFile(props: { value: unknown }): AwsContextFile {
  return v.parse(awsContextSchema, props.value);
}

type RootChildOu = {
  id: string;
  name: string;
  arn: string;
};

type BootstrapOuAnalysis =
  | {
      ok: true;
      graveyardOuId: string | undefined;
      needsGraveyardCreate: boolean;
    }
  | {
      ok: false;
      reason: string;
    };

function analyzeRootChildrenForBootstrap(props: {
  children: RootChildOu[];
}): BootstrapOuAnalysis {
  const graveyard = props.children.filter(
    (child) => child.name === graveyardOuName,
  );
  if (graveyard.length > 1) {
    return {
      ok: false,
      reason: `Multiple organizational units named "${graveyardOuName}" under root: ${graveyard.map((child) => `${child.id} (${child.arn})`).join("; ")}`,
    };
  }
  return {
    ok: true,
    graveyardOuId: graveyard[0]?.id,
    needsGraveyardCreate: graveyard.length === 0,
  };
}

function assertAwsContextCompatibleWithExisting(props: {
  existing: AwsContextFile;
  next: AwsContextFile;
}): void {
  const keys = [
    "managementAccountId",
    "rootId",
    "graveyardOuId",
  ] as const;
  for (const key of keys) {
    if (props.existing.organization[key] !== props.next.organization[key]) {
      throw new Error(
        `aws.context.json conflicts with live AWS resolution for organization.${key}: file has "${props.existing.organization[key]}" but resolved "${props.next.organization[key]}". Fix the file or AWS manually.`,
      );
    }
  }
  if (
    props.existing.identityCenter.instanceArn !==
      props.next.identityCenter.instanceArn ||
    props.existing.identityCenter.identityStoreId !==
      props.next.identityCenter.identityStoreId
  ) {
    throw new Error(
      "aws.context.json conflicts with bootstrap Identity Center resolution: identityCenter values differ.",
    );
  }
}

async function discoverBootstrapState(props: {
  organizationsClient: OrganizationsClient;
  rootId: string;
}): Promise<{
  children: RootChildOu[];
  analysis: BootstrapOuAnalysis;
}> {
  const children = await listDirectChildOrganizationalUnits({
    organizationsClient: props.organizationsClient,
    rootId: props.rootId,
  });
  const analysis = analyzeRootChildrenForBootstrap({
    children,
  });
  return { children, analysis };
}

async function listDirectChildOrganizationalUnits(props: {
  organizationsClient: OrganizationsClient;
  rootId: string;
}): Promise<RootChildOu[]> {
  const children: RootChildOu[] = [];
  let nextToken: string | undefined;
  do {
    const response = await props.organizationsClient.send(
      new ListOrganizationalUnitsForParentCommand({
        ParentId: props.rootId,
        NextToken: nextToken,
      }),
    );
    for (const ou of response.OrganizationalUnits ?? []) {
      if (ou.Id == null || ou.Name == null || ou.Arn == null) {
        continue;
      }
      children.push({
        id: ou.Id,
        name: ou.Name,
        arn: ou.Arn,
      });
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return children;
}

function buildBootstrapPlanLines(props: {
  rootId: string;
  analysis: Exclude<BootstrapOuAnalysis, { ok: false }>;
}): string[] {
  const lines: string[] = [];
  if (props.analysis.needsGraveyardCreate) {
    if (lines.length === 0) {
      lines.push(`Root organizational unit id: ${props.rootId}`);
    }
    lines.push(`Will create OU "${graveyardOuName}" under root.`);
  }
  return lines;
}

async function createMissingRequiredOus(props: {
  organizationsClient: OrganizationsClient;
  logger: Logger;
  rootId: string;
  analysis: Exclude<BootstrapOuAnalysis, { ok: false }>;
}): Promise<void> {
  if (props.analysis.needsGraveyardCreate) {
    props.logger.log(`Creating organizational unit "${graveyardOuName}"...`);
    await props.organizationsClient.send(
      new CreateOrganizationalUnitCommand({
        ParentId: props.rootId,
        Name: graveyardOuName,
      }),
    );
  }
}

type IdentityCenterInstance = {
  InstanceArn?: string;
  IdentityStoreId?: string;
};

function resolveIdentityCenterForBootstrap(props: {
  instances: IdentityCenterInstance[];
  requestedInstanceArn?: string;
}): { instanceArn: string; identityStoreId: string } {
  if (props.instances.length === 0) {
    throw new Error("No IAM Identity Center instance found.");
  }
  if (props.requestedInstanceArn != null) {
    const selected = props.instances.find(
      (instance) => instance.InstanceArn === props.requestedInstanceArn,
    );
    if (selected?.InstanceArn == null || selected.IdentityStoreId == null) {
      throw new Error(
        `Identity Center instance not found for --instance-arn: ${props.requestedInstanceArn}`,
      );
    }
    return {
      instanceArn: selected.InstanceArn,
      identityStoreId: selected.IdentityStoreId,
    };
  }
  if (props.instances.length > 1) {
    const knownArns = props.instances
      .map((instance) => instance.InstanceArn)
      .filter((value): value is string => value != null)
      .join(", ");
    throw new Error(
      `Multiple IAM Identity Center instances found. Re-run with --instance-arn. Available: ${knownArns}`,
    );
  }
  const only = props.instances[0];
  if (only.InstanceArn == null || only.IdentityStoreId == null) {
    throw new Error("IAM Identity Center instance is missing required fields.");
  }
  return {
    instanceArn: only.InstanceArn,
    identityStoreId: only.IdentityStoreId,
  };
}

async function readExistingAwsContext(props: {
  path: string;
}): Promise<AwsContextFile | undefined> {
  try {
    const raw = await readFile(props.path, "utf8");
    return validateAwsContextFile({
      value: JSON.parse(raw) as unknown,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code != null && code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

type BuildAwsContextFileProps = {
  managementAccountId: string;
  rootId: string;
  graveyardOuId: string;
  identityCenter: { instanceArn: string; identityStoreId: string };
  profile: string;
  region: string;
  existingDeployment?: AwsContextFile["deployment"];
};

function buildAwsContextFile(props: BuildAwsContextFileProps): AwsContextFile {
  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization: {
      managementAccountId: props.managementAccountId,
      rootId: props.rootId,
      graveyardOuId: props.graveyardOuId,
    },
    identityCenter: props.identityCenter,
    deployment: {
      profile: props.profile,
      region: props.region,
      lambdaArn: props.existingDeployment?.lambdaArn ?? "",
      stateBucketName: props.existingDeployment?.stateBucketName ?? "",
      stateCacheTtlSeconds: props.existingDeployment?.stateCacheTtlSeconds ?? 300,
    },
  };
}

async function writeAwsContextFile(props: {
  path: string;
  context: AwsContextFile;
}): Promise<void> {
  const validated = validateAwsContextFile({ value: props.context });
  const ordered: Record<string, unknown> = {
    version: validated.version,
    generatedAt: validated.generatedAt,
    organization: validated.organization,
    identityCenter: validated.identityCenter,
    deployment: validated.deployment,
  };
  await writeFile(props.path, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}
