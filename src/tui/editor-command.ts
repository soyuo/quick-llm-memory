export function parseEditorCommand(command: string): string[] | undefined {
  const parts: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaping = false;
  const source = command.trim();
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaping) {
      current += character;
      escaping = false;
    } else if (character === '\\' && quote !== 'single') {
      const next = source[index + 1];
      if (next !== undefined && (/[\s"'\\]/u.test(next))) {
        escaping = true;
      } else {
        current += character;
      }
    } else if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
    } else if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
    } else if (/\s/u.test(character) && quote === undefined) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaping || quote !== undefined) return undefined;
  if (current.length > 0) parts.push(current);
  return parts.length === 0 ? undefined : parts;
}
