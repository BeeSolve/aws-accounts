import {
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
} from "../awsConfig.js";
import { diffStates } from "../diff.js";
import { assertUnreachable } from "../helpers.js";
import { readStateFile } from "../state.js";
import type { Plan } from "../operations.js";
import type { Logger } from "../logger.js";
import { applyReservedOuDeletionGuard } from "../reservedOuDeletion.js";

type PlanCommandInput = {
  logger: Logger;
  configPath: string;
  typesPath: string;
  statePath: string;
  contextPath: string;
  output: "human" | "json";
};

type PlanCommandResult = {
  plan: Plan;
};

export async function runPlanCommand(
  props: PlanCommandInput,
): Promise<PlanCommandResult> {
  const [config, currentState, context] = await Promise.all([
    loadAwsConfigModelFromTsFile({
      configPath: props.configPath,
      typesPath: props.typesPath,
    }),
    readStateFile(props.statePath),
    readAwsContextFromFile(props.contextPath),
  ]);

  const nextState = mapAwsConfigToState({
    config,
    currentState,
    context,
  });
  const plan = applyReservedOuDeletionGuard({
    plan: diffStates({
      current: currentState,
      next: nextState,
    }),
    context,
  });

  if (props.output === "json") {
    props.logger.log(JSON.stringify(plan, null, 2));
    return {
      plan,
    };
  }

  props.logger.log(
    `Plan: ${plan.operations.length} operation(s), ${plan.unsupported.length} unsupported diff(s)`,
  );
  const destructiveOperations = plan.operations.filter((operation) =>
    isDestructiveOperation(operation),
  );
  if (destructiveOperations.length > 0) {
    props.logger.log(
      `Destructive operations detected: ${destructiveOperations.length}. Apply requires --allow-destructive.`,
    );
  }
  for (const operation of plan.operations) {
    props.logger.log(formatHumanOperationLine(operation));
  }
  if (plan.unsupported.length > 0) {
    props.logger.log("Unsupported diffs:");
    for (const diff of plan.unsupported) {
      props.logger.log(`  - ${diff.description} [${diff.category}]`);
    }
  }

  return {
    plan,
  };
}

function formatHumanOperationLine(operation: Plan["operations"][number]): string {
  if (operation.kind === "moveAccount") {
    return `  move account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`;
  }
  if (operation.kind === "createOu") {
    return `  create OU "${operation.ouName}" under ${operation.parentOuName}`;
  }
  if (operation.kind === "renameOu") {
    return `  rename OU "${operation.fromOuName}" -> "${operation.toOuName}"`;
  }
  if (operation.kind === "deleteOu") {
    return `  [destructive] delete OU "${operation.ouName}" from ${operation.parentOuName}`;
  }
  if (operation.kind === "createAccount") {
    return `  create account "${operation.accountName}" (${operation.accountEmail}) in ${operation.targetOuName}`;
  }
  if (operation.kind === "createIdcUser") {
    return `  create IdC user "${operation.userName}"`;
  }
  if (operation.kind === "createIdcGroup") {
    return `  create IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "createIdcPermissionSet") {
    return `  create IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "grantIdcAccountAssignment") {
    return `  grant IdC assignment "${operation.permissionSetName}" to ${formatPrincipalLabel({
      principalType: operation.principalType,
      principalName: operation.principalName,
    })} on "${operation.accountName}"`;
  }
  if (operation.kind === "revokeIdcAccountAssignment") {
    return `  revoke IdC assignment "${operation.permissionSetName}" from ${formatPrincipalLabel({
      principalType: operation.principalType,
      principalName: operation.principalName,
    })} on "${operation.accountName}"`;
  }
  assertUnreachable(
    operation,
    "Unsupported operation kind in human-readable plan output.",
  );
}

function isDestructiveOperation(
  operation: Plan["operations"][number],
): operation is Extract<Plan["operations"][number], { kind: "deleteOu" }> {
  return operation.kind === "deleteOu";
}

function formatPrincipalLabel(props: {
  principalType: "GROUP" | "USER";
  principalName: string;
}): string {
  if (props.principalType === "GROUP") {
    return `group "${props.principalName}"`;
  }
  return `user "${props.principalName}"`;
}
