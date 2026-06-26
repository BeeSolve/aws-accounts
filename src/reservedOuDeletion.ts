import type { AwsContextFile } from "./awsConfig.js";
import type { Plan } from "./operations.js";
import type { StateFile } from "./state.js";

export function applyReservedOuDeletionGuard(props: { plan: Plan; context: AwsContextFile }): Plan {
  const reservedOuNamesById = new Map<string, string>([
    [props.context.organization.graveyardOuId, "Graveyard"],
  ]);
  const operations = props.plan.operations.filter((operation) => {
    if (operation.kind !== "deleteOu") {
      return true;
    }
    return reservedOuNamesById.has(operation.ouId) === false;
  });

  const reservedOuUnsupported = props.plan.operations.flatMap((operation) => {
    if (operation.kind !== "deleteOu") {
      return [];
    }
    const reservedOuName = reservedOuNamesById.get(operation.ouId);
    if (reservedOuName == null) {
      return [];
    }
    return [
      {
        kind: "removedOu" as const,
        category: "destructive" as const,
        description: `reserved OU "${reservedOuName}" cannot be deleted by this tool; delete it manually in AWS if you really need to remove it`,
      },
    ];
  });

  if (reservedOuUnsupported.length === 0) {
    return props.plan;
  }

  const unsupported = [...props.plan.unsupported, ...reservedOuUnsupported].sort((left, right) => {
    const kindComparison = left.kind.localeCompare(right.kind);
    if (kindComparison !== 0) {
      return kindComparison;
    }
    return left.description.localeCompare(right.description);
  });

  return {
    operations,
    unsupported,
  };
}
