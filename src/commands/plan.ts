import {
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
} from "../awsConfig.js";
import { diffStates } from "../diff.js";
import { readStateFile } from "../state.js";
import type { Plan } from "../operations.js";

type PlanCommandInput = {
  configPath?: string;
  typesPath?: string;
  statePath?: string;
  contextPath?: string;
  output: "human" | "json";
};

type PlanCommandResult = {
  plan: Plan;
};

export async function runPlanCommand(
  props: PlanCommandInput,
): Promise<PlanCommandResult> {
  const configPath = props.configPath ?? "aws.config.ts";
  const typesPath = props.typesPath ?? "aws.config.types.ts";
  const statePath = props.statePath ?? "state.json";
  const contextPath = props.contextPath ?? "aws.context.json";
  const [config, currentState, context] = await Promise.all([
    loadAwsConfigModelFromTsFile({
      configPath: configPath,
      typesPath: typesPath,
    }),
    readStateFile(statePath),
    readAwsContextFromFile(contextPath),
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
    console.log(JSON.stringify(plan, null, 2));
    return {
      plan: plan,
    };
  }

  console.log(
    `Plan: ${plan.operations.length} operation(s), ${plan.unsupported.length} unsupported diff(s)`,
  );
  for (const operation of plan.operations) {
    if (operation.kind === "moveAccount") {
      console.log(
        `  move account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`,
      );
    }
  }
  if (plan.unsupported.length > 0) {
    console.log("Unsupported diffs:");
    for (const diff of plan.unsupported) {
      console.log(`  - ${diff.description} [${diff.category}]`);
    }
  }

  return {
    plan: plan,
  };
}
