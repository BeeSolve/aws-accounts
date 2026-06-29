import type { LambdaResponsePayload } from "../lambdaSchemas.ts";
import type { StateFile } from "../state.ts";

type LambdaResponse = LambdaResponsePayload;

export const stateKey = "state.json";

export function buildErrorResponse(
  kind: "validation" | "concurrencyConflict" | "operationFailed" | "internal",
  message: string,
  details?: {
    failedOperation?: number;
    operationsCompleted?: number;
    partialState?: StateFile;
    validationIssues?: Array<string>;
  },
): LambdaResponse {
  return {
    success: false,
    error: {
      kind,
      message,
      ...(details != null ? { details } : {}),
    },
  };
}
