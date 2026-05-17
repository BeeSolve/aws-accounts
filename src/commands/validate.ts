import { loadAwsConfigModelFromTsFile, type AwsConfigModel } from "../awsConfig.js";
import type { Logger } from "../logger.js";

type ValidateCommandInput = {
  logger: Logger;
  configPath?: string;
  typesPath?: string;
};

const INLINE_POLICY_MAX_CHARS = 10_240;
const ORG_POLICY_CONTENT_MAX_BYTES = 5_120;

export async function runValidateCommand(input: ValidateCommandInput): Promise<boolean> {
  const configPath = input.configPath ?? "aws.config.ts";
  const typesPath = input.typesPath ?? "aws.config.types.ts";

  let config: AwsConfigModel;
  try {
    config = await loadAwsConfigModelFromTsFile({ configPath, typesPath });
  } catch (error) {
    input.logger.log(`Config error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const errors: string[] = [];

  checkCircularOuReferences(config, errors);
  checkAssignmentPrincipals(config, errors);
  checkInlinePolicySizes(config, errors);
  checkOrgPolicySizes(config, errors);
  checkOrgPolicyTargets(config, errors);

  if (errors.length > 0) {
    for (const error of errors) {
      input.logger.log(`Error: ${error}`);
    }
    input.logger.log(`\nValidation failed with ${errors.length} error(s).`);
    return false;
  }

  input.logger.log("Config is valid.");
  return true;
}

function checkCircularOuReferences(config: AwsConfigModel, errors: string[]): void {
  const parentByName = new Map<string, string | null>(
    config.organizationalUnits.map((ou) => [ou.name, ou.parentName]),
  );

  const confirmed = new Set<string>();

  for (const ou of config.organizationalUnits) {
    if (ou.name === "root" || confirmed.has(ou.name)) {
      continue;
    }

    const visited = new Set<string>();
    let current: string | null = ou.name;
    while (current != null) {
      if (visited.has(current)) {
        errors.push(`Circular OU reference detected: "${current}" is its own ancestor.`);
        confirmed.add(current);
        break;
      }
      visited.add(current);
      current = parentByName.get(current) ?? null;
    }
  }
}

function checkAssignmentPrincipals(config: AwsConfigModel, errors: string[]): void {
  for (const assignment of config.assignments) {
    const hasGroup = assignment.group != null;
    const hasUser = assignment.user != null;
    if (hasGroup && hasUser) {
      errors.push(
        `Assignment for permission set "${assignment.permissionSet}" specifies both "group" and "user" — only one is allowed.`,
      );
    } else if (!hasGroup && !hasUser) {
      errors.push(
        `Assignment for permission set "${assignment.permissionSet}" has no principal — "group" or "user" is required.`,
      );
    }
  }
}

function checkOrgPolicySizes(config: AwsConfigModel, errors: string[]): void {
  for (const policy of config.policies?.serviceControlPolicies ?? []) {
    const contentBytes = Buffer.byteLength(JSON.stringify(policy.content), "utf8");
    if (contentBytes > ORG_POLICY_CONTENT_MAX_BYTES) {
      errors.push(
        `Service control policy "${policy.name}" content is ${contentBytes} bytes (limit: ${ORG_POLICY_CONTENT_MAX_BYTES}).`,
      );
    }
  }
  for (const policy of config.policies?.resourceControlPolicies ?? []) {
    const contentBytes = Buffer.byteLength(JSON.stringify(policy.content), "utf8");
    if (contentBytes > ORG_POLICY_CONTENT_MAX_BYTES) {
      errors.push(
        `Resource control policy "${policy.name}" content is ${contentBytes} bytes (limit: ${ORG_POLICY_CONTENT_MAX_BYTES}).`,
      );
    }
  }
}

function checkOrgPolicyTargets(config: AwsConfigModel, errors: string[]): void {
  const ouNames = new Set(config.organizationalUnits.map((ou) => ou.name));
  const accountNames = new Set(
    config.organizationalUnits.flatMap((ou) => ou.accounts.map((a) => a.name)),
  );

  for (const policy of config.policies?.serviceControlPolicies ?? []) {
    for (const target of policy.targets) {
      if (target !== "root" && !ouNames.has(target) && !accountNames.has(target)) {
        errors.push(
          `Service control policy "${policy.name}" references unknown target "${target}".`,
        );
      }
    }
  }
  for (const policy of config.policies?.resourceControlPolicies ?? []) {
    for (const target of policy.targets) {
      if (target !== "root" && !ouNames.has(target) && !accountNames.has(target)) {
        errors.push(
          `Resource control policy "${policy.name}" references unknown target "${target}".`,
        );
      }
    }
  }
}

function checkInlinePolicySizes(config: AwsConfigModel, errors: string[]): void {
  for (const ps of config.permissionSets) {
    if (ps.inlinePolicy == null) {
      continue;
    }
    const length = JSON.stringify(ps.inlinePolicy).length;
    if (length > INLINE_POLICY_MAX_CHARS) {
      errors.push(
        `Permission set "${ps.name}" inline policy is ${length} characters (limit: ${INLINE_POLICY_MAX_CHARS}).`,
      );
    }
  }
}
