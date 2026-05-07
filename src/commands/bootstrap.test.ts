import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRootChildrenForBootstrap,
  assertAwsContextCompatibleWithExisting,
  pendingOuName,
  validateAwsContextFile,
  type AwsContextFile,
  type RootChildOu,
} from "./bootstrap.js";

function ctx(partial: Partial<AwsContextFile> & Pick<AwsContextFile, "organization">): AwsContextFile {
  return validateAwsContextFile({ value: {
    version: "1",
    generatedAt: "2026-05-06T00:00:00.000Z",
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-1",
      identityStoreId: "d-1",
    },
    deployment: {
      profile: "",
      region: "",
      lambdaArn: "",
      stateBucketName: "",
    },
    ...partial,
    organization: partial.organization,
  }});
}

test("analyzeRootChildrenForBootstrap detects missing and existing OUs", () => {
  const children: RootChildOu[] = [
    { id: "ou-p", name: pendingOuName, arn: "arn:pending" },
  ];
  const analysis = analyzeRootChildrenForBootstrap({ children });
  if (analysis.ok === false) {
    assert.fail("Expected successful OU analysis.");
    return;
  }
  assert.equal(analysis.pendingOuId, "ou-p");
  assert.equal(analysis.graveyardOuId, undefined);
  assert.equal(analysis.needsPendingCreate, false);
  assert.equal(analysis.needsGraveyardCreate, true);
});

test("analyzeRootChildrenForBootstrap fails on duplicate Pending", () => {
  const children: RootChildOu[] = [
    { id: "ou-1", name: pendingOuName, arn: "arn:1" },
    { id: "ou-2", name: pendingOuName, arn: "arn:2" },
  ];
  const analysis = analyzeRootChildrenForBootstrap({ children });
  assert.equal(analysis.ok, false);
});

test("assertAwsContextCompatibleWithExisting passes when organization matches", () => {
  const organization = {
    managementAccountId: "111111111111",
    rootId: "r-1",
    pendingOuId: "ou-p",
    graveyardOuId: "ou-g",
  };
  const existing = ctx({ organization });
  const next = ctx({
    organization,
    generatedAt: "2026-05-06T00:00:01.000Z",
  });
  assertAwsContextCompatibleWithExisting({ existing, next });
});

test("assertAwsContextCompatibleWithExisting throws when pendingOuId differs", () => {
  const existing = ctx({
    organization: {
      managementAccountId: "111111111111",
      rootId: "r-1",
      pendingOuId: "ou-old",
      graveyardOuId: "ou-g",
    },
  });
  const next = ctx({
    organization: {
      managementAccountId: "111111111111",
      rootId: "r-1",
      pendingOuId: "ou-new",
      graveyardOuId: "ou-g",
    },
    generatedAt: "2026-05-06T00:00:01.000Z",
  });
  assert.throws(() => assertAwsContextCompatibleWithExisting({ existing, next }));
});

test("assertAwsContextCompatibleWithExisting throws when identityCenter differs", () => {
  const organization = {
    managementAccountId: "111111111111",
    rootId: "r-1",
    pendingOuId: "ou-p",
    graveyardOuId: "ou-g",
  };
  const existing = ctx({ organization });
  const next = validateAwsContextFile({ value: {
    ...existing,
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-2",
      identityStoreId: "d-2",
    },
    generatedAt: "2026-05-06T00:00:01.000Z",
  }});
  assert.throws(() => assertAwsContextCompatibleWithExisting({ existing, next }));
});

test("validateAwsContextFile rejects unknown top-level keys", () => {
  assert.throws(() =>
    validateAwsContextFile({ value: {
      version: "1",
      generatedAt: "2026-05-06T00:00:00.000Z",
      organization: {
        managementAccountId: "111111111111",
        rootId: "r-1",
        pendingOuId: "ou-p",
        graveyardOuId: "ou-g",
      },
      deployment: {
        profile: "",
        region: "",
        lambdaArn: "",
        stateBucketName: "",
      },
      extra: true,
    }}),
  );
});
