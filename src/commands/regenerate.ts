import { regenerateAwsConfigTypes } from "../awsConfig.js";
import type { Logger } from "../logger.js";

type RegenerateCommandInput = {
  logger: Logger;
  overwriteConfirmation: (props: { fileSummaries: Array<string> }) => Promise<boolean>;
  configPath?: string;
  typesPath?: string;
};

type RegenerateCommandResult = {
  typesPath: string;
  changed: boolean;
  files: Array<{ path: string; status: "written" | "unchanged" | "would-write" }>;
};

export async function runRegenerateCommand(
  props: RegenerateCommandInput,
): Promise<RegenerateCommandResult> {
  const result = await regenerateAwsConfigTypes({
    configPath: props.configPath ?? "aws.config.ts",
    typesPath: props.typesPath ?? "aws.config.types.ts",
    logger: props.logger,
    overwriteConfirmation: props.overwriteConfirmation,
  });
  return {
    typesPath: result.typesPath,
    changed: result.changed,
    files: result.files,
  };
}
