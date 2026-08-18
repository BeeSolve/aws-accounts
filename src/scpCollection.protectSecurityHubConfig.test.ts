import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toScpCollection } from "./scpCollection.js";

describe("security.protectSecurityHubConfig", () => {
  const collection = toScpCollection<string, string>();

  it("returns a PolicyEntry denying Security Hub weakening actions with exempt roles condition", () => {
    const result = collection.security.protectSecurityHubConfig({
      exemptRoles: ["arn:aws:iam::*:role/SecurityAdmin"],
    });

    assert.equal(result.name, "ProtectSecurityHubConfig");
    assert.deepEqual(result.targets, ["root"]);

    const statement = (result.content as any).Statement[0];
    assert.equal(statement.Effect, "Deny");
    assert.deepEqual(statement.Action, [
      "securityhub:BatchDisableStandards",
      "securityhub:UpdateStandardsControl",
      "securityhub:UpdateSecurityHubConfiguration",
      "securityhub:UpdateOrganizationConfiguration",
      "securityhub:DisableImportFindingsForProduct",
      "securityhub:DeleteActionTarget",
      "securityhub:DeleteInsight",
      "securityhub:UpdateFindingAggregator",
    ]);
    assert.equal(statement.Resource, "*");
    assert.deepEqual(statement.Condition, {
      StringNotLike: {
        "aws:PrincipalARN": ["arn:aws:iam::*:role/SecurityAdmin"],
      },
    });
  });

  it("supports multiple exempt roles", () => {
    const result = collection.security.protectSecurityHubConfig({
      exemptRoles: ["arn:aws:iam::*:role/SecurityAdmin", "arn:aws:iam::*:role/OrganizationAdmin"],
    });

    const statement = (result.content as any).Statement[0];
    assert.deepEqual(statement.Condition, {
      StringNotLike: {
        "aws:PrincipalARN": [
          "arn:aws:iam::*:role/SecurityAdmin",
          "arn:aws:iam::*:role/OrganizationAdmin",
        ],
      },
    });
  });

  it("uses custom name when provided", () => {
    const result = collection.security.protectSecurityHubConfig({
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
      name: "CustomHubProtection",
    });

    assert.equal(result.name, "CustomHubProtection");
  });

  it("uses custom targets when provided", () => {
    const result = collection.security.protectSecurityHubConfig({
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
      targets: ["ou-security"],
    });

    assert.deepEqual(result.targets, ["ou-security"]);
  });

  it("throws when exemptRoles is empty", () => {
    assert.throws(() => collection.security.protectSecurityHubConfig({ exemptRoles: [] }), {
      message:
        "protectSecurityHubConfig: exemptRoles must contain at least one IAM role ARN pattern",
    });
  });
});
