export const QLM_ERROR_CODES = {
  configuration: 'QLM_CONFIG_ERROR',
  input: 'QLM_INPUT_ERROR',
  internal: 'QLM_INTERNAL_ERROR',
  provider: 'QLM_PROVIDER_ERROR',
} as const;

export type QLMErrorCode =
  (typeof QLM_ERROR_CODES)[keyof typeof QLM_ERROR_CODES];

export interface QLMErrorOptions {
  details?: unknown;
  retryable?: boolean;
  suggestedAction?: string;
  cause?: unknown;
}

export class QLMError extends Error {
  readonly code: QLMErrorCode;
  readonly details: unknown;
  readonly retryable: boolean;
  readonly suggestedAction: string | undefined;

  constructor(
    code: QLMErrorCode,
    message: string,
    options: QLMErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.suggestedAction = options.suggestedAction;
  }
}

export class InputError extends QLMError {
  constructor(message: string, options: QLMErrorOptions = {}) {
    super(QLM_ERROR_CODES.input, message, options);
  }
}

export class InternalError extends QLMError {
  constructor(message = 'An unexpected error occurred.', options: QLMErrorOptions = {}) {
    super(QLM_ERROR_CODES.internal, message, options);
  }
}
