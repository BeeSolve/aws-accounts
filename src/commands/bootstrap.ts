import {
  CreateOrganizationalUnitCommand,
  DescribeOrganizationCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import { ListInstancesCommand, SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import { type AwsClientConfig } from "../awsClientConfig.js";

export const pendingOuName = "Pending";
export const graveyardOuName = "Graveyard";

const contextFilePath = "aws.context.json";
const nonEmptyString = v.pipe(v.string(), v.minLength(1));

const organizationContextSchema = v.strictObject({
  managementAccountId: nonEmptyString,
  rootId: nonEmptyString,
  pendingOuId: nonEmptyString,
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
});

const awsContextSchema = v.strictObject({
  version: nonEmptyString,
  generatedAt: nonEmptyString,
  organization: organizationContextSchema,
  identityCenter: identityCenterContextSchema,
  deployment: deploymentContextSchema,
});

export type AwsContextFile = v.InferOutput<typeof awsContextSchema>;

export type RootChildOu = {
  id: string;
  name: string;
  arn: string;
};

export type BootstrapOuAnalysis =
  | {
      ok: true;
      pendingOuId: string | undefined;
      graveyardOuId: string | undefined;
      needsPendingCreate: boolean;
      needsGraveyardCreate: boolean;
    }
  | {
      ok: false;
      reason: string;
    };

export type BootstrapPlanConfirmationProps = {
  planLines: string[];
};

export type BootstrapPlanConfirmation = (
  props: BootstrapPlanConfirmationProps,
) => Promise<boolean>;

export type BootstrapCommandInput = {
  clientConfig: AwsClientConfig;
  profile: string;
  region: string;
  instanceArn?: string;
  planConfirmation: BootstrapPlanConfirmation;
};

export type BootstrapCommandResult = {
  outputPath: string;
  pendingOuId: string;
  graveyardOuId: string;
  pendingCreated: boolean;
  graveyardCreated: boolean;
  identityCenterCaptured: boolean;
};

type IdentityCenterInstance = {
  InstanceArn?: string;
  IdentityStoreId?: string;
};

type DiscoverBootstrapStateResult = {
  children: RootChildOu[];
  analysis: BootstrapOuAnalysis;
};

export async function runBootstrapCommand(
  props: BootstrapCommandInput,
): Promise<BootstrapCommandResult> {
  const organizationsClient = new OrganizationsClient(props.clientConfig);
  const ssoAdminClient = new SSOAdminClient(props.clientConfig);

  console.log("Reading organization...");
  const organizationDescription = await organizationsClient.send(
    new DescribeOrganizationCommand({}),
  );
  const masterAccountId = organizationDescription.Organization?.MasterAccountId?.trim();
  if (masterAccountId == null) {
    throw new Error("Could not resolve organization management account id.");
  }

  const rootsResponse = await organizationsClient.send(new ListRootsCommand({}));
  const rootId = rootsResponse.Roots?.[0]?.Id?.trim();
  if (rootId == null) {
    throw new Error("Could not resolve organization root id.");
  }

  const initialDiscovery = await discoverBootstrapState({
    organizationsClient: organizationsClient,
    rootId: rootId,
  });
  if (initialDiscovery.analysis.ok === false) {
    throw new Error(initialDiscovery.analysis.reason);
  }

  const planLines = buildBootstrapPlanLines({
    analysis: initialDiscovery.analysis,
    rootId: rootId,
  });
  for (const line of planLines) {
    console.log(line);
  }
  if (planLines.length > 0) {
    const confirmed = await props.planConfirmation({ planLines: planLines });
    if (confirmed !== true) {
      throw new Error("Bootstrap aborted.");
    }
  }

  await createMissingRequiredOus({
    organizationsClient: organizationsClient,
    rootId: rootId,
    analysis: initialDiscovery.analysis,
  });

  const finalDiscovery = await discoverBootstrapState({
    organizationsClient: organizationsClient,
    rootId: rootId,
  });
  if (finalDiscovery.analysis.ok === false) {
    throw new Error(finalDiscovery.analysis.reason);
  }
  if (finalDiscovery.analysis.pendingOuId == null || finalDiscovery.analysis.graveyardOuId == null) {
    throw new Error(
      "Bootstrap failed: Pending and Graveyard organizational units must exist under root after bootstrap.",
    );
  }

  const instancesResponse = await ssoAdminClient.send(new ListInstancesCommand({}));
  const identityCenter = resolveIdentityCenterForBootstrap({
    instances: instancesResponse.Instances ?? [],
    requestedInstanceArn: props.instanceArn,
  });
  const existingContext = await readExistingAwsContext({ path: contextFilePath });

  const nextContext = buildAwsContextFile({
    managementAccountId: masterAccountId,
    rootId: rootId,
    pendingOuId: finalDiscovery.analysis.pendingOuId,
    graveyardOuId: finalDiscovery.analysis.graveyardOuId,
    identityCenter: identityCenter,
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

  console.log(`Writing ${contextFilePath}...`);
  await writeAwsContextFile({
    path: contextFilePath,
    context: nextContext,
  });

  return {
    outputPath: contextFilePath,
    pendingOuId: finalDiscovery.analysis.pendingOuId,
    graveyardOuId: finalDiscovery.analysis.graveyardOuId,
    pendingCreated: initialDiscovery.analysis.needsPendingCreate,
    graveyardCreated: initialDiscovery.analysis.needsGraveyardCreate,
    identityCenterCaptured: identityCenter != null,
  };
}

type ValidateAwsContextFileProps = {
  value: unknown;
};

export function validateAwsContextFile(props: ValidateAwsContextFileProps): AwsContextFile {
  return v.parse(awsContextSchema, props.value);
}

type AnalyzeRootChildrenForBootstrapProps = {
  children: RootChildOu[];
};

export function analyzeRootChildrenForBootstrap(props: AnalyzeRootChildrenForBootstrapProps): BootstrapOuAnalysis {
  const pending = props.children.filter((child) => child.name === pendingOuName);
  const graveyard = props.children.filter((child) => child.name === graveyardOuName);
  if (pending.length > 1) {
    return {
      ok: false,
      reason: `Multiple organizational units named "${pendingOuName}" under root: ${pending.map((child) => `${child.id} (${child.arn})`).join("; ")}`,
    };
  }
  if (graveyard.length > 1) {
    return {
      ok: false,
      reason: `Multiple organizational units named "${graveyardOuName}" under root: ${graveyard.map((child) => `${child.id} (${child.arn})`).join("; ")}`,
    };
  }
  return {
    ok: true,
    pendingOuId: pending[0]?.id,
    graveyardOuId: graveyard[0]?.id,
    needsPendingCreate: pending.length === 0,
    needsGraveyardCreate: graveyard.length === 0,
  };
}

type AssertAwsContextCompatibleWithExistingProps = {
  existing: AwsContextFile;
  next: AwsContextFile;
};

export function assertAwsContextCompatibleWithExisting(
  props: AssertAwsContextCompatibleWithExistingProps,
): void {
  const keys = ["managementAccountId", "rootId", "pendingOuId", "graveyardOuId"] as const;
  for (const key of keys) {
    if (props.existing.organization[key] !== props.next.organization[key]) {
      throw new Error(
        `aws.context.json conflicts with live AWS resolution for organization.${key}: file has "${props.existing.organization[key]}" but resolved "${props.next.organization[key]}". Fix the file or AWS manually.`,
      );
    }
  }
  if (
    props.existing.identityCenter.instanceArn !== props.next.identityCenter.instanceArn ||
    props.existing.identityCenter.identityStoreId !== props.next.identityCenter.identityStoreId
  ) {
    throw new Error(
      "aws.context.json conflicts with bootstrap Identity Center resolution: identityCenter values differ.",
    );
  }
}

type DiscoverBootstrapStateProps = {
  organizationsClient: OrganizationsClient;
  rootId: string;
};

async function discoverBootstrapState(props: DiscoverBootstrapStateProps): Promise<DiscoverBootstrapStateResult> {
  const children = await listDirectChildOrganizationalUnits({
    organizationsClient: props.organizationsClient,
    rootId: props.rootId,
  });
  const analysis = analyzeRootChildrenForBootstrap({
    children: children,
  });
  return { children, analysis };
}

type ListDirectChildOrganizationalUnitsProps = {
  organizationsClient: OrganizationsClient;
  rootId: string;
};

async function listDirectChildOrganizationalUnits(props: ListDirectChildOrganizationalUnitsProps): Promise<RootChildOu[]> {
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

type BuildBootstrapPlanLinesProps = {
  rootId: string;
  analysis: Exclude<BootstrapOuAnalysis, { ok: false }>;
};

function buildBootstrapPlanLines(props: BuildBootstrapPlanLinesProps): string[] {
  const lines: string[] = [];
  if (props.analysis.needsPendingCreate) {
    lines.push(`Root organizational unit id: ${props.rootId}`);
    lines.push(`Will create OU "${pendingOuName}" under root.`);
  }
  if (props.analysis.needsGraveyardCreate) {
    if (lines.length === 0) {
      lines.push(`Root organizational unit id: ${props.rootId}`);
    }
    lines.push(`Will create OU "${graveyardOuName}" under root.`);
  }
  return lines;
}

type CreateMissingRequiredOusProps = {
  organizationsClient: OrganizationsClient;
  rootId: string;
  analysis: Exclude<BootstrapOuAnalysis, { ok: false }>;
};

async function createMissingRequiredOus(props: CreateMissingRequiredOusProps): Promise<void> {
  if (props.analysis.needsPendingCreate) {
    console.log(`Creating organizational unit "${pendingOuName}"...`);
    await props.organizationsClient.send(
      new CreateOrganizationalUnitCommand({
        ParentId: props.rootId,
        Name: pendingOuName,
      }),
    );
  }
  if (props.analysis.needsGraveyardCreate) {
    console.log(`Creating organizational unit "${graveyardOuName}"...`);
    await props.organizationsClient.send(
      new CreateOrganizationalUnitCommand({
        ParentId: props.rootId,
        Name: graveyardOuName,
      }),
    );
  }
}

type ResolveIdentityCenterForBootstrapProps = {
  instances: IdentityCenterInstance[];
  requestedInstanceArn?: string;
};

function resolveIdentityCenterForBootstrap(
  props: ResolveIdentityCenterForBootstrapProps,
): { instanceArn: string; identityStoreId: string } {
  if (props.instances.length === 0) {
    throw new Error("No IAM Identity Center instance found.");
  }
  if (props.requestedInstanceArn != null) {
    const selected = props.instances.find((instance) => instance.InstanceArn === props.requestedInstanceArn);
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

type ReadExistingAwsContextProps = {
  path: string;
};

async function readExistingAwsContext(props: ReadExistingAwsContextProps): Promise<AwsContextFile | undefined> {
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
  pendingOuId: string;
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
      pendingOuId: props.pendingOuId,
      graveyardOuId: props.graveyardOuId,
    },
    identityCenter: props.identityCenter,
    deployment: {
      profile: props.profile,
      region: props.region,
      lambdaArn: props.existingDeployment?.lambdaArn ?? "",
      stateBucketName: props.existingDeployment?.stateBucketName ?? "",
    },
  };
}

type WriteAwsContextFileProps = {
  path: string;
  context: AwsContextFile;
};

async function writeAwsContextFile(props: WriteAwsContextFileProps): Promise<void> {
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
