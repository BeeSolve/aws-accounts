import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import * as v from "valibot";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import {
  buildAwsClientConfig,
  resolveAwsProfile,
  resolveAwsRegion,
} from "./awsClientConfig.js";
import { consoleLogger, type Logger } from "./logger.js";
import { runBootstrapCommand } from "./commands/bootstrap.js";
import { runApplyCommand } from "./commands/apply.js";
import { runCreateAccountCommand } from "./commands/createAccount.js";
import { runInitCommand } from "./commands/init.js";
import { runPlanCommand } from "./commands/plan.js";
import { runRegenerateCommand } from "./commands/regenerate.js";
import { runScanCommand } from "./commands/scan.js";
import {
  classifyCliError,
  exitCodeForCliErrorKind,
  toUsageError,
  toValidationError,
} from "./error.js";

const commands = [
  "scan",
  "bootstrap",
  "init",
  "regenerate",
  "create-account",
  "plan",
  "apply",
] as const;
type CommandName = (typeof commands)[number];
function isCommandName(value: any): value is CommandName {
  return commands.includes(value);
}

const configPath = "aws.config.ts";
const typesPath = "aws.config.types.ts";
const statePath = "state.json";
const contextPath = "aws.context.json";
const createAccountTimeoutInMs = 15 * 60 * 1000;
const createAccountPollIntervalInMs = 5 * 1000;
const nonEmptyString = v.pipe(v.string(), v.trim(), v.nonEmpty());
const emailSchema = v.pipe(nonEmptyString, v.email());

async function main(): Promise<void> {
  const logger = consoleLogger;
  const args = parseArgs({
    options: {
      profile: { type: "string" },
      region: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      "instance-arn": { type: "string" },
      yes: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "ignore-unsupported": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const commandArg = args.positionals[0];
  if (args.values.help || commandArg == null) {
    printHelp(logger);
    return;
  }
  if (!isCommandName(commandArg)) {
    printHelp(logger);
    throw toUsageError(`Unknown command: "${commandArg}".`);
  }
  const command = commandArg;

  const profile = resolveAwsProfile({ profileArg: args.values.profile });
  const region = resolveAwsRegion({ regionArg: args.values.region });
  const clientConfig = buildAwsClientConfig({
    profile,
    region,
  });
  const organizationsClient = new OrganizationsClient(clientConfig);
  const ssoAdminClient = new SSOAdminClient(clientConfig);
  const identityStoreClient = new IdentitystoreClient(clientConfig);

  if (command === "scan") {
    logger.log(
      `Replay command: ${buildReplayCommand({
        command,
        profile,
        region,
        instanceArn: args.values["instance-arn"],
      })}`,
    );
    const result = await runScanCommand({
      organizationsClient,
      ssoAdminClient,
      identityStoreClient,
      logger,
      instanceArn: args.values["instance-arn"],
    });

    logger.log("");
    logger.log("Scan complete.");
    logger.log(
      `Organization OUs: ${result.state.organization.organizationalUnits.length}`,
    );
    logger.log(
      `Organization accounts: ${result.state.organization.accounts.length}`,
    );
    logger.log(
      `Identity Center users: ${result.state.identityCenter.users.length}`,
    );
    logger.log(
      `Identity Center groups: ${result.state.identityCenter.groups.length}`,
    );
    logger.log(
      `Permission sets: ${result.state.identityCenter.permissionSets.length}`,
    );
    logger.log(
      `Account assignments: ${result.state.identityCenter.accountAssignments.length}`,
    );
    logger.log(`Output: ${result.outputPath}`);
    return;
  }

  if (command === "bootstrap") {
    logger.log(
      `Replay command: ${buildReplayCommand({
        command,
        profile,
        region,
        instanceArn: args.values["instance-arn"],
        yes: args.values.yes,
      })}`,
    );
    const planConfirmation = buildBootstrapPlanConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const result = await runBootstrapCommand({
      organizationsClient,
      ssoAdminClient,
      logger,
      profile: profile ?? "",
      region: region ?? "",
      instanceArn: args.values["instance-arn"],
      planConfirmation,
    });

    logger.log("");
    logger.log("Bootstrap complete.");
    logger.log(
      `Pending OU (${result.pendingOuId}): ${result.pendingCreated ? "created" : "reused"}`,
    );
    logger.log(
      `Graveyard OU (${result.graveyardOuId}): ${result.graveyardCreated ? "created" : "reused"}`,
    );
    logger.log(
      `Identity Center metadata: ${result.identityCenterCaptured ? "captured" : "missing"}`,
    );
    logger.log(`Output: ${result.outputPath}`);
    return;
  }

  if (command === "init") {
    logger.log(
      `Replay command: ${buildReplayCommand({
        command,
        profile,
        region,
        instanceArn: args.values["instance-arn"],
        yes: args.values.yes,
      })}`,
    );
    const planConfirmation = buildBootstrapPlanConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const overwriteConfirmation = buildOverwriteConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const result = await runInitCommand({
      organizationsClient,
      ssoAdminClient,
      identityStoreClient,
      logger,
      profile: profile ?? "",
      region: region ?? "",
      instanceArn: args.values["instance-arn"],
      planConfirmation,
      overwriteConfirmation,
    });

    logger.log("");
    logger.log("Init complete.");
    logger.log(`Context: ${result.contextPath}`);
    logger.log(`State: ${result.statePath}`);
    for (const file of result.files) {
      logger.log(`${file.path}: ${file.status}`);
    }
    return;
  }

  if (command === "regenerate") {
    logger.log(
      `Replay command: ${buildReplayCommand({
        command,
        yes: args.values.yes,
      })}`,
    );
    const overwriteConfirmation = buildOverwriteConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const result = await runRegenerateCommand({
      logger,
      overwriteConfirmation,
    });

    logger.log("");
    logger.log("Regenerate complete.");
    for (const file of result.files) {
      logger.log(`${file.path}: ${file.status}`);
    }
    return;
  }

  if (command === "plan") {
    logger.log(
      `Replay command: ${buildReplayCommand({
        command,
        json: args.values.json,
      })}`,
    );
    await runPlanCommand({
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      output: args.values.json ? "json" : "human",
    });
    return;
  }

  if (command === "apply") {
    logger.log(
      `Replay command: ${buildReplayCommand({
        command,
        yes: args.values.yes,
        ignoreUnsupported: args.values["ignore-unsupported"],
      })}`,
    );
    const planConfirmation = buildBootstrapPlanConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const result = await runApplyCommand({
      organizationsClient,
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      ignoreUnsupported: args.values["ignore-unsupported"] ?? false,
      planConfirmation,
    });
    logger.log("");
    logger.log(`Apply status: ${result.status}`);
    logger.log(`State: ${result.statePath}`);
    return;
  }

  if (command === "create-account") {
    const createAccountReadline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let accountEmail: string;
    let accountName: string;
    try {
      const resolved = await resolveCreateAccountInputs({
        email: args.values.email,
        name: args.values.name,
        isTty: process.stdin.isTTY,
        ask: (question) => createAccountReadline.question(question),
      });
      accountEmail = resolved.accountEmail;
      accountName = resolved.accountName;
    } finally {
      createAccountReadline.close();
    }
    logger.log(
      `Replay command: ${buildCreateAccountReplayCommand({
        email: accountEmail,
        name: accountName,
        profile,
        region,
      })}`,
    );
    const result = await runCreateAccountCommand({
      organizationsClient,
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      accountName,
      accountEmail,
      timeoutInMs: createAccountTimeoutInMs,
      pollIntervalInMs: createAccountPollIntervalInMs,
    });
    logger.log("");
    logger.log(`Create-account status: ${result.status}`);
    if (result.accountId != null) {
      logger.log(`Account ID: ${result.accountId}`);
    }
    logger.log(`State updated: ${result.stateUpdated ? "yes" : "no"}`);
    logger.log(`Config updated: ${result.configUpdated ? "yes" : "no"}`);
    logger.log(`Types updated: ${result.typesUpdated ? "yes" : "no"}`);
    return;
  }

  printHelp(logger);
  process.exitCode = 1;
}

function printHelp(logger: Logger): void {
  logger.log("@beesolve/aws-accounts");
  logger.log("");
  logger.log("Usage:");
  logger.log(
    "  npm run cli -- scan [--profile <name>] [--region <region>] [--instance-arn <arn>]",
  );
  logger.log(
    "  npm run cli -- bootstrap [--profile <name>] [--region <region>] [--instance-arn <arn>] [--yes]",
  );
  logger.log(
    "  npm run cli -- init [--profile <name>] [--region <region>] [--instance-arn <arn>] [--yes]",
  );
  logger.log("  npm run cli -- regenerate [--yes]");
  logger.log(
    "  npm run cli -- create-account [--email <email>] [--name <account-name>] [--profile <name>] [--region <region>]",
  );
  logger.log("  npm run cli -- plan [--json]");
  logger.log("  npm run cli -- apply [--yes] [--ignore-unsupported]");
  logger.log("");
  logger.log("Environment fallback:");
  logger.log("  AWS_PROFILE, AWS_REGION, AWS_DEFAULT_REGION");
}

type AskFn = (question: string) => Promise<string>;

type ResolveCreateAccountInputsProps = {
  email: string | undefined;
  name: string | undefined;
  isTty: boolean | undefined;
  ask: AskFn;
};

type ResolveCreateAccountInputsResult = {
  accountEmail: string;
  accountName: string;
};

async function resolveCreateAccountInputs(
  props: ResolveCreateAccountInputsProps,
): Promise<ResolveCreateAccountInputsResult> {
  const accountEmail = await resolveCreateAccountEmail({
    value: props.email,
    isTty: props.isTty,
    ask: props.ask,
  });
  const accountName = await resolveCreateAccountName({
    value: props.name,
    isTty: props.isTty,
    ask: props.ask,
  });
  return { accountEmail, accountName };
}

async function resolveCreateAccountEmail(props: {
  value: string | undefined;
  isTty: boolean | undefined;
  ask: AskFn;
}): Promise<string> {
  const candidate = props.value?.trim();
  if (candidate != null && candidate.length > 0) {
    if (isValidEmailWithSchema(candidate)) {
      return candidate;
    }
    throw toValidationError(`Invalid --email value: "${candidate}".`);
  }
  if (props.isTty !== true) {
    throw toUsageError(
      "Missing required --email for create-account in non-interactive mode.",
    );
  }
  while (true) {
    const answer = (await props.ask("Account email: ")).trim();
    if (answer.length === 0) {
      continue;
    }
    if (isValidEmailWithSchema(answer)) {
      return answer;
    }
  }
}

async function resolveCreateAccountName(props: {
  value: string | undefined;
  isTty: boolean | undefined;
  ask: AskFn;
}): Promise<string> {
  const candidate = props.value?.trim();
  if (candidate != null && candidate.length > 0) {
    return candidate;
  }
  if (props.isTty !== true) {
    throw toUsageError(
      "Missing required --name for create-account in non-interactive mode.",
    );
  }
  while (true) {
    const answer = (await props.ask("Account name: ")).trim();
    if (answer.length > 0) {
      return answer;
    }
  }
}

function isValidEmailWithSchema(value: string): boolean {
  return v.safeParse(emailSchema, value).success;
}

function quoteCliValue(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

type BuildReplayCommandProps = {
  command: CommandName;
  profile?: string;
  region?: string;
  instanceArn?: string;
  yes?: boolean;
  json?: boolean;
  ignoreUnsupported?: boolean;
  email?: string;
  name?: string;
};

function buildReplayCommand(props: BuildReplayCommandProps): string {
  const parts = ["npm", "run", "cli", "--", props.command];
  if (props.email != null) {
    parts.push("--email", quoteCliValue(props.email));
  }
  if (props.name != null) {
    parts.push("--name", quoteCliValue(props.name));
  }
  if (props.profile != null) {
    parts.push("--profile", quoteCliValue(props.profile));
  }
  if (props.region != null) {
    parts.push("--region", quoteCliValue(props.region));
  }
  if (props.instanceArn != null) {
    parts.push("--instance-arn", quoteCliValue(props.instanceArn));
  }
  if (props.yes) {
    parts.push("--yes");
  }
  if (props.json) {
    parts.push("--json");
  }
  if (props.ignoreUnsupported) {
    parts.push("--ignore-unsupported");
  }
  return parts.join(" ");
}

type BuildCreateAccountReplayCommandProps = {
  email: string;
  name: string;
  profile?: string;
  region?: string;
};

function buildCreateAccountReplayCommand(
  props: BuildCreateAccountReplayCommandProps,
): string {
  const parts = [
    "npm",
    "run",
    "cli",
    "--",
    "create-account",
    "--email",
    quoteCliValue(props.email),
    "--name",
    quoteCliValue(props.name),
  ];
  if (props.profile != null) {
    parts.push("--profile", quoteCliValue(props.profile));
  }
  if (props.region != null) {
    parts.push("--region", quoteCliValue(props.region));
  }
  return parts.join(" ");
}

type BuildBootstrapPlanConfirmationProps = {
  yes: boolean;
  isTty: boolean | undefined;
};

function buildBootstrapPlanConfirmation(
  props: BuildBootstrapPlanConfirmationProps,
): (props: { planLines: string[] }) => Promise<boolean> {
  return async (planProps: { planLines: string[] }): Promise<boolean> => {
    if (planProps.planLines.length === 0) {
      return true;
    }
    if (props.yes) {
      return true;
    }
    if (props.isTty !== true) {
      throw new Error(
        "Refusing to create organizational units in non-interactive mode without --yes.",
      );
    }
    const readlineInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await readlineInterface.question(
        "Proceed with creating organizational units? [y/N] ",
      );
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } finally {
      readlineInterface.close();
    }
  };
}

type BuildOverwriteConfirmationProps = {
  yes: boolean;
  isTty: boolean | undefined;
};

function buildOverwriteConfirmation(
  props: BuildOverwriteConfirmationProps,
): (props: { fileSummaries: string[] }) => Promise<boolean> {
  return async (overwriteProps: {
    fileSummaries: string[];
  }): Promise<boolean> => {
    if (overwriteProps.fileSummaries.length === 0) {
      return true;
    }
    if (props.yes) {
      return true;
    }
    if (props.isTty !== true) {
      throw new Error(
        "Refusing to overwrite config files in non-interactive mode without --yes.",
      );
    }
    const readlineInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await readlineInterface.question(
        "Proceed with writing config files? [y/N] ",
      );
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } finally {
      readlineInterface.close();
    }
  };
}

main().catch((error: unknown) => {
  const classified = classifyCliError(error);
  consoleLogger.error(`CLI ${classified.kind} error: ${classified.message}`);
  process.exitCode = exitCodeForCliErrorKind(classified.kind);
});
