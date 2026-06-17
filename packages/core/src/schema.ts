import type { SchemaLike } from "./types";

export type SchemaValidationPhase = "input" | "response" | "output";

export class SchemaValidationError extends Error {
  phase: SchemaValidationPhase;
  raw: unknown;

  constructor(phase: SchemaValidationPhase, raw: unknown) {
    super(`Endpoint ${phase} validation failed`);
    this.name = "SchemaValidationError";
    this.phase = phase;
    this.raw = raw;
  }
}

export async function parseWithSchema<T>(
  schema: SchemaLike<T> | undefined,
  value: unknown,
  phase: SchemaValidationPhase,
): Promise<T> {
  if (!schema) {
    return value as T;
  }

  try {
    if ("safeParse" in schema) {
      const result = schema.safeParse(value);
      if (result.success) {
        return result.data;
      }

      throw result.error;
    }

    if ("parse" in schema) {
      return schema.parse(value);
    }

    return await schema.validate(value);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw error;
    }

    throw new SchemaValidationError(phase, error);
  }
}
