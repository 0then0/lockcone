export function sanitizeTerminalControls(value: string, replacement = ''): string {
  return Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    const isBidiControl =
      point === 0x061c ||
      point === 0x200e ||
      point === 0x200f ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069);
    return point < 0x20 || (point >= 0x7f && point <= 0x9f) || isBidiControl
      ? replacement
      : character;
  }).join('');
}
