import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    workspacePath: workspacePath,
    cleanup: async () => {
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}
