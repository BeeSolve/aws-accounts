import { createInterface } from "node:readline/promises";
import { readAwsContextFromFile } from "../awsConfig.js";
import type { Logger } from "../logger.js";
import { readStateCache } from "../remoteStateCache.js";
import type { StateFile } from "../state.js";

type ProfileCommandInput = {
  logger: Logger;
  cachePath: string;
  contextPath: string;
  ssoStartUrl: string;
  ssoSession: string;
  isTty: boolean | undefined;
};

type ProfileEntry = {
  accountId: string;
  accountName: string;
  permissionSetName: string;
};

export async function runProfileCommand(input: ProfileCommandInput): Promise<void> {
  const cache = await readStateCache(input.cachePath);
  if (cache == null) {
    throw new Error(
      `No remote state cache found at "${input.cachePath}". Run scan or plan first.`,
    );
  }

  const context = await readAwsContextFromFile(input.contextPath);
  const region =
    context.deployment?.region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";

  const entries = buildProfileEntries(cache.state);
  if (entries.length === 0) {
    input.logger.log("No account assignments found in state cache.");
    return;
  }

  const selected = await selectEntry({ entries, logger: input.logger, isTty: input.isTty });
  if (selected == null) {
    return;
  }

  const profileName = buildProfileName(selected);
  const block = renderProfileBlock({
    profileName,
    ssoSession: input.ssoSession,
    accountId: selected.accountId,
    roleName: selected.permissionSetName,
    ssoStartUrl: input.ssoStartUrl,
    region,
    ssoRegistrationScopes: "sso:account:access",
  });

  input.logger.log("");
  input.logger.log(block);
}

async function selectEntry(props: {
  entries: ProfileEntry[];
  logger: Logger;
  isTty: boolean | undefined;
}): Promise<ProfileEntry | null> {
  if (props.isTty !== true) {
    throw new Error(
      "Profile command requires an interactive terminal. Use --account and --permission-set in non-interactive mode (not yet supported).",
    );
  }

  props.logger.log("Select an account/permission-set combination:");
  props.logger.log("");
  for (const [index, entry] of props.entries.entries()) {
    props.logger.log(
      `  ${index + 1}. ${entry.accountName} / ${entry.permissionSetName} (${entry.accountId})`,
    );
  }
  props.logger.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let choice: number | undefined;
    while (choice == null) {
      const answer = await rl.question(`Enter number (1-${props.entries.length}): `);
      const parsed = parseInt(answer.trim(), 10);
      if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= props.entries.length) {
        choice = parsed;
      } else {
        props.logger.log(`Please enter a number between 1 and ${props.entries.length}.`);
      }
    }
    return props.entries[choice - 1] ?? null;
  } finally {
    rl.close();
  }
}

function buildProfileEntries(state: StateFile): ProfileEntry[] {
  const accountById: Record<string, StateFile["organization"]["accounts"][number]> =
    Object.fromEntries(state.organization.accounts.map((a) => [a.id, a]));
  const permissionSetByArn: Record<
    string,
    StateFile["identityCenter"]["permissionSets"][number]
  > = Object.fromEntries(
    state.identityCenter.permissionSets.map((ps) => [ps.permissionSetArn, ps]),
  );

  const seen = new Set<string>();
  const entries: ProfileEntry[] = [];

  for (const assignment of state.identityCenter.accountAssignments) {
    const key = `${assignment.accountId}|${assignment.permissionSetArn}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const account = accountById[assignment.accountId];
    const permissionSet = permissionSetByArn[assignment.permissionSetArn];
    if (account == null || permissionSet == null) {
      continue;
    }

    entries.push({
      accountId: account.id,
      accountName: account.name,
      permissionSetName: permissionSet.name,
    });
  }

  return entries.sort((a, b) => {
    const accountCmp = a.accountName.localeCompare(b.accountName);
    return accountCmp !== 0 ? accountCmp : a.permissionSetName.localeCompare(b.permissionSetName);
  });
}

function buildProfileName(entry: ProfileEntry): string {
  return `${toKebabCase(entry.accountName)}-${toKebabCase(entry.permissionSetName)}`;
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function renderProfileBlock(props: {
  profileName: string;
  ssoSession: string;
  accountId: string;
  roleName: string;
  ssoStartUrl: string;
  region: string;
  ssoRegistrationScopes: string;
}): string {
  return [
    `[profile ${props.profileName}]`,
    `sso_session = ${props.ssoSession}`,
    `sso_account_id = ${props.accountId}`,
    `sso_role_name = ${props.roleName}`,
    ``,
    `[sso-session ${props.ssoSession}]`,
    `sso_start_url = ${props.ssoStartUrl}`,
    `sso_region = ${props.region}`,
    `sso_registration_scopes = ${props.ssoRegistrationScopes}`,
  ].join("\n");
}
