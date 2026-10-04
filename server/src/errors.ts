/**
 * Error taxonomy shared by adapters, the hub and the HTTP layer. The API maps
 * these to status codes by type, so route handlers never have to guess whether
 * a failure was the caller's fault by pattern-matching the message.
 */

/** The caller asked for something invalid: bad parameter, unknown command. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** No such device, scene or automation. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The device exists but has no credentials yet, so the request cannot proceed. */
export class NeedsSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsSetupError';
  }
}

export class UnsupportedCommandError extends BadRequestError {
  constructor(command: string, type: string) {
    super(`command "${command}" is not supported by ${type}`);
    this.name = 'UnsupportedCommandError';
  }
}

export function statusForError(err: unknown): number {
  if (err instanceof NotFoundError) return 404;
  if (err instanceof NeedsSetupError) return 409;
  if (err instanceof BadRequestError) return 400;
  return 500;
}
