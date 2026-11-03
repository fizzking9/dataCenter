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
