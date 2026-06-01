import { ANSI } from '../../constants';

export function createGradient(text: string): string {
  const colors = [
    ANSI.yellow, // Standard ANSI Yellow (matches Ink's yellow)
    ANSI.brightYellow,
    ANSI.mutedYellow,
    ANSI.darkYellow,
    ANSI.yellow, // Back to ANSI Yellow
  ];

  const chars = text.split('');

  return chars
    .map((char, i) => {
      // Distributes the yellow hues across the length of the string
      const colorIndex = Math.floor((i / chars.length) * (colors.length - 1));
      return colors[colorIndex] + char + ANSI.reset;
    })
    .join('');
}
