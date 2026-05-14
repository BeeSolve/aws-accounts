import {
  InvokeCommand,
  type InvokeCommandOutput,
  TooManyRequestsException,
  type LambdaClient,
} from "@aws-sdk/client-lambda";
import * as v from "valibot";
import { operationSchema } from "./operations.js";
import { stateSchema, type StateFile } from "./state.js";

// --- Request Schema ---

const scanRequestSchema = v.strictObject({
  action: v.literal("scan"),
});

const getStateUrlRequestSchema = v.strictObject({
  action: v.literal("getStateUrl"),
});

const applyRequestSchema = v.strictObject({
  action: v.literal("apply"),
  operations: v.pipe(v.array(operationSchema), v.minLength(1)),
  allowDestructive: v.boolean(),
});

export const lambdaRequestSchema = v.variant("action", [
  scanRequestSchema,
  getStateUrlRequestSchema,
  applyRequestSchema,
]);

export type LambdaRequestPayload = v.InferOutput<typeof lambdaRequestSchema>;

// --- Response Schema ---

const scanResponseSchema = v.strictObject({
  action: v.literal("scan"),
  success: v.literal(true),
  summary: v.strictObject({
    organizationalUnits: v.number(),
    accounts: v.number(),
    users: v.number(),
    groups: v.number(),
    permissionSets: v.number(),
    accountAssignments: v.number(),
  }),
  state: stateSchema,
});

const getStateUrlResponseSchema = v.strictObject({
  action: v.literal("getStateUrl"),
  success: v.literal(true),
  url: v.string(),
  expiresInSeconds: v.number(),
});

const applySuccessResponseSchema = v.strictObject({
  action: v.literal("apply"),
  success: v.literal(true),
  operationsCompleted: v.number(),
  state: stateSchema,
});

const errorResponseSchema = v.strictObject({
  success: v.literal(false),
  error: v.strictObject({
    kind: v.picklist([
      "validation",
      "concurrencyConflict",
      "operationFailed",
      "internal",
    ]),
    message: v.string(),
    details: v.optional(
      v.strictObject({
        failedOperation: v.optional(v.number()),
        operationsCompleted: v.optional(v.number()),
        partialState: v.optional(stateSchema),
        validationIssues: v.optional(v.array(v.string())),
      }),
    ),
  }),
});

export const lambdaResponseSchema = v.union([
  scanResponseSchema,
  getStateUrlResponseSchema,
  applySuccessResponseSchema,
  errorResponseSchema,
]);

export type LambdaResponsePayload = v.InferOutput<typeof lambdaResponseSchema>;

// --- Error Types ---

export type LambdaInvokeError =
  | { kind: "validation"; details: string }
  | { kind: "concurrencyConflict"; message: string }
  | {
      kind: "operationFailed";
      failedOperation: number;
      totalOperations: number;
      error: string;
      partialState: StateFile;
    }
  | { kind: "invocationError"; message: string };

// --- Result Type ---

export type LambdaInvokeResult =
  | { ok: true; response: LambdaResponsePayload }
  | { ok: false; error: LambdaInvokeError };

// --- Invocation Props ---

export type InvokeLambdaProps = {
  lambdaClient: LambdaClient;
  lambdaArn: string;
  payload: LambdaRequestPayload;
};

// --- Main Function ---

export async function invokeLambda(
  props: InvokeLambdaProps,
): Promise<LambdaInvokeResult> {
  const { lambdaClient, lambdaArn, payload } = props;

  // todo: I don't like this pattern of `let` - refactor it
  let rawResponse: InvokeCommandOutput;
  try {
    rawResponse = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: lambdaArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
  } catch (error: unknown) {
    if (error instanceof TooManyRequestsException) {
      return {
        ok: false,
        error: {
          kind: "concurrencyConflict",
          message:
            "Lambda concurrency limit reached. Another operation may be in progress.",
        },
      };
    }
    const message =
      error instanceof Error ? error.message : "Unknown invocation error";
    return {
      ok: false,
      error: { kind: "invocationError", message },
    };
  }

  // Check for Lambda execution error (FunctionError indicates the function threw)
  if (rawResponse.FunctionError) {
    const errorPayload = rawResponse.Payload
      ? new TextDecoder().decode(rawResponse.Payload)
      : "Lambda function execution failed";
    return {
      ok: false,
      error: { kind: "invocationError", message: errorPayload },
    };
  }

  // Parse response payload as JSON
  if (!rawResponse.Payload) {
    return {
      ok: false,
      error: { kind: "invocationError", message: "Empty response payload" },
    };
  }

  // todo: I don't like this pattern of `let` - refactor it
  let parsed: unknown;
  try {
    const responseText = new TextDecoder().decode(rawResponse.Payload);
    parsed = JSON.parse(responseText);
  } catch {
    return {
      ok: false,
      error: {
        kind: "invocationError",
        message: "Failed to parse Lambda response as JSON",
      },
    };
  }

  // Validate response against schema
  const result = v.safeParse(lambdaResponseSchema, parsed);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => `${issue.path?.map((p) => p.key).join(".") ?? "root"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      error: {
        kind: "validation",
        details: `Lambda response validation failed: ${issues}`,
      },
    };
  }

  const response = result.output;

  // Map error responses to typed LambdaInvokeError variants
  if ("success" in response && response.success === false) {
    // todo: use assert unreachable pattern instead of switch
    const errorKind = response.error.kind;
    switch (errorKind) {
      case "validation":
        return {
          ok: false,
          error: {
            kind: "validation",
            details: response.error.message,
          },
        };
      case "concurrencyConflict":
        return {
          ok: false,
          error: {
            kind: "concurrencyConflict",
            message: response.error.message,
          },
        };
      case "operationFailed":
        return {
          ok: false,
          error: {
            kind: "operationFailed",
            failedOperation: response.error.details?.failedOperation ?? 0,
            totalOperations:
              (response.error.details?.operationsCompleted ?? 0) + 1,
            error: response.error.message,
            partialState:
              response.error.details?.partialState ?? buildEmptyStateForError(),
          },
        };
      case "internal":
        return {
          ok: false,
          error: {
            kind: "invocationError",
            message: response.error.message,
          },
        };
    }
  }

  return { ok: true, response };
}

function buildEmptyStateForError(): StateFile {
  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization: {
      rootId: "",
      organizationalUnits: [],
      accounts: [],
    },
    identityCenter: {
      instanceArn: "",
      identityStoreId: "",
      users: [],
      groups: [],
      groupMemberships: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: [],
    },
  };
}
