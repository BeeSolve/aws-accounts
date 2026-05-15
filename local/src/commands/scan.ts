import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { writeStateFile, type StateFile } from "../state.js";
import type { Logger } from "../logger.js";
import { scanOrganization, scanIdentityCenter } from "../scanLogic.js";

const outputPath = "state.json";

type ScanCommandInput = {
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  logger: Logger;
  instanceArn?: string;
  outputPath?: string;
};

type ScanCommandResult = {
  outputPath: string;
  state: StateFile;
};

export async function runScanCommand(
  props: ScanCommandInput,
): Promise<ScanCommandResult> {
  props.logger.log("Scanning organization and identity center...");
  const [organization, identityCenter] = await Promise.all([
    scanOrganization({
      organizationsClient: props.organizationsClient,
    }),
    scanIdentityCenter({
      ssoAdminClient: props.ssoAdminClient,
      identityStoreClient: props.identityStoreClient,
      requestedInstanceArn: props.instanceArn,
    }),
  ]);

  const state: StateFile = {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization,
    identityCenter,
  };

  const resolvedOutputPath = props.outputPath ?? outputPath;
  props.logger.log(`Writing ${resolvedOutputPath}...`);
  await writeStateFile(resolvedOutputPath, state);
  return { outputPath: resolvedOutputPath, state };
}
