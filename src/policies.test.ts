import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scp } from "./policies.js";

describe("scp.blockExpensiveResources", () => {
  const defaultOptions = {
    allowedEc2InstanceTypes: ["t3.micro", "t3.small", "m8g.medium"],
  };

  it("returns correct shape with defaults", () => {
    const result = scp.blockExpensiveResources(defaultOptions);
    assert.equal(result.name, "BlockExpensiveResources");
    assert.deepEqual(result.targets, ["root"]);
    assert.equal((result.content as any).Version, "2012-10-17");
    assert.equal((result.content as any).Statement.length, 4);
  });

  it("omits Condition when exemptAccounts is empty", () => {
    const result = scp.blockExpensiveResources(defaultOptions);
    const statements = (result.content as any).Statement;
    const denyBedrock = statements.find((s: any) => s.Sid === "DenyBedrock");
    assert.equal(denyBedrock.Condition, undefined);
  });

  it("includes aws:PrincipalAccount condition when exemptAccounts provided", () => {
    const result = scp.blockExpensiveResources({
      ...defaultOptions,
      exemptAccounts: ["111111111111", "222222222222"],
    });
    const statements = (result.content as any).Statement;
    const denyBedrock = statements.find((s: any) => s.Sid === "DenyBedrock");
    assert.deepEqual(denyBedrock.Condition, {
      StringNotEquals: { "aws:PrincipalAccount": ["111111111111", "222222222222"] },
    });
  });

  it("EC2 statement always has ForAnyValue:StringNotLike with allowed types", () => {
    const result = scp.blockExpensiveResources(defaultOptions);
    const statements = (result.content as any).Statement;
    const denyEc2 = statements.find((s: any) => s.Sid === "DenyNonAllowedEC2");
    assert.deepEqual(
      denyEc2.Condition["ForAnyValue:StringNotLike"]["ec2:InstanceType"],
      ["t3.micro", "t3.small", "m8g.medium"],
    );
  });

  it("EC2 statement merges exempt condition with instance type condition", () => {
    const result = scp.blockExpensiveResources({
      ...defaultOptions,
      exemptAccounts: ["111111111111"],
    });
    const statements = (result.content as any).Statement;
    const denyEc2 = statements.find((s: any) => s.Sid === "DenyNonAllowedEC2");
    assert.deepEqual(denyEc2.Condition.StringNotEquals, {
      "aws:PrincipalAccount": ["111111111111"],
    });
    assert.deepEqual(
      denyEc2.Condition["ForAnyValue:StringNotLike"]["ec2:InstanceType"],
      ["t3.micro", "t3.small", "m8g.medium"],
    );
  });

  it("respects custom name and targets", () => {
    const result = scp.blockExpensiveResources({
      ...defaultOptions,
      name: "CustomSCP",
      targets: ["projects", "Sandbox"],
    });
    assert.equal(result.name, "CustomSCP");
    assert.deepEqual(result.targets, ["projects", "Sandbox"]);
  });

  it("minified JSON content fits within 10240 character SCP limit", () => {
    const result = scp.blockExpensiveResources({
      exemptAccounts: ["111111111111", "222222222222", "333333333333"],
      allowedEc2InstanceTypes: [
        "t3.nano", "t3.micro", "t3.small", "t3.medium",
        "t4g.nano", "t4g.micro", "t4g.small", "t4g.medium",
        "m8g.medium", "m8g.large",
      ],
    });
    const size = JSON.stringify(result.content).length;
    assert.ok(size < 10240, `SCP content is ${size} chars, exceeds 10240 limit`);
  });
});
