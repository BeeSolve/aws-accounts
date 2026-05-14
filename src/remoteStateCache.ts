import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import { validateState, type StateFile } from "./state.js";

const stateCacheSchema = v.strictObject({
  fetchedAt: v.string(),
  state: v.any(),
});

export type StateCacheFile = {
  fetchedAt: string;
  state: StateFile;
};

export async function readStateCache(
  cachePath: string,
): Promise<StateCacheFile | null> {
  try {
    const content = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const envelope = v.parse(stateCacheSchema, parsed);
    const state = validateState(envelope.state);
    return { fetchedAt: envelope.fetchedAt, state };
  } catch {
    return null;
  }
}

export async function writeStateCache(
  cachePath: string,
  state: StateFile,
): Promise<void> {
  const cacheFile: StateCacheFile = {
    fetchedAt: new Date().toISOString(),
    state,
  };
  const content = `${JSON.stringify(cacheFile, null, 2)}\n`;
  await writeFile(cachePath, content, "utf8");
}

export function isCacheFresh(
  cache: StateCacheFile,
  ttlSeconds: number,
): boolean {
  const fetchedAt = new Date(cache.fetchedAt).getTime();
  const now = Date.now();
  const elapsedMs = now - fetchedAt;
  return elapsedMs <= ttlSeconds * 1000;
}
