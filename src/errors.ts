import type { ApiErrorInit } from "./types";

export class ApiError extends Error {
  code: string | undefined;
  status: number | undefined;
  fields: Record<string, string | string[]> | undefined;
  raw: unknown | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.fields = init.fields;
    this.raw = init.raw;
  }
}
