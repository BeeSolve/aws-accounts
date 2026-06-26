import {
  InvokeCommand,
  type InvokeCommandOutput,
  TooManyRequestsException,
  type LambdaClient,
} from "@aws-sdk/client-lambda";
import * as v from "valibot";
import { assertUnreachable } from "./helpers.js";
import {
  lambdaRequestSchema,
  lambdaResponseSchema,
  type LambdaRequestPayload,
  type LambdaResponsePayload,
} from "./lambdaSchemas.js";
import type { StateFile } from "./state.js";

export { lambdaRequestSchema, type LambdaRequestPayload, lambdaResponseSchema, type LambdaResponsePayload };

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

export type LambdaInvokeResult =
  | { ok: true; response: LambdaResponsePayload }
  | { ok: false; error: LambdaInvokeError };

export type InvokeLambdaProps = {
  lambdaClient: LambdaClient;
  lambdaArn: string;
  payload: LambdaRequestPayload;
};

async function invokeLambdaCommand(
  lambdaClient: LambdaClient,
  lambdaArn: string,
  payload: LambdaRequestPayload,
): Promise<
  | { ok: true; response: InvokeCommandOutput }
  | { ok: false; error: LambdaInvokeError }
> {
  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: lambdaArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
    return { ok: true, response };
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
}

function parseResponsePayload(payload: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    const responseText = new TextDecoder().decode(payload);
    return { ok: true, value: JSON.parse(responseText) as unknown };
  } catch {
    return { ok: false };
  }
}

export async function invokeLambda(
  props: InvokeLambdaProps,
): Promise<LambdaInvokeResult> {
  const invokeResult = await invokeLambdaCommand(props.lambdaClient, props.lambdaArn, props.payload);
  if (!invokeResult.ok) return invokeResult;
  const rawResponse = invokeResult.response;

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

  const parsed = parseResponsePayload(rawResponse.Payload);

  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        kind: "invocationError",
        message: "Failed to parse Lambda response as JSON",
      },
    };
  }

  // Validate response against schema
  const result = v.safeParse(lambdaResponseSchema, parsed.value);
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
    const errorKind = response.error.kind;
    if (errorKind === "validation") {
      return {
        ok: false,
        error: {
          kind: "validation",
          details: response.error.message,
        },
      };
    }
    if (errorKind === "concurrencyConflict") {
      return {
        ok: false,
        error: {
          kind: "concurrencyConflict",
          message: response.error.message,
        },
      };
    }
    if (errorKind === "operationFailed") {
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
    }
    if (errorKind === "internal") {
      return {
        ok: false,
        error: {
          kind: "invocationError",
          message: response.error.message,
        },
      };
    }
    assertUnreachable(errorKind, "Unsupported error kind in Lambda response.");
  }

  return { ok: true, response };
}

function buildEmptyStateForError(): StateFile {
  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization: {
      organizationId: "o-test123",
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
      accessControlAttributes: [],
    },
  };
}
