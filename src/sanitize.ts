export function sanitizeTerminalControls(value: string, replacement = ''): string {
  return Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 0x20 || (point >= 0x7f && point <= 0x9f) ? replacement : character;
  }).join('');
}
