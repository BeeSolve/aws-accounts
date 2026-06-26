import { writeFile } from "node:fs/promises";
import {
  PutFunctionConcurrencyCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { readAwsContextFromFile, readPackageVersion } from "../awsConfig.js";
import type { RemoteCommandInput } from "./remote.js";
import {
  contextFilePath,
  readDeploymentFromContext,
  readLambdaZip,
  waitForLambdaReady,
  applyLambdaRolePolicy,
  ensureLogGroup,
} from "./remote.js";

export async function runRemoteUpgrade(input: RemoteCommandInput): Promise<void> {
  const [deployment, cliVersion, lambdaZip] = await Promise.all([
    readDeploymentFromContext(),
    readPackageVersion(),
    readLambdaZip(),
  ]);

  input.logger.log(`Updating Lambda function code: ${deployment.lambdaArn}`);
  await waitForLambdaReady(input.lambdaClient, deployment.lambdaArn);
  const updateResult = await input.lambdaClient.send(
    new UpdateFunctionCodeCommand({
      FunctionName: deployment.lambdaArn,
      ZipFile: lambdaZip,
    }),
  );

  const lastModified = updateResult.LastModified ?? "unknown";
  input.logger.log(`Lambda updated. Last modified: ${lastModified}`);

  await waitForLambdaReady(input.lambdaClient, deployment.lambdaArn);
  await input.lambdaClient.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: deployment.lambdaArn,
      MemorySize: deployment.lambdaMemoryMb ?? 1024,
      Timeout: deployment.lambdaTimeoutSeconds ?? 300,
    }),
  );

  input.logger.log("Updating IAM role policy...");
  await applyLambdaRolePolicy({
    iamClient: input.iamClient,
    bucketName: deployment.stateBucketName,
  });
  input.logger.log("IAM role policy updated.");

  try {
    await input.lambdaClient.send(
      new PutFunctionConcurrencyCommand({
        FunctionName: deployment.lambdaArn,
        ReservedConcurrentExecutions: 1,
      }),
    );
    input.logger.log("Reserved concurrency set to 1.");
  } catch (concurrencyError: unknown) {
    if ((concurrencyError as { name?: string }).name === "InvalidParameterValueException") {
      input.logger.log("Reserved concurrency not set (account quota still too low).");
    } else {
      throw concurrencyError;
    }
  }

  await ensureLogGroup({
    region: deployment.region,
    profile: deployment.profile,
    retentionDays: deployment.logsRetentionDays,
    logger: input.logger,
  });

  const context = await readAwsContextFromFile(contextFilePath);
  const ordered: Record<string, unknown> = {
    version: context.version,
    generatedAt: context.generatedAt,
    organization: context.organization,
    identityCenter: context.identityCenter,
    deployment: { ...deployment, cliVersion },
  };
  await writeFile(contextFilePath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");

  input.logger.log("");
  input.logger.log("Run drift to check for config differences before using plan/apply.");
}
