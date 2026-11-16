import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { InternalError, QLMError } from './errors/qlm-error.js';
import {
  registerProjectCommands,
  type ProjectCommandOptions,
} from './projects/commands.js';

interface PackageMetadata {
  description: string;
  version: string;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

export function createCli(options: ProjectCommandOptions = {}): Command {
  const cli = new Command()
    .name('qlm')
    .description(packageMetadata.description)
    .version(packageMetadata.version);

  registerProjectCommands(cli, options);
  return cli;
}

export interface CliOutput {
  writeOut?: (text: string) => void;
  writeError?: (text: string) => void;
}

export async function runCli(
  argv: string[] = process.argv,
  output: CliOutput = {},
  options: ProjectCommandOptions = {},
): Promise<number> {
  const writeError =
    output.writeError ?? ((text: string) => process.stderr.write(text));
  const cli = createCli({
    ...options,
    writeOut: output.writeOut ?? options.writeOut,
  })
    .configureOutput({
      writeOut: output.writeOut ?? ((text) => process.stdout.write(text)),
      writeErr: writeError,
      outputError: (text, write) => write(text),
    })
    .exitOverride();

  try {
    await cli.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) {
        writeError('Action: Run `qlm --help` to review available options.\n');
      }

      return error.exitCode;
    }

    return reportCliError(error, writeError);
  }
}

export function reportCliError(
  error: unknown,
  writeError: (text: string) => void = (text) => process.stderr.write(text),
): number {
  const qlmError =
    error instanceof QLMError
      ? error
      : new InternalError(undefined, {
          cause: error,
          suggestedAction: 'Run `qlm --help` for command usage.',
        });
  const lines = [`Error [${qlmError.code}]: ${qlmError.message}`];

  if (qlmError.suggestedAction !== undefined) {
    lines.push(`Action: ${qlmError.suggestedAction}`);
  }

  writeError(`${lines.join('\n')}\n`);
  return 1;
}
