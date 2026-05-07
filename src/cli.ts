import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import {
  buildAwsClientConfig,
  resolveAwsProfile,
  resolveAwsRegion,
} from "./awsClientConfig.js";
import { runBootstrapCommand } from "./commands/bootstrap.js";
import { runInitCommand } from "./commands/init.js";
import { runPlanCommand } from "./commands/plan.js";
import { runRegenerateCommand } from "./commands/regenerate.js";
import { runScanCommand } from "./commands/scan.js";

type CommandName =
  | "scan"
  | "bootstrap"
  | "init"
  | "regenerate"
  | "create-account"
  | "plan"
  | "apply";

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      profile: { type: "string" },
      region: { type: "string" },
      "instance-arn": { type: "string" },
      yes: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const command = args.positionals[0] as CommandName | undefined;
  if (args.values.help || !command) {
    printHelp();
    return;
  }

  const profile = resolveAwsProfile({ profileArg: args.values.profile });
  const region = resolveAwsRegion({ regionArg: args.values.region });
  const clientConfig = buildAwsClientConfig({
    profile,
    region,
  });

  if (command === "scan") {
    const organizationsClient = new OrganizationsClient(clientConfig);
    const ssoAdminClient = new SSOAdminClient(clientConfig);
    const identityStoreClient = new IdentitystoreClient(clientConfig);
    const result = await runScanCommand({
      organizationsClient: organizationsClient,
      ssoAdminClient: ssoAdminClient,
      identityStoreClient: identityStoreClient,
      instanceArn: args.values["instance-arn"],
    });

    console.log("");
    console.log("Scan complete.");
    console.log(
      `Organization OUs: ${result.state.organization.organizationalUnits.length}`,
    );
    console.log(
      `Organization accounts: ${result.state.organization.accounts.length}`,
    );
    console.log(
      `Identity Center users: ${result.state.identityCenter.users.length}`,
    );
    console.log(
      `Identity Center groups: ${result.state.identityCenter.groups.length}`,
    );
    console.log(
      `Permission sets: ${result.state.identityCenter.permissionSets.length}`,
    );
    console.log(
      `Account assignments: ${result.state.identityCenter.accountAssignments.length}`,
    );
    console.log(`Output: ${result.outputPath}`);
    return;
  }

  if (command === "bootstrap") {
    const organizationsClient = new OrganizationsClient(clientConfig);
    const ssoAdminClient = new SSOAdminClient(clientConfig);
    const planConfirmation = buildBootstrapPlanConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const result = await runBootstrapCommand({
      organizationsClient: organizationsClient,
      ssoAdminClient: ssoAdminClient,
      profile: profile ?? "",
      region: region ?? "",
      instanceArn: args.values["instance-arn"],
      planConfirmation,
    });

    console.log("");
    console.log("Bootstrap complete.");
    console.log(
      `Pending OU (${result.pendingOuId}): ${result.pendingCreated ? "created" : "reused"}`,
    );
    console.log(
      `Graveyard OU (${result.graveyardOuId}): ${result.graveyardCreated ? "created" : "reused"}`,
    );
    console.log(
      `Identity Center metadata: ${result.identityCenterCaptured ? "captured" : "missing"}`,
    );
    console.log(`Output: ${result.outputPath}`);
    return;
  }

  if (command === "init") {
    const organizationsClient = new OrganizationsClient(clientConfig);
    const ssoAdminClient = new SSOAdminClient(clientConfig);
    const identityStoreClient = new IdentitystoreClient(clientConfig);
    const planConfirmation = buildBootstrapPlanConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const overwriteConfirmation = buildOverwriteConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const result = await runInitCommand({
      organizationsClient: organizationsClient,
      ssoAdminClient: ssoAdminClient,
      identityStoreClient: identityStoreClient,
      profile: profile ?? "",
      region: region ?? "",
      instanceArn: args.values["instance-arn"],
      planConfirmation: planConfirmation,
      overwriteConfirmation: overwriteConfirmation,
    });

    console.log("");
    console.log("Init complete.");
    console.log(`Context: ${result.contextPath}`);
    console.log(`State: ${result.statePath}`);
    for (const file of result.files) {
      console.log(`${file.path}: ${file.status}`);
    }
    return;
  }

  if (command === "regenerate") {
    const overwriteConfirmation = buildOverwriteConfirmation({
      yes: args.values.yes,
      isTty: process.stdin.isTTY,
    });
    const result = await runRegenerateCommand({
      overwriteConfirmation: overwriteConfirmation,
    });

    console.log("");
    console.log("Regenerate complete.");
    for (const file of result.files) {
      console.log(`${file.path}: ${file.status}`);
    }
    return;
  }

  if (command === "plan") {
    await runPlanCommand({
      output: args.values.json ? "json" : "human",
    });
    return;
  }

  if (command === "create-account" || command === "apply") {
    console.log(`Command '${command}' is not implemented yet.`);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log("@beesolve/aws-accounts");
  console.log("");
  console.log("Usage:");
  console.log(
    "  npm run cli -- scan [--profile <name>] [--region <region>] [--instance-arn <arn>]",
  );
  console.log(
    "  npm run cli -- bootstrap [--profile <name>] [--region <region>] [--instance-arn <arn>] [--yes]",
  );
  console.log(
    "  npm run cli -- init [--profile <name>] [--region <region>] [--instance-arn <arn>] [--yes]",
  );
  console.log("  npm run cli -- regenerate [--yes]");
  console.log("  npm run cli -- plan [--json]");
  console.log("  npm run cli -- <create-account|apply>");
  console.log("");
  console.log("Environment fallback:");
  console.log("  AWS_PROFILE, AWS_REGION, AWS_DEFAULT_REGION");
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
  return async (
    overwriteProps: { fileSummaries: string[] },
  ): Promise<boolean> => {
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
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CLI failed: ${message}`);
  process.exitCode = 1;
});
