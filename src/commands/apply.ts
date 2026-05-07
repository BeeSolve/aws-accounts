import {
  MoveAccountCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
} from "../awsConfig.js";
import { diffStates } from "../diff.js";
import { assertUnreachable } from "../helpers.js";
import type { Operation, Plan } from "../operations.js";
import { readStateFile, type StateFile, writeStateFile } from "../state.js";
import type { Logger } from "../logger.js";

type ApplyCommandInput = {
  organizationsClient: OrganizationsClient;
  logger: Logger;
  configPath: string;
  typesPath: string;
  statePath: string;
  contextPath: string;
  ignoreUnsupported: boolean;
  planConfirmation: (props: { planLines: string[] }) => Promise<boolean>;
};

type ApplyCommandResult = {
  plan: Plan;
  appliedOperations: number;
  statePath: string;
  status: "applied" | "no-changes" | "cancelled" | "refused";
};

export async function runApplyCommand(
  props: ApplyCommandInput,
): Promise<ApplyCommandResult> {
  const [config, currentState, context] = await Promise.all([
    loadAwsConfigModelFromTsFile({
      configPath: props.configPath,
      typesPath: props.typesPath,
    }),
    readStateFile(props.statePath),
    readAwsContextFromFile(props.contextPath),
  ]);
  const nextState = mapAwsConfigToState({
    config: config,
    currentState: currentState,
    context: context,
  });
  const plan = diffStates({
    current: currentState,
    next: nextState,
  });

  const destructiveUnsupported = plan.unsupported.filter(
    (unsupportedDiff) => unsupportedDiff.category === "destructive",
  );
  if (destructiveUnsupported.length > 0) {
    props.logger.log("Unsupported diffs:");
    for (const unsupportedDiff of destructiveUnsupported) {
      props.logger.log(
        `  - ${unsupportedDiff.description} [${unsupportedDiff.category}]`,
      );
    }
    throw new Error(
      "Apply refused: destructive unsupported diffs are not allowed in increment 1.",
    );
  }

  if (plan.unsupported.length > 0 && props.ignoreUnsupported === false) {
    props.logger.log("Unsupported diffs:");
    for (const unsupportedDiff of plan.unsupported) {
      props.logger.log(
        `  - ${unsupportedDiff.description} [${unsupportedDiff.category}]`,
      );
    }
    throw new Error(
      "Apply refused: unsupported diffs detected. Re-run with --ignore-unsupported to apply supported operations only.",
    );
  }
  if (plan.unsupported.length > 0 && props.ignoreUnsupported) {
    props.logger.log(
      "Proceeding with supported operations only; unsupported diffs are skipped.",
    );
  }

  if (plan.operations.length === 0) {
    props.logger.log("No changes.");
    return {
      plan: plan,
      appliedOperations: 0,
      statePath: props.statePath,
      status: "no-changes",
    };
  }

  const planLines = buildApplyPlanLines({
    plan: plan,
  });
  for (const line of planLines) {
    props.logger.log(line);
  }
  const confirmed = await props.planConfirmation({
    planLines: planLines,
  });
  if (confirmed !== true) {
    props.logger.log("Apply cancelled.");
    return {
      plan: plan,
      appliedOperations: 0,
      statePath: props.statePath,
      status: "cancelled",
    };
  }

  const progressedState = structuredClone(currentState);
  let appliedOperations = 0;
  try {
    for (const operation of plan.operations) {
      await applyOperation({
        organizationsClient: props.organizationsClient,
        logger: props.logger,
        operation: operation,
      });
      applyOperationToState({
        state: progressedState,
        operation: operation,
      });
      appliedOperations += 1;
    }
  } catch (error) {
    await writeStateFile(props.statePath, progressedState);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Aborted after ${appliedOperations} of ${plan.operations.length} operations. state.json updated for successful operations. Run 'npm run cli -- scan' to verify, then re-run apply. Original error: ${message}`,
    );
  }

  await writeStateFile(props.statePath, nextState);
  props.logger.log(`Apply complete. Applied ${appliedOperations} operation(s).`);
  return {
    plan: plan,
    appliedOperations: appliedOperations,
    statePath: props.statePath,
    status: "applied",
  };
}

async function applyOperation(props: {
  organizationsClient: OrganizationsClient;
  logger: Logger;
  operation: Operation;
}): Promise<void> {
  const operation = props.operation;
  if (operation.kind === "moveAccount") {
    props.logger.log(
      `Moving "${operation.accountName}" (${operation.accountId}): ${operation.fromOuName} -> ${operation.toOuName}`,
    );
    await props.organizationsClient.send(
      new MoveAccountCommand({
        AccountId: operation.accountId,
        SourceParentId: operation.fromOuId,
        DestinationParentId: operation.toOuId,
      }),
    );
    props.logger.log(`Done: "${operation.accountName}"`);
    return;
  }
  assertUnreachable(operation.kind, "Unsupported operation kind in apply.");
}

function applyOperationToState(props: {
  state: StateFile;
  operation: Operation;
}): void {
  const operation = props.operation;
  if (operation.kind === "moveAccount") {
    const account = props.state.organization.accounts.find(
      (currentAccount) => currentAccount.id === operation.accountId,
    );
    if (account != null) {
      account.parentId = operation.toOuId;
    }
    return;
  }
  assertUnreachable(operation.kind, "Unsupported operation kind in apply.");
}

function buildApplyPlanLines(props: { plan: Plan }): string[] {
  const lines = [
    `Apply: ${props.plan.operations.length} operation(s), ${props.plan.unsupported.length} unsupported diff(s)`,
  ];
  for (const operation of props.plan.operations) {
    if (operation.kind === "moveAccount") {
      lines.push(
        `  move account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`,
      );
      continue;
    }
    assertUnreachable(
      operation.kind,
      "Unsupported operation kind in apply plan lines.",
    );
  }
  if (props.plan.unsupported.length > 0) {
    lines.push("Unsupported diffs:");
    for (const unsupportedDiff of props.plan.unsupported) {
      lines.push(
        `  - ${unsupportedDiff.description} [${unsupportedDiff.category}]`,
      );
    }
  }
  return lines;
}
