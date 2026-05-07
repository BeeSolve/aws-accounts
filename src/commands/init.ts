import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { writeAwsConfigFromState } from "../awsConfig.js";
import { runBootstrapCommand } from "./bootstrap.js";
import { runScanCommand } from "./scan.js";

type InitCommandInput = {
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
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
};

export async function runInitCommand(
  props: InitCommandInput,
): Promise<InitCommandResult> {
  const bootstrapResult = await runBootstrapCommand({
    organizationsClient: props.organizationsClient,
    ssoAdminClient: props.ssoAdminClient,
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
    instanceArn: props.instanceArn,
    outputPath: props.statePath,
  });
  const configWriteResult = await writeAwsConfigFromState({
    statePath: scanResult.outputPath,
    contextPath: bootstrapResult.outputPath,
    configPath: props.configPath ?? "aws.config.ts",
    typesPath: props.typesPath ?? "aws.config.types.ts",
    overwriteConfirmation: props.overwriteConfirmation,
  });
  return {
    contextPath: bootstrapResult.outputPath,
    statePath: scanResult.outputPath,
    configPath: configWriteResult.configPath,
    typesPath: configWriteResult.typesPath,
  };
}
