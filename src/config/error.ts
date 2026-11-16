import {
  QLM_ERROR_CODES,
  QLMError,
  type QLMErrorOptions,
} from '../errors/qlm-error.js';

export interface ConfigurationErrorOptions {
  filePath?: string;
  cause?: QLMErrorOptions['cause'];
  suggestedAction?: string;
}

export class ConfigurationError extends QLMError {
  readonly filePath: string | undefined;

  constructor(message: string, options: ConfigurationErrorOptions = {}) {
    super(QLM_ERROR_CODES.configuration, message, {
      cause: options.cause,
      details:
        options.filePath === undefined ? undefined : { filePath: options.filePath },
      suggestedAction:
        options.suggestedAction ??
        'Check the settings file and correct the reported value.',
    });
    this.filePath = options.filePath;
  }
}
