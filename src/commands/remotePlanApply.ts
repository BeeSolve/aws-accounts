import { createInterface } from "node:readline/promises";

import {
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
  regenerateTypesFromState,
} from "../awsConfig.js";
import { diffStates } from "../diff.js";
import { startProgressTimer } from "../helpers.js";
import { invokeLambda } from "../lambdaClient.js";
import { writeStateCache } from "../remoteStateCache.js";
import { applyReservedOuDeletionGuard } from "../reservedOuDeletion.js";
import type { RemoteCommandInput } from "./remote.js";
import {
  cachePath,
  configFilePath,
  contextFilePath,
  typesFilePath,
  checkPendingStackSetOperations,
  computeStackSetOperations,
  displayPlan,
  executeStackSetOperations,
  fetchCurrentState,
  formatLambdaError,
  isDestructiveOperation,
  readDeploymentFromContext,
  warnIfRemotePoliciesNotInConfig,
} from "./remote.js";

export async function runRemotePlan(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();
  const currentState = await fetchCurrentState({
    input,
    deployment,
  });

  await checkPendingStackSetOperations({
    state: currentState,
    lambdaClient: input.lambdaClient,
    lambdaArn: deployment.lambdaArn,
    logger: input.logger,
  });

  const [context, config] = await Promise.all([
    readAwsContextFromFile(contextFilePath),
    loadAwsConfigModelFromTsFile({
      configPath: configFilePath,
      typesPath: typesFilePath,
    }),
  ]);

  warnIfRemotePoliciesNotInConfig({ currentState, config, logger: input.logger });

  const desiredState = mapAwsConfigToState({
    config,
    currentState,
    context,
  });

  const plan = applyReservedOuDeletionGuard({
    plan: diffStates({
      current: currentState,
      next: desiredState,
    }),
    context,
  });

  const ouIdsByName = Object.fromEntries(
    currentState.organization.organizationalUnits.map((ou) => [ou.name, ou.id]),
  );
  ouIdsByName["root"] = context.organization.rootId;
  const stackSetOperations = computeStackSetOperations(config, {
    managementAccountId: context.organization.managementAccountId,
    organizationId: context.organization.id,
    region: deployment.region,
    ouIdsByName,
    deployedStackSets: currentState.deployedStackSets,
  });

  if (plan.operations.length === 0 && (stackSetOperations?.length ?? 0) === 0) {
    input.logger.log("No changes: aws.config.ts already matches the current remote state.");
    input.logger.log("");
    input.logger.log("Edit aws.config.ts to make changes, then run 'plan' again.");
    return;
  }

  displayPlan({ plan, stackSetOperations, logger: input.logger });
  input.logger.log("");
  input.logger.log("Run 'apply' to execute these changes.");
}

export async function runRemoteApply(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();
  let currentState = await fetchCurrentState({
    input,
    deployment,
  });

  await checkPendingStackSetOperations({
    state: currentState,
    lambdaClient: input.lambdaClient,
    lambdaArn: deployment.lambdaArn,
    logger: input.logger,
  });

  const [context, config] = await Promise.all([
    readAwsContextFromFile(contextFilePath),
    loadAwsConfigModelFromTsFile({
      configPath: configFilePath,
      typesPath: typesFilePath,
    }),
  ]);

  warnIfRemotePoliciesNotInConfig({ currentState, config, logger: input.logger });

  const desiredState = mapAwsConfigToState({
    config,
    currentState,
    context,
  });

  const plan = applyReservedOuDeletionGuard({
    plan: diffStates({
      current: currentState,
      next: desiredState,
    }),
    context,
  });

  const ouIdsByName = Object.fromEntries(
    currentState.organization.organizationalUnits.map((ou) => [ou.name, ou.id]),
  );
  ouIdsByName["root"] = context.organization.rootId;
  const stackSetOperations = computeStackSetOperations(config, {
    managementAccountId: context.organization.managementAccountId,
    organizationId: context.organization.id,
    region: deployment.region,
    ouIdsByName,
    deployedStackSets: currentState.deployedStackSets,
    forceRedeploy: input.flags.redeployStacksets,
  });

  if (plan.operations.length === 0 && (stackSetOperations?.length ?? 0) === 0) {
    input.logger.log("No changes: aws.config.ts already matches the current remote state.");
    input.logger.log(
      "If you expected changes, verify your config with aws-accounts validate or run with --refresh to fetch fresh state.",
    );
    return;
  }

  const hasChanges =
    plan.operations.length > 0 || (stackSetOperations != null && stackSetOperations.length > 0);

  if (hasChanges) {
    displayPlan({ plan, stackSetOperations, logger: input.logger });

    if (plan.operations.some(isDestructiveOperation) && !input.flags.allowDestructive) {
      throw new Error("Destructive operations detected. Pass --allow-destructive to proceed.");
    }

    if (!input.flags.yes) {
      if (process.stdin.isTTY !== true) {
        throw new Error("Refusing to apply changes in non-interactive mode without --yes.");
      }
      const readlineInterface = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await readlineInterface.question(
          "Proceed with applying these changes? [y/N] ",
        );
        const normalized = answer.trim().toLowerCase();
        if (normalized !== "y" && normalized !== "yes") {
          input.logger.log("Apply cancelled.");
          return;
        }
      } finally {
        readlineInterface.close();
      }
    }
  }

  if (hasChanges) {
    if (plan.operations.length > 0) {
      input.logger.log("Applying changes remotely...");
      const stopProgress = startProgressTimer((elapsed) => {
        input.logger.log(`Still applying... (${elapsed}s)`);
      });
      const result = await invokeLambda({
        lambdaClient: input.lambdaClient,
        lambdaArn: deployment.lambdaArn,
        payload: {
          action: "apply",
          operations: plan.operations,
          allowDestructive: input.flags.allowDestructive,
        },
      });
      stopProgress();

      if (!result.ok) {
        const error = result.error;
        if (error.kind === "concurrencyConflict") {
          input.logger.log("Another apply is in progress. Retry later.");
          return;
        }
        if (error.kind === "operationFailed") {
          input.logger.log(
            `Apply failed at operation ${error.failedOperation + 1} of ${error.totalOperations}: ${error.error}`,
          );
          await writeStateCache(cachePath, error.partialState);
          input.logger.log("State cache updated with partial state.");
          input.logger.log("Run aws-accounts scan --refresh to refresh state before retrying.");
          return;
        }
        throw new Error(formatLambdaError(error));
      }

      const response = result.response;
      if (!("action" in response) || response.action !== "apply") {
        throw new Error("Unexpected response from Lambda apply action.");
      }

      input.logger.log(`Applied ${response.operationsCompleted} operation(s).`);
      await writeStateCache(cachePath, response.state);
      currentState = response.state;

      await regenerateTypesFromState({
        state: response.state,
        contextPath: contextFilePath,
        configPath: configFilePath,
        typesPath: typesFilePath,
        logger: input.logger,
      });
    }

    if (stackSetOperations != null && stackSetOperations.length > 0) {
      const securitySetupOps = stackSetOperations.filter(
        (op) => op.stackSetName === "security-setup",
      );
      const remainingOps = stackSetOperations.filter((op) => op.stackSetName !== "security-setup");

      let allPendingOps: Array<{ stackSetName: string; operationId: string; startedAt: string }> =
        [];

      if (securitySetupOps.length > 0) {
        const pending = await executeStackSetOperations({
          stackSetOperations: securitySetupOps,
          lambdaClient: input.lambdaClient,
          lambdaArn: deployment.lambdaArn,
          logger: input.logger,
        });
        allPendingOps = allPendingOps.concat(pending);
      }

      if (remainingOps.length > 0) {
        const pending = await executeStackSetOperations({
          stackSetOperations: remainingOps,
          lambdaClient: input.lambdaClient,
          lambdaArn: deployment.lambdaArn,
          logger: input.logger,
        });
        allPendingOps = allPendingOps.concat(pending);
      }

      // Record deployed StackSets in state for idempotency
      const newlyDeployed = stackSetOperations.map((op) => ({
        name: op.stackSetName,
        targets: op.targets,
      }));
      const previouslyDeployed = (currentState.deployedStackSets ?? []).filter(
        (d) => !newlyDeployed.some((n) => n.name === d.name),
      );
      const allDeployed = [...previouslyDeployed, ...newlyDeployed];
      await invokeLambda({
        lambdaClient: input.lambdaClient,
        lambdaArn: deployment.lambdaArn,
        payload: {
          action: "recordDeployedStackSets" as const,
          stackSets: allDeployed,
          pendingOperations: allPendingOps,
        },
      });

      // Update local cache so next plan sees the deployed stacksets
      const updatedState = {
        ...currentState,
        deployedStackSets: allDeployed,
        pendingStackSetOperations: allPendingOps.length > 0 ? allPendingOps : undefined,
      };
      await writeStateCache(cachePath, updatedState);
    }
  }

  // Ensure Config delivery bucket and aggregator exist when deploying security baseline StackSets
  if (stackSetOperations != null && stackSetOperations.length > 0) {
    const deliveryBucket = config.securityBaseline?.configDeliveryBucket;
    if (deliveryBucket) {
      const deliveryBucketName = `config-delivery-${context.organization.id!}-${deployment.region}`;
      const deliveryAccountId = currentState.organization.accounts.find(
        (a) => a.name === deliveryBucket.accountName,
      )?.id;
      if (deliveryAccountId) {
        input.logger.log(
          `  [bucket] creating Config delivery bucket "${deliveryBucketName}" in account ${deliveryAccountId}...`,
        );
        const bucketResult = await invokeLambda({
          lambdaClient: input.lambdaClient,
          lambdaArn: deployment.lambdaArn,
          payload: {
            action: "createConfigDeliveryBucket" as const,
            targetAccountId: deliveryAccountId,
            bucketName: deliveryBucketName,
            region: deployment.region,
          },
        });
        if (!bucketResult.ok) {
          throw new Error(
            `Failed to create Config delivery bucket: ${formatLambdaError(bucketResult.error)}`,
          );
        }
        input.logger.log(`  [bucket] Config delivery bucket ready.`);
      }
    }

    // Ensure Config aggregator exists in the delegated admin account (idempotent)
    const configDelegatedAdmin = config.delegatedAdministrators?.find(
      (d) => d.servicePrincipal === "config.amazonaws.com",
    );
    if (configDelegatedAdmin) {
      const adminAccountId = currentState.organization.accounts.find(
        (a) => a.name === configDelegatedAdmin.account,
      )?.id;
      if (adminAccountId) {
        input.logger.log(
          `  [aggregator] creating Config aggregator in account ${adminAccountId}...`,
        );
        const aggResult = await invokeLambda({
          lambdaClient: input.lambdaClient,
          lambdaArn: deployment.lambdaArn,
          payload: {
            action: "createConfigAggregator" as const,
            targetAccountId: adminAccountId,
            region: deployment.region,
          },
        });
        if (!aggResult.ok) {
          input.logger.log(`  [aggregator] warning: ${formatLambdaError(aggResult.error)}`);
        } else {
          input.logger.log(`  [aggregator] Config aggregator ready.`);
        }
      }
    }

    // Ensure CloudTrail log bucket and org trail exist
    const cloudTrailBucket = config.securityBaseline?.cloudTrailBucket;
    if (cloudTrailBucket) {
      const trailBucketName = `cloudtrail-logs-${context.organization.id!}-${deployment.region}`;
      const trailBucketAccountId = currentState.organization.accounts.find(
        (a) => a.name === cloudTrailBucket.accountName,
      )?.id;
      if (trailBucketAccountId) {
        input.logger.log(
          `  [cloudtrail] creating CloudTrail log bucket "${trailBucketName}" in account ${trailBucketAccountId}...`,
        );
        const bucketResult = await invokeLambda({
          lambdaClient: input.lambdaClient,
          lambdaArn: deployment.lambdaArn,
          payload: {
            action: "createCloudTrailBucket" as const,
            targetAccountId: trailBucketAccountId,
            bucketName: trailBucketName,
            region: deployment.region,
            organizationId: context.organization.id!,
          },
        });
        if (!bucketResult.ok) {
          input.logger.log(`  [cloudtrail] warning: ${formatLambdaError(bucketResult.error)}`);
        } else {
          input.logger.log(`  [cloudtrail] CloudTrail log bucket ready.`);
          input.logger.log(`  [cloudtrail] creating organization trail...`);
          const trailResult = await invokeLambda({
            lambdaClient: input.lambdaClient,
            lambdaArn: deployment.lambdaArn,
            payload: {
              action: "createOrgTrail" as const,
              bucketName: trailBucketName,
              region: deployment.region,
            },
          });
          if (!trailResult.ok) {
            input.logger.log(`  [cloudtrail] warning: ${formatLambdaError(trailResult.error)}`);
          } else {
            input.logger.log(`  [cloudtrail] Organization trail ready.`);
          }
        }
      }
    }
  }
}
