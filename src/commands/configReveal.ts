import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";

const moduleDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_TEMPLATES_DIR = join(moduleDir, "templates");
const TEMPLATE_FILES = ["config-recorder.yaml", "guardduty-member.yaml"];

export async function runConfigRevealCommand(input: {
  logger: Logger;
  outputDir?: string;
  force?: boolean;
}): Promise<void> {
  const outputDir = input.outputDir ?? "templates";
  await mkdir(outputDir, { recursive: true });

  let skippedCount = 0;
  for (const file of TEMPLATE_FILES) {
    const destPath = join(outputDir, file);
    if (existsSync(destPath) && !input.force) {
      input.logger.log(`Skipped ${destPath} (already exists)`);
      skippedCount++;
      continue;
    }
    const srcPath = join(DEFAULT_TEMPLATES_DIR, file);
    const content = await readFile(srcPath, "utf8");
    await writeFile(destPath, content, "utf8");
    input.logger.log(`${existsSync(destPath) ? "Overwritten" : "Copied"} ${destPath}`);
  }

  if (skippedCount > 0) {
    input.logger.log(`Use --force to overwrite existing files.`);
  }
  input.logger.log("Edit these files to customize. Local copies take precedence over package defaults.");
}
