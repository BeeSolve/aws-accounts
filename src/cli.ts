import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { AccountClient } from "@aws-sdk/client-account";
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
import { runGraveyardCommand } from "./commands/graveyard.js";
import { runInitCommand } from "./commands/init.js";
import { runPlanCommand } from "./commands/plan.js";
import { runRegenerateCommand } from "./commands/regenerate.js";
import { runScanCommand } from "./commands/scan.js";
import {
  runRemoteBootstrap,
  runRemoteScan,
  runRemoteInit,
  runRemotePlan,
  runRemoteApply,
  runRemoteUpgrade,
} from "./commands/remote.js";
import {
  classifyCliError,
  exitCodeForCliErrorKind,
  toUsageError,
} from "./error.js";

const commands = [
  "scan",
  "bootstrap",
  "init",
  "regenerate",
  "graveyard",
  "plan",
  "apply",
  "remote",
] as const;
type CommandName = (typeof commands)[number];
function isCommandName(value: any): value is CommandName {
  return commands.includes(value);
}

const remoteSubcommands = [
  "bootstrap",
  "scan",
  "init",
  "plan",
  "apply",
  "upgrade",
] as const;
type RemoteSubcommand = (typeof remoteSubcommands)[number];
function isRemoteSubcommand(value: any): value is RemoteSubcommand {
  return remoteSubcommands.includes(value);
}

const configPath = "aws.config.ts";
const typesPath = "aws.config.types.ts";
const statePath = "state.json";
const contextPath = "aws.context.json";
const createAccountTimeoutInMs = 15 * 60 * 1000;
const createAccountPollIntervalInMs = 5 * 1000;
const accountAssignmentTimeoutInMs = 15 * 60 * 1000;
const accountAssignmentPollIntervalInMs = 5 * 1000;
const permissionSetProvisioningTimeoutInMs = 15 * 60 * 1000;
const permissionSetProvisioningPollIntervalInMs = 5 * 1000;

async function main(): Promise<void> {
  const logger = consoleLogger;
  const args = parseArgs({
    options: {
      profile: { type: "string" },
      region: { type: "string" },
      "instance-arn": { type: "string" },
      yes: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "ignore-unsupported": { type: "boolean", default: false },
      "allow-destructive": { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
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
  const accountClient = new AccountClient(clientConfig);
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

  if (command === "graveyard") {
    logger.log(
      `Replay command: ${buildReplayCommand({
        command,
      })}`,
    );
    await runGraveyardCommand({
      logger,
      statePath,
      contextPath,
    });
    return;
  }

  if (command === "apply") {
    logger.log(
      `Replay command: ${buildReplayCommand({
        command,
        yes: args.values.yes,
        allowDestructive: args.values["allow-destructive"],
        ignoreUnsupported: args.values["ignore-unsupported"],
      })}`,
    );
    const planConfirmation = buildApplyPlanConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const result = await runApplyCommand({
      organizationsClient,
      accountClient,
      ssoAdminClient,
      identityStoreClient,
      logger,
      configPath,
      typesPath,
      statePath,
      contextPath,
      runtime: {
        createAccount: {
          timeoutInMs: createAccountTimeoutInMs,
          pollIntervalInMs: createAccountPollIntervalInMs,
        },
        accountAssignment: {
          timeoutInMs: accountAssignmentTimeoutInMs,
          pollIntervalInMs: accountAssignmentPollIntervalInMs,
        },
        permissionSetProvisioning: {
          timeoutInMs: permissionSetProvisioningTimeoutInMs,
          pollIntervalInMs: permissionSetProvisioningPollIntervalInMs,
        },
      },
      allowDestructive: args.values["allow-destructive"] ?? false,
      ignoreUnsupported: args.values["ignore-unsupported"] ?? false,
      planConfirmation,
    });
    logger.log("");
    logger.log(`Apply status: ${result.status}`);
    logger.log(`State: ${result.statePath}`);
    return;
  }

  if (command === "remote") {
    const remoteSubcommand = args.positionals[1];
    if (remoteSubcommand == null || !isRemoteSubcommand(remoteSubcommand)) {
      printRemoteHelp(logger);
      if (remoteSubcommand != null) {
        throw toUsageError(`Unknown remote subcommand: "${remoteSubcommand}".`);
      }
      return;
    }

    const remoteInput = {
      subcommand: remoteSubcommand,
      profile,
      region,
      flags: {
        yes: args.values.yes ?? false,
        refresh: args.values.refresh ?? false,
        allowDestructive: args.values["allow-destructive"] ?? false,
        ignoreUnsupported: args.values["ignore-unsupported"] ?? false,
      },
      logger,
    };

    // todo: this shouldn't be switch, you should prefer assert unreachable pattern
    switch (remoteSubcommand) {
      case "bootstrap":
        await runRemoteBootstrap(remoteInput);
        return;
      case "scan":
        await runRemoteScan(remoteInput);
        return;
      case "init": {
        const overwriteConfirmation = buildOverwriteConfirmation({
          yes: args.values.yes ?? false,
          isTty: process.stdin.isTTY,
        });
        await runRemoteInit({ ...remoteInput, overwriteConfirmation });
        return;
      }
      case "plan":
        await runRemotePlan(remoteInput);
        return;
      case "apply":
        await runRemoteApply(remoteInput);
        return;
      case "upgrade":
        await runRemoteUpgrade(remoteInput);
        return;
    }
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
  logger.log("  npm run cli -- graveyard");
  logger.log("  npm run cli -- plan [--json]");
  logger.log(
    "  npm run cli -- apply [--yes] [--ignore-unsupported] [--allow-destructive]",
  );
  logger.log(
    "  npm run cli -- remote <subcommand> [--profile <name>] [--region <region>]",
  );
  logger.log("");
  logger.log("Environment fallback:");
  logger.log("  AWS_PROFILE, AWS_REGION, AWS_DEFAULT_REGION");
}

function printRemoteHelp(logger: Logger): void {
  logger.log("@beesolve/aws-accounts remote");
  logger.log("");
  logger.log("Usage:");
  logger.log(
    "  npm run cli -- remote bootstrap [--profile <name>] [--region <region>] [--yes]",
  );
  logger.log(
    "  npm run cli -- remote scan [--profile <name>] [--region <region>]",
  );
  logger.log(
    "  npm run cli -- remote init [--profile <name>] [--region <region>] [--yes]",
  );
  logger.log(
    "  npm run cli -- remote plan [--profile <name>] [--region <region>] [--refresh]",
  );
  logger.log(
    "  npm run cli -- remote apply [--profile <name>] [--region <region>] [--yes] [--allow-destructive] [--ignore-unsupported]",
  );
  logger.log(
    "  npm run cli -- remote upgrade [--profile <name>] [--region <region>]",
  );
  logger.log("");
  logger.log("Subcommands:");
  logger.log("  bootstrap   Deploy Lambda, S3 bucket, and IAM role");
  logger.log("  scan        Trigger remote scan of AWS environment");
  logger.log("  init        Remote scan + regenerate aws.config.ts from state");
  logger.log("  plan        Compute plan using remote state");
  logger.log("  apply       Send operations to Lambda for execution");
  logger.log("  upgrade     Update deployed Lambda function code");
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
  allowDestructive: boolean;
  ignoreUnsupported?: boolean;
};

function buildReplayCommand(
  props: Omit<BuildReplayCommandProps, "allowDestructive"> & {
    allowDestructive?: boolean;
  },
): string {
  const allowDestructive = props.allowDestructive ?? false;
  const parts = ["npm", "run", "cli", "--", props.command];
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
  if (allowDestructive) {
    parts.push("--allow-destructive");
  }
  if (props.ignoreUnsupported) {
    parts.push("--ignore-unsupported");
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

function buildApplyPlanConfirmation(
  props: BuildBootstrapPlanConfirmationProps,
): (props: {
  planLines: string[];
  hasDestructiveChanges: boolean;
}) => Promise<boolean> {
  return async (planProps: {
    planLines: string[];
    hasDestructiveChanges: boolean;
  }): Promise<boolean> => {
    if (planProps.planLines.length === 0) {
      return true;
    }
    if (props.yes) {
      return true;
    }
    if (props.isTty !== true) {
      throw new Error(
        "Refusing to apply changes in non-interactive mode without --yes.",
      );
    }
    const readlineInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await readlineInterface.question(
        planProps.hasDestructiveChanges
          ? "Proceed with applying these changes? This includes destructive operations. [y/N] "
          : "Proceed with applying these changes? [y/N] ",
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
