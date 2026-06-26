import { LambdaClient } from "@aws-sdk/client-lambda";

import { buildAwsClientConfig } from "../awsClientConfig.js";
import { startProgressTimer } from "../helpers.js";
import { invokeLambda } from "../lambdaClient.js";
import { writeStateCache } from "../remoteStateCache.js";
import type { RemoteCommandInput } from "./remote.js";
import { cachePath, formatLambdaError, readDeploymentFromContext } from "./remote.js";

export async function runRemoteScan(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();

  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  input.logger.log("Invoking remote scan...");
  const stopScanProgress = startProgressTimer((elapsed) => {
    input.logger.log(`Still scanning... (${elapsed}s)`);
  });
  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: { action: "scan" },
  });
  stopScanProgress();

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
}
