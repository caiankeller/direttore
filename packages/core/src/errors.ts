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

export class HttpResponseError extends Error {
  response: Response;
  body: unknown;
  bodyParseError: unknown | undefined;

  constructor(
    response: Response,
    body: unknown,
    options: { bodyParseError?: unknown } = {},
  ) {
    super(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`, {
      cause: response,
    });
    this.name = "HttpResponseError";
    this.response = response;
    this.body = body;
    this.bodyParseError = options.bodyParseError;
  }

  get status(): number {
    return this.response.status;
  }

  get statusText(): string {
    return this.response.statusText;
  }
}
