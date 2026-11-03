export class OperatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextStep?: string,
  ) {
    super(message);
    this.name = 'OperatorError';
  }
}

/**
 * How a command reports its own structured failure, so a reader keeps choosing
 * the error codes its own contract publishes rather than inheriting another's.
 */
export type Fail = (code: string, message: string, nextStep?: string) => never;

export function assertCondition(
  condition: unknown,
  code: string,
  message: string,
  nextStep?: string,
): asserts condition {
  if (!condition) {
    throw new OperatorError(code, message, nextStep);
  }
}
