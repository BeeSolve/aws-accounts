import { parseArgs } from "node:util";
import { runScanCommand } from "./commands/scan.js";

type CommandName = "scan" | "bootstrap" | "create-account" | "plan" | "apply";

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      profile: { type: "string" },
      region: { type: "string" },
      "instance-arn": { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false }
    },
    allowPositionals: true
  });

  const command = args.positionals[0] as CommandName | undefined;
  if (args.values.help || !command) {
    printHelp();
    return;
  }

  if (command === "scan") {
    const result = await runScanCommand({
      profile: args.values.profile,
      region: args.values.region,
      instanceArn: args.values["instance-arn"]
    });

    console.log("");
    console.log("Scan complete.");
    console.log(`Organization OUs: ${result.state.organization.organizationalUnits.length}`);
    console.log(`Organization accounts: ${result.state.organization.accounts.length}`);
    console.log(`Identity Center users: ${result.state.identityCenter.users.length}`);
    console.log(`Identity Center groups: ${result.state.identityCenter.groups.length}`);
    console.log(`Permission sets: ${result.state.identityCenter.permissionSets.length}`);
    console.log(`Account assignments: ${result.state.identityCenter.accountAssignments.length}`);
    console.log(`Output: ${result.outputPath}`);
    return;
  }

  if (command === "bootstrap" || command === "create-account" || command === "plan" || command === "apply") {
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
  console.log("  npm run cli -- scan [--profile <name>] [--region <region>] [--instance-arn <arn>]");
  console.log("  npm run cli -- <bootstrap|create-account|plan|apply>");
  console.log("");
  console.log("Environment fallback:");
  console.log("  AWS_PROFILE, AWS_REGION, AWS_DEFAULT_REGION");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CLI failed: ${message}`);
  process.exitCode = 1;
});
