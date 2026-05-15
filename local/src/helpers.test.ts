import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

export async function createTestWorkspace(props: { prefix: string }): Promise<{
  workspacePath: string;
  cleanup: () => Promise<void>;
}> {
  const projectPath = process.cwd();
  const workspacePath = await mkdtemp(join(tmpdir(), props.prefix));
  await symlink(
    join(projectPath, "node_modules"),
    join(workspacePath, "node_modules"),
    "dir",
  );
  return {
    workspacePath,
    cleanup: async () => {
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

type IamActionFactory = (action: string) => string;

type IamHelper = Record<string, IamActionFactory>;

const configExpressionPattern =
  /const awsConfig: AwsConfig = v\.parse\(awsConfigSchema,\s*([\s\S]*?)\s*(?:satisfies AwsConfig)?\);\s*export default awsConfig;/;

export async function readConfigModelForTest<T>(props: {
  configPath: string;
}): Promise<T> {
  const rawConfig = await readFile(props.configPath, "utf8");
  const matched = rawConfig.match(configExpressionPattern);
  if (matched?.[1] == null) {
    throw new Error(
      `Could not extract awsConfig object from test fixture ${props.configPath}.`,
    );
  }

  // Test fixtures only need the authored config object, not full TS bundling.
  return runInNewContext(`(${matched[1]})`, {
    iam: createIamHelper(),
  }) as T;
}

export async function writeConfigModelForTest(props: {
  configPath: string;
  config: unknown;
}): Promise<void> {
  const nextConfig = `import * as v from "valibot";
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

const awsConfig: AwsConfig = v.parse(awsConfigSchema, ${JSON.stringify(props.config, null, 2)} satisfies AwsConfig);

export default awsConfig;
`;
  await writeFile(props.configPath, nextConfig, "utf8");
}

function createIamHelper(): IamHelper {
  return new Proxy(
    {},
    {
      get(_target, servicePrefix): IamActionFactory {
        return (action) => `${String(servicePrefix)}:${action}`;
      },
    },
  ) as IamHelper;
}
