export class FetchTransportError extends Error {
  error: unknown;

  constructor(error: unknown) {
    super("Fetch transport failed", { cause: error });
    this.name = "FetchTransportError";
    this.error = error;
  }
}

export function isClientOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}
