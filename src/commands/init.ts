import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { writeAwsConfigFromState } from "../awsConfig.js";
import type { Logger } from "../logger.js";
import { runBootstrapCommand } from "./bootstrap.js";
import { runScanCommand } from "./scan.js";

type InitCommandInput = {
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  logger: Logger;
  profile: string;
  region: string;
  instanceArn?: string;
  contextPath?: string;
  statePath?: string;
  configPath?: string;
  typesPath?: string;
  planConfirmation: (props: { planLines: string[] }) => Promise<boolean>;
  overwriteConfirmation: (props: { fileSummaries: string[] }) => Promise<boolean>;
};

type InitCommandResult = {
  contextPath: string;
  statePath: string;
  configPath: string;
  typesPath: string;
  files: Array<{ path: string; status: "written" | "unchanged" | "would-write" }>;
};

export async function runInitCommand(
  props: InitCommandInput,
): Promise<InitCommandResult> {
  const bootstrapResult = await runBootstrapCommand({
    organizationsClient: props.organizationsClient,
    ssoAdminClient: props.ssoAdminClient,
    logger: props.logger,
    profile: props.profile,
    region: props.region,
    instanceArn: props.instanceArn,
    outputPath: props.contextPath,
    planConfirmation: props.planConfirmation,
  });
  const scanResult = await runScanCommand({
    organizationsClient: props.organizationsClient,
    ssoAdminClient: props.ssoAdminClient,
    identityStoreClient: props.identityStoreClient,
    logger: props.logger,
    instanceArn: props.instanceArn,
    outputPath: props.statePath,
  });
  const configWriteResult = await writeAwsConfigFromState({
    statePath: scanResult.outputPath,
    contextPath: bootstrapResult.outputPath,
    configPath: props.configPath ?? "aws.config.ts",
    typesPath: props.typesPath ?? "aws.config.types.ts",
    logger: props.logger,
    overwriteConfirmation: props.overwriteConfirmation,
  });
  return {
    contextPath: bootstrapResult.outputPath,
    statePath: scanResult.outputPath,
    configPath: configWriteResult.configPath,
    typesPath: configWriteResult.typesPath,
    files: configWriteResult.files,
  };
}
