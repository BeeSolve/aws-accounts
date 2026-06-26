import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import {
  readAwsContextFromFile,
  readPackageVersion,
  writeAwsConfigFromState,
} from "../awsConfig.js";
import { startProgressTimer } from "../helpers.js";
import { invokeLambda } from "../lambdaClient.js";
import { writeStateCache } from "../remoteStateCache.js";
import type { RemoteCommandInput } from "./remote.js";
import {
  cachePath,
  configFilePath,
  contextFilePath,
  formatLambdaError,
  readDeploymentFromContext,
  typesFilePath,
} from "./remote.js";
import { runRemoteDrift } from "./remoteDrift.js";

export async function runRemoteInit(input: RemoteCommandInput): Promise<void> {
  if (existsSync(configFilePath)) {
    input.logger.log("aws.config.ts already exists. Running drift check instead.");
    input.logger.log("To regenerate from scratch, delete aws.config.ts first.");
    input.logger.log("");
    await runRemoteDrift(input);
    return;
  }

  const [deployment, cliVersion] = await Promise.all([
    readDeploymentFromContext(),
    readPackageVersion(),
  ]);

  input.logger.log("Invoking remote scan...");
  const stopInitScanProgress = startProgressTimer((elapsed) => {
    input.logger.log(`Still scanning... (${elapsed}s)`);
  });
  const result = await invokeLambda({
    lambdaClient: input.lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: { action: "scan" },
  });
  stopInitScanProgress();

  if (!result.ok) {
    throw new Error(formatLambdaError(result.error));
  }

  const response = result.response;
  if (!("action" in response) || response.action !== "scan") {
    throw new Error("Unexpected response from Lambda scan action.");
  }

  input.logger.log("Scan complete.");
  input.logger.log(`  Organizational Units: ${response.summary.organizationalUnits}`);
  input.logger.log(`  Accounts: ${response.summary.accounts}`);
  input.logger.log(`  Users: ${response.summary.users}`);
  input.logger.log(`  Groups: ${response.summary.groups}`);
  input.logger.log(`  Permission Sets: ${response.summary.permissionSets}`);
  input.logger.log(`  Account Assignments: ${response.summary.accountAssignments}`);
  input.logger.log(`  Policies: ${response.summary.policies}`);
  input.logger.log(`  Policy Attachments: ${response.summary.policyAttachments}`);

  await writeStateCache(cachePath, response.state);
  input.logger.log("State cache updated.");

  // Update context file with real values from scan (replaces bootstrap placeholders)
  const context = await readAwsContextFromFile(contextFilePath);
  const graveyardOu = response.state.organization.organizationalUnits.find(
    (ou: { name: string }) => ou.name === "Graveyard",
  );
  const ordered: Record<string, unknown> = {
    version: context.version,
    generatedAt: new Date().toISOString(),
    organization: {
      id: response.state.organization.organizationId,
      managementAccountId: context.organization.managementAccountId,
      rootId: response.state.organization.rootId,
      graveyardOuId: graveyardOu?.id ?? context.organization.graveyardOuId,
    },
    identityCenter: {
      instanceArn: response.state.identityCenter.instanceArn,
      identityStoreId: response.state.identityCenter.identityStoreId,
    },
    deployment: { ...deployment, cliVersion },
  };
  await writeFile(contextFilePath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");

  const configWriteResult = await writeAwsConfigFromState({
    state: response.state,
    contextPath: contextFilePath,
    configPath: configFilePath,
    typesPath: typesFilePath,
    logger: input.logger,
    overwriteConfirmation: input.overwriteConfirmation,
  });

  const writtenFiles = configWriteResult.files.filter((f) => f.status === "written");
  if (writtenFiles.length > 0) {
    input.logger.log("");
    input.logger.log("Init complete.");
    for (const file of writtenFiles) {
      input.logger.log(`  ${file.path}: ${file.status}`);
    }
    input.logger.log("");
    input.logger.log("Next steps:");
    input.logger.log(
      "  1. Edit aws.config.ts to add accounts, OUs, users, groups, and permission sets",
    );
    input.logger.log("  2. Run 'plan' to preview what will change");
    input.logger.log("  3. Run 'apply' to execute the changes");
  }
}
