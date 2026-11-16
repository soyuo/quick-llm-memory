export interface ConfigurationErrorOptions {
  filePath?: string;
  cause?: unknown;
}

export class ConfigurationError extends Error {
  readonly filePath: string | undefined;

  constructor(message: string, options: ConfigurationErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ConfigurationError';
    this.filePath = options.filePath;
  }
}
