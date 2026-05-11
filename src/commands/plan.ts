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
    config: config,
    currentState: currentState,
    context: context,
  });
  const plan = diffStates({
    current: currentState,
    next: nextState,
  });

  if (props.output === "json") {
    props.logger.log(JSON.stringify(plan, null, 2));
    return {
      plan: plan,
    };
  }

  props.logger.log(
    `Plan: ${plan.operations.length} operation(s), ${plan.unsupported.length} unsupported diff(s)`,
  );
  for (const operation of plan.operations) {
    if (operation.kind === "moveAccount") {
      props.logger.log(
        `  move account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`,
      );
      continue;
    }
    if (operation.kind === "createOu") {
      props.logger.log(
        `  create OU "${operation.ouName}" under ${operation.parentOuName}`,
      );
      continue;
    }
    if (operation.kind === "renameOu") {
      props.logger.log(
        `  rename OU "${operation.fromOuName}" -> "${operation.toOuName}"`,
      );
      continue;
    }
    if (operation.kind === "createAccount") {
      props.logger.log(
        `  create account "${operation.accountName}" (${operation.accountEmail}) in ${operation.targetOuName}`,
      );
      continue;
    }
    assertUnreachable(
      operation,
      "Unsupported operation kind in human-readable plan output.",
    );
  }
  if (plan.unsupported.length > 0) {
    props.logger.log("Unsupported diffs:");
    for (const diff of plan.unsupported) {
      props.logger.log(`  - ${diff.description} [${diff.category}]`);
    }
  }

  return {
    plan: plan,
  };
}
