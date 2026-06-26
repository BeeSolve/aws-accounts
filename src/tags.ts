/** Constant value for the ManagedBy tag */
export const managedByTagValue = "beesolve-aws-accounts";

/** AWS SDK tag format */
export type AwsTag = { Key: string; Value: string };

/**
 * Generate the standard tag set for a managed resource.
 * @param purpose - Non-empty string describing the resource purpose
 * @throws Error if purpose is empty
 */
export function getStandardTags(purpose: string): Array<AwsTag> {
  if (purpose === "") {
    throw new Error("A non-empty purpose is required");
  }

  return [
    { Key: "ManagedBy", Value: managedByTagValue },
    { Key: "Purpose", Value: purpose },
  ];
}
