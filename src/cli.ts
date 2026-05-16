import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { STSClient } from "@aws-sdk/client-sts";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import {
  buildAwsClientConfig,
  resolveAwsProfile,
  resolveAwsRegion,
} from "./awsClientConfig.js";
import { consoleLogger, type Logger } from "./logger.js";
import { runGraveyardCommand } from "./commands/graveyard.js";
import { runProfileCommand } from "./commands/profile.js";
import { runRegenerateCommand } from "./commands/regenerate.js";
import { runValidateCommand } from "./commands/validate.js";
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
  "bootstrap",
  "scan",
  "init",
  "regenerate",
  "validate",
  "graveyard",
  "profile",
  "plan",
  "apply",
  "upgrade",
] as const;
type CommandName = (typeof commands)[number];
function isCommandName(value: any): value is CommandName {
  return commands.includes(value);
}

const contextPath = "aws.context.json";

async function main(): Promise<void> {
  const logger = consoleLogger;
  const args = parseArgs({
    options: {
      profile: { type: "string" },
      region: { type: "string" },
      yes: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "ignore-unsupported": { type: "boolean", default: false },
      "allow-destructive": { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      "sso-start-url": { type: "string" },
      "sso-session": { type: "string", default: "sso" },
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

  if (command === "regenerate") {
    const overwriteConfirmation = buildOverwriteConfirmation({
      yes: args.values.yes ?? false,
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

  if (command === "validate") {
    const valid = await runValidateCommand({ logger });
    if (!valid) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "graveyard") {
    await runGraveyardCommand({
      logger,
      cachePath: ".remote-state-cache.json",
      contextPath,
    });
    return;
  }

  if (command === "profile") {
    const ssoStartUrl = args.values["sso-start-url"] ?? process.env.AWS_SSO_START_URL;
    if (ssoStartUrl == null) {
      printHelp(logger);
      throw toUsageError("--sso-start-url is required for the profile command (or set AWS_SSO_START_URL).");
    }
    await runProfileCommand({
      logger,
      cachePath: ".remote-state-cache.json",
      contextPath,
      ssoStartUrl,
      ssoSession: args.values["sso-session"] ?? "sso",
      isTty: process.stdin.isTTY,
    });
    return;
  }

  // Remote commands: bootstrap, scan, init, plan, apply, upgrade
  const overwriteConfirmation = buildOverwriteConfirmation({
    yes: args.values.yes ?? false,
    isTty: process.stdin.isTTY,
  });

  const remoteInput = {
    subcommand: command,
    profile,
    region,
    flags: {
      yes: args.values.yes ?? false,
      refresh: args.values.refresh ?? false,
      allowDestructive: args.values["allow-destructive"] ?? false,
      ignoreUnsupported: args.values["ignore-unsupported"] ?? false,
    },
    logger,
    overwriteConfirmation,
    stsClient: new STSClient(clientConfig),
    s3Client: new S3Client(clientConfig),
    iamClient: new IAMClient(clientConfig),
    lambdaClient: new LambdaClient(clientConfig),
    ssoAdminClient: new SSOAdminClient(clientConfig),
  };

  if (command === "bootstrap") {
    return runRemoteBootstrap(remoteInput);
  }
  if (command === "scan") {
    return runRemoteScan(remoteInput);
  }
  if (command === "init") {
    return runRemoteInit(remoteInput);
  }
  if (command === "plan") {
    return runRemotePlan(remoteInput);
  }
  if (command === "apply") {
    return runRemoteApply(remoteInput);
  }
  if (command === "upgrade") {
    return runRemoteUpgrade(remoteInput);
  }

  printHelp(logger);
  process.exitCode = 1;
}

function printHelp(logger: Logger): void {
  logger.log("@beesolve/aws-accounts");
  logger.log("");
  logger.log("Usage:");
  logger.log(
    "  npm run cli -- bootstrap [--profile <name>] [--region <region>] [--yes]",
  );
  logger.log(
    "  npm run cli -- scan [--profile <name>] [--region <region>]",
  );
  logger.log(
    "  npm run cli -- init [--profile <name>] [--region <region>] [--yes]",
  );
  logger.log("  npm run cli -- regenerate [--yes]");
  logger.log("  npm run cli -- validate");
  logger.log("  npm run cli -- graveyard");
  logger.log(
    "  npm run cli -- profile --sso-start-url <url> [--sso-session <name>]  (env: AWS_SSO_START_URL)",
  );
  logger.log(
    "  npm run cli -- plan [--profile <name>] [--region <region>] [--refresh]",
  );
  logger.log(
    "  npm run cli -- apply [--profile <name>] [--region <region>] [--yes] [--allow-destructive] [--ignore-unsupported]",
  );
  logger.log(
    "  npm run cli -- upgrade [--profile <name>] [--region <region>]",
  );
  logger.log("");
  logger.log("Environment fallback:");
  logger.log("  AWS_PROFILE, AWS_REGION, AWS_DEFAULT_REGION");
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
