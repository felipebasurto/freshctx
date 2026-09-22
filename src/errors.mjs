export class FreshCtxError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "FreshCtxError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new FreshCtxError(code, message, details);
}

export function publicError(error) {
  if (error instanceof FreshCtxError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: "internal_error", message: "FreshCtx could not complete the operation" };
}
