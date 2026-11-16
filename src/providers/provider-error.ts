import {
  QLM_ERROR_CODES,
  QLMError,
  type QLMErrorOptions,
} from '../errors/qlm-error.js';

export interface ProviderErrorOptions extends QLMErrorOptions {
  statusCode?: number;
}

export class ProviderError extends QLMError {
  readonly statusCode: number | undefined;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    const { statusCode, ...errorOptions } = options;
    super(QLM_ERROR_CODES.provider, message, errorOptions);
    this.statusCode = statusCode;
  }
}
