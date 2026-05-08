import {
  CreateOrganizationalUnitCommand,
  MoveAccountCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import { createAccountAndMoveToOu } from "../accountCreation.js";
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
  runtime: {
    createAccount: {
      timeoutInMs: number;
      pollIntervalInMs: number;
    };
  };
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

  let progressedState = structuredClone(currentState);
  let appliedOperations = 0;
  try {
    for (const operation of plan.operations) {
      progressedState = await applyOperation({
        state: progressedState,
        organizationsClient: props.organizationsClient,
        logger: props.logger,
        context: context,
        runtime: props.runtime,
        operation: operation,
      });
      appliedOperations += 1;
    }
  } catch (error) {
    if (statesAreDifferent(currentState, progressedState)) {
      await writeStateFile(props.statePath, progressedState);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Aborted after ${appliedOperations} of ${plan.operations.length} operations. state.json updated for successful operations. Run 'npm run cli -- scan' to verify, then re-run apply. Original error: ${message}`,
    );
  }
  if (statesAreDifferent(currentState, progressedState)) {
    await writeStateFile(props.statePath, progressedState);
  }

  props.logger.log(
    `Apply complete. Applied ${appliedOperations} operation(s).`,
  );
  return {
    plan: plan,
    appliedOperations: appliedOperations,
    statePath: props.statePath,
    status: "applied",
  };
}

async function applyOperation(props: {
  state: StateFile;
  organizationsClient: OrganizationsClient;
  logger: Logger;
  context: Awaited<ReturnType<typeof readAwsContextFromFile>>;
  runtime: ApplyCommandInput["runtime"];
  operation: Operation;
}): Promise<StateFile> {
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
    const nextAccounts = props.state.organization.accounts.map((currentAccount) => {
      if (currentAccount.id !== operation.accountId) {
        return currentAccount;
      }
      return {
        ...currentAccount,
        parentId: operation.toOuId,
      };
    });
    return {
      ...props.state,
      organization: {
        ...props.state.organization,
        accounts: nextAccounts,
      },
    };
  }
  if (operation.kind === "createOu") {
    props.logger.log(
      `Creating OU "${operation.ouName}" under ${operation.parentOuName}...`,
    );
    const response = await props.organizationsClient.send(
      new CreateOrganizationalUnitCommand({
        ParentId: operation.parentOuId,
        Name: operation.ouName,
      }),
    );
    const createdOu = response.OrganizationalUnit;
    if (
      createdOu?.Id == null ||
      createdOu.Arn == null ||
      createdOu.Name == null
    ) {
      throw new Error(
        `CreateOrganizationalUnit for "${operation.ouName}" returned incomplete OU data.`,
      );
    }
    props.logger.log(`Done: "${createdOu.Name}"`);
    return {
      ...props.state,
      organization: {
        ...props.state.organization,
        organizationalUnits: [
          ...props.state.organization.organizationalUnits,
          {
            id: createdOu.Id,
            parentId: operation.parentOuId,
            arn: createdOu.Arn,
            name: createdOu.Name,
          },
        ],
      },
    };
  }
  if (operation.kind === "renameOu") {
    throw new Error(
      `Operation kind "${operation.kind}" is not executable yet in apply.`,
    );
  }
  if (operation.kind === "createAccount") {
    const result = await createAccountAndMoveToOu({
      organizationsClient: props.organizationsClient,
      logger: props.logger,
      accountName: operation.accountName,
      accountEmail: operation.accountEmail,
      sourceParentId: props.context.organization.rootId,
      destinationParentId: operation.targetOuId,
      timeoutInMs: props.runtime.createAccount.timeoutInMs,
      pollIntervalInMs: props.runtime.createAccount.pollIntervalInMs,
    });
    const existingIndex = props.state.organization.accounts.findIndex(
      (currentAccount) => currentAccount.id === result.account.id,
    );
    const nextAccount = {
      id: result.account.id,
      arn: result.account.arn,
      name: result.account.name,
      email: result.account.email,
      status: result.account.status,
      parentId: operation.targetOuId,
    };
    const nextAccounts = [...props.state.organization.accounts];
    if (existingIndex >= 0) {
      nextAccounts[existingIndex] = nextAccount;
    } else {
      nextAccounts.push(nextAccount);
    }
    return {
      ...props.state,
      organization: {
        ...props.state.organization,
        accounts: nextAccounts,
      },
    };
  }
  assertUnreachable(operation, "Unsupported operation kind in apply.");
}

function statesAreDifferent(current: StateFile, next: StateFile): boolean {
  return JSON.stringify(current) !== JSON.stringify(next);
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
    if (operation.kind === "createOu") {
      lines.push(
        `  create OU "${operation.ouName}" under ${operation.parentOuName}`,
      );
      continue;
    }
    if (operation.kind === "renameOu") {
      lines.push(
        `  rename OU "${operation.fromOuName}" -> "${operation.toOuName}"`,
      );
      continue;
    }
    if (operation.kind === "createAccount") {
      lines.push(
        `  create account "${operation.accountName}" (${operation.accountEmail}) in ${operation.targetOuName}`,
      );
      continue;
    }
    assertUnreachable(
      operation,
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
