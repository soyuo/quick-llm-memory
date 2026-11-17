export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ');
}
