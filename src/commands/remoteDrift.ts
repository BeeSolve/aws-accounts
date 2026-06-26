import type { AwsConfigModel } from "../awsConfig.js";
import { loadAwsConfigModelFromTsFile, mapStateToAwsConfig, renderTsValue } from "../awsConfig.js";
import type { RemoteCommandInput } from "./remote.js";
import {
  configFilePath,
  typesFilePath,
  fetchCurrentState,
  readDeploymentFromContext,
} from "./remote.js";

export async function runRemoteDrift(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();

  const currentState = await fetchCurrentState({
    input,
    deployment,
  });

  const config = await loadAwsConfigModelFromTsFile({
    configPath: configFilePath,
    typesPath: typesFilePath,
  });

  const liveConfig = mapStateToAwsConfig({ state: currentState });
  const sections = computeConfigDrift({ config, liveConfig });

  if (sections.length === 0) {
    input.logger.log("No drift: aws.config.ts matches the current AWS state.");
    input.logger.log("");
    input.logger.log(
      "Edit aws.config.ts to make changes, then run 'plan' to preview and 'apply' to execute.",
    );
    return;
  }

  const addCount = sections.reduce((sum, s) => sum + s.additions.length, 0);
  const removeCount = sections.reduce((sum, s) => sum + s.removals.length, 0);
  const modifyCount = sections.reduce((sum, s) => sum + s.modifications.length, 0);
  input.logger.log(
    `Drift: ${addCount} addition(s), ${removeCount} removal(s), ${modifyCount} modification(s)`,
  );
  input.logger.log("");

  for (const section of sections) {
    if (
      section.additions.length === 0 &&
      section.removals.length === 0 &&
      section.modifications.length === 0
    ) {
      continue;
    }
    input.logger.log(`── ${section.label} ${"─".repeat(Math.max(0, 60 - section.label.length))}`);

    for (const addition of section.additions) {
      input.logger.log(`Add${addition.context != null ? ` (${addition.context})` : ""}:`);
      input.logger.log("");
      input.logger.log(indentSnippet(addition.snippet, "  "));
      input.logger.log("");
    }

    for (const removal of section.removals) {
      input.logger.log(`Remove${removal.context != null ? ` (${removal.context})` : ""}:`);
      input.logger.log("");
      input.logger.log(indentSnippet(removal.snippet, "  "));
      input.logger.log("");
    }

    for (const modification of section.modifications) {
      input.logger.log(
        `Modify${modification.context != null ? ` (${modification.context})` : ""}:`,
      );
      input.logger.log("");
      input.logger.log(indentSnippet(modification.snippet, "  "));
      input.logger.log("");
    }
  }
  input.logger.log(
    "To accept AWS state as baseline: run 'init --yes' (delete aws.config.ts first).",
  );
  input.logger.log("To reconcile via config: edit aws.config.ts, then run 'plan' and 'apply'.");
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left == null && right == null) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((item, i) => deepEqual(item, right[i]));
  }
  if (
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftObj = left as Record<string, unknown>;
    const rightObj = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObj).filter((k) => leftObj[k] !== undefined);
    const rightKeys = Object.keys(rightObj).filter((k) => rightObj[k] !== undefined);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => deepEqual(leftObj[key], rightObj[key]));
  }
  return false;
}

type DriftEntry = {
  snippet: string;
  context?: string;
};

type DriftSection = {
  label: string;
  additions: DriftEntry[];
  removals: DriftEntry[];
  modifications: DriftEntry[];
};

function computeConfigDrift(props: {
  config: AwsConfigModel;
  liveConfig: AwsConfigModel;
}): DriftSection[] {
  const sections = new Array<DriftSection>();

  sections.push(computeOrganizationalUnitsDrift(props));
  sections.push(computeUsersDrift(props));
  sections.push(computeGroupsDrift(props));
  sections.push(computePermissionSetsDrift(props));
  sections.push(computeAssignmentsDrift(props));
  sections.push(computeDelegatedAdminsDrift(props));
  sections.push(computePoliciesDrift(props));

  return sections.filter(
    (s) => s.additions.length > 0 || s.removals.length > 0 || s.modifications.length > 0,
  );
}

function computeOrganizationalUnitsDrift(props: {
  config: AwsConfigModel;
  liveConfig: AwsConfigModel;
}): DriftSection {
  const additions = new Array<DriftEntry>();
  const removals = new Array<DriftEntry>();
  const modifications = new Array<DriftEntry>();

  const configOuByName = new Map(props.config.organizationalUnits.map((ou) => [ou.name, ou]));
  const liveOuByName = new Map(props.liveConfig.organizationalUnits.map((ou) => [ou.name, ou]));

  for (const [name, liveOu] of liveOuByName) {
    const configOu = configOuByName.get(name);
    if (configOu == null) {
      additions.push({
        snippet: renderEntity(liveOu),
        context: `OU "${name}" exists in AWS but not in config`,
      });
      continue;
    }

    const configAccountByName = new Map(configOu.accounts.map((a) => [a.name, a]));
    const liveAccountByName = new Map(liveOu.accounts.map((a) => [a.name, a]));

    for (const [accountName, liveAccount] of liveAccountByName) {
      if (!configAccountByName.has(accountName)) {
        additions.push({
          snippet: renderEntity(liveAccount),
          context: `account "${accountName}" in OU "${name}"`,
        });
      }
    }

    for (const [accountName] of configAccountByName) {
      if (!liveAccountByName.has(accountName)) {
        removals.push({
          snippet: `{ name: "${accountName}", ... }`,
          context: `account "${accountName}" no longer in OU "${name}" in AWS`,
        });
      }
    }
  }

  for (const [name] of configOuByName) {
    if (!liveOuByName.has(name) && name !== "root") {
      removals.push({
        snippet: `{ name: "${name}", ... }`,
        context: `OU "${name}" no longer exists in AWS`,
      });
    }
  }

  return { label: "organizationalUnits", additions, removals, modifications };
}

function computeUsersDrift(props: {
  config: AwsConfigModel;
  liveConfig: AwsConfigModel;
}): DriftSection {
  const additions = new Array<DriftEntry>();
  const removals = new Array<DriftEntry>();
  const modifications = new Array<DriftEntry>();

  const configByName = new Map(props.config.users.map((u) => [u.userName, u]));
  const liveByName = new Map(props.liveConfig.users.map((u) => [u.userName, u]));

  for (const [name, liveUser] of liveByName) {
    if (!configByName.has(name)) {
      additions.push({ snippet: renderEntity(liveUser), context: `user "${name}"` });
    }
  }

  for (const [name] of configByName) {
    if (!liveByName.has(name)) {
      removals.push({
        snippet: `{ userName: "${name}", ... }`,
        context: `user "${name}" not in AWS`,
      });
    }
  }

  return { label: "users", additions, removals, modifications };
}

function computeGroupsDrift(props: {
  config: AwsConfigModel;
  liveConfig: AwsConfigModel;
}): DriftSection {
  const additions = new Array<DriftEntry>();
  const removals = new Array<DriftEntry>();
  const modifications = new Array<DriftEntry>();

  const configByName = new Map(props.config.groups.map((g) => [g.displayName, g]));
  const liveByName = new Map(props.liveConfig.groups.map((g) => [g.displayName, g]));

  for (const [name, liveGroup] of liveByName) {
    const configGroup = configByName.get(name);
    if (configGroup == null) {
      additions.push({ snippet: renderEntity(liveGroup), context: `group "${name}"` });
      continue;
    }
    const configMembers = [...configGroup.members].sort();
    const liveMembers = [...liveGroup.members].sort();
    if (JSON.stringify(configMembers) !== JSON.stringify(liveMembers)) {
      const added = liveMembers.filter((m) => !configMembers.includes(m));
      const removed = configMembers.filter((m) => !liveMembers.includes(m));
      const parts = new Array<string>();
      if (added.length > 0) {
        parts.push(`add members: ${added.map((m) => `"${m}"`).join(", ")}`);
      }
      if (removed.length > 0) {
        parts.push(`remove members: ${removed.map((m) => `"${m}"`).join(", ")}`);
      }
      modifications.push({
        snippet: `members: ${renderEntity(liveMembers)}`,
        context: `group "${name}": ${parts.join("; ")}`,
      });
    }
  }

  for (const [name] of configByName) {
    if (!liveByName.has(name)) {
      removals.push({
        snippet: `{ displayName: "${name}", ... }`,
        context: `group "${name}" not in AWS`,
      });
    }
  }

  return { label: "groups", additions, removals, modifications };
}

function computePermissionSetsDrift(props: {
  config: AwsConfigModel;
  liveConfig: AwsConfigModel;
}): DriftSection {
  const additions = new Array<DriftEntry>();
  const removals = new Array<DriftEntry>();
  const modifications = new Array<DriftEntry>();

  const configByName = new Map(props.config.permissionSets.map((ps) => [ps.name, ps]));
  const liveByName = new Map(props.liveConfig.permissionSets.map((ps) => [ps.name, ps]));

  for (const [name, livePs] of liveByName) {
    const configPs = configByName.get(name);
    if (configPs == null) {
      additions.push({ snippet: renderEntity(livePs), context: `permission set "${name}"` });
      continue;
    }
    if (!deepEqual(configPs, livePs)) {
      modifications.push({
        snippet: renderEntity(livePs),
        context: `permission set "${name}" differs — replace with`,
      });
    }
  }

  for (const [name] of configByName) {
    if (!liveByName.has(name)) {
      removals.push({
        snippet: `{ name: "${name}", ... }`,
        context: `permission set "${name}" not in AWS`,
      });
    }
  }

  return { label: "permissionSets", additions, removals, modifications };
}

function computeAssignmentsDrift(props: {
  config: AwsConfigModel;
  liveConfig: AwsConfigModel;
}): DriftSection {
  const additions = new Array<DriftEntry>();
  const removals = new Array<DriftEntry>();
  const modifications = new Array<DriftEntry>();

  function assignmentKey(a: AwsConfigModel["assignments"][number]): string {
    return `${a.permissionSet}|${a.group ?? ""}|${a.user ?? ""}`;
  }

  const configByKey = new Map(props.config.assignments.map((a) => [assignmentKey(a), a]));
  const liveByKey = new Map(props.liveConfig.assignments.map((a) => [assignmentKey(a), a]));

  for (const [key, liveAssignment] of liveByKey) {
    const configAssignment = configByKey.get(key);
    if (configAssignment == null) {
      additions.push({ snippet: renderEntity(liveAssignment) });
      continue;
    }
    const configAccounts = [...configAssignment.accounts].sort();
    const liveAccounts = [...liveAssignment.accounts].sort();
    if (JSON.stringify(configAccounts) !== JSON.stringify(liveAccounts)) {
      const added = liveAccounts.filter((a) => !configAccounts.includes(a));
      const removed = configAccounts.filter((a) => !liveAccounts.includes(a));
      const principal = liveAssignment.group ?? liveAssignment.user ?? "?";
      const parts = new Array<string>();
      if (added.length > 0) {
        parts.push(`add: ${added.map((a) => `"${a}"`).join(", ")}`);
      }
      if (removed.length > 0) {
        parts.push(`remove: ${removed.map((a) => `"${a}"`).join(", ")}`);
      }
      modifications.push({
        snippet: renderEntity(liveAssignment),
        context: `${liveAssignment.permissionSet} → ${principal}: ${parts.join("; ")}`,
      });
    }
  }

  for (const [key, configAssignment] of configByKey) {
    if (!liveByKey.has(key)) {
      const principal = configAssignment.group ?? configAssignment.user ?? "?";
      removals.push({
        snippet: renderEntity(configAssignment),
        context: `${configAssignment.permissionSet} → ${principal} not in AWS`,
      });
    }
  }

  return { label: "assignments", additions, removals, modifications };
}

function computeDelegatedAdminsDrift(props: {
  config: AwsConfigModel;
  liveConfig: AwsConfigModel;
}): DriftSection {
  const additions = new Array<DriftEntry>();
  const removals = new Array<DriftEntry>();
  const modifications = new Array<DriftEntry>();

  function daKey(d: AwsConfigModel["delegatedAdministrators"][number]): string {
    return `${d.account}|${d.servicePrincipal}`;
  }

  const configByKey = new Set(props.config.delegatedAdministrators.map(daKey));
  const liveByKey = new Set(props.liveConfig.delegatedAdministrators.map(daKey));

  for (const liveDa of props.liveConfig.delegatedAdministrators) {
    if (!configByKey.has(daKey(liveDa))) {
      additions.push({ snippet: renderEntity(liveDa) });
    }
  }

  for (const configDa of props.config.delegatedAdministrators) {
    if (!liveByKey.has(daKey(configDa))) {
      removals.push({ snippet: renderEntity(configDa) });
    }
  }

  return { label: "delegatedAdministrators", additions, removals, modifications };
}

function computePoliciesDrift(props: {
  config: AwsConfigModel;
  liveConfig: AwsConfigModel;
}): DriftSection {
  const additions = new Array<DriftEntry>();
  const removals = new Array<DriftEntry>();
  const modifications = new Array<DriftEntry>();

  const policyCategories = [
    "serviceControlPolicies",
    "resourceControlPolicies",
    "tagPolicies",
    "aiServicesOptOutPolicies",
    "backupPolicies",
  ] as const;

  for (const category of policyCategories) {
    const configByName = new Map(props.config.policies[category].map((p) => [p.name, p]));
    const liveByName = new Map(props.liveConfig.policies[category].map((p) => [p.name, p]));

    for (const [name, livePolicy] of liveByName) {
      const configPolicy = configByName.get(name);
      if (configPolicy == null) {
        additions.push({
          snippet: renderEntity(livePolicy),
          context: `policies.${category}`,
        });
        continue;
      }
      if (!deepEqual(configPolicy, livePolicy)) {
        modifications.push({
          snippet: renderEntity(livePolicy),
          context: `policies.${category} "${name}" differs — replace with`,
        });
      }
    }

    for (const [name] of configByName) {
      if (!liveByName.has(name)) {
        removals.push({
          snippet: `{ name: "${name}", ... }`,
          context: `policies.${category} "${name}" not in AWS`,
        });
      }
    }
  }

  return { label: "policies", additions, removals, modifications };
}

function renderEntity(value: unknown): string {
  return renderTsValue(value, { indentLevel: 0, withinInlinePolicy: false });
}

function indentSnippet(snippet: string, prefix: string): string {
  return snippet
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
