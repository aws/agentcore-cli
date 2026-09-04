import { Text } from "ink";

export interface GradientTextProps {
  text: string;
  colors: readonly [string, ...string[]];
  span?: number;
}

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

function parseHex(color: string): Rgb {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (!match) throw new Error(`Gradient colors must use six-digit hex values: ${color}`);

  return {
    red: Number.parseInt(match[1]!, 16),
    green: Number.parseInt(match[2]!, 16),
    blue: Number.parseInt(match[3]!, 16),
  };
}

function interpolate(from: number, to: number, progress: number): number {
  return Math.round(from + (to - from) * progress);
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function colorAt(colors: readonly [string, ...string[]], position: number): string {
  if (colors.length === 1) return colors[0];

  const scaledPosition = position * (colors.length - 1);
  const stopIndex = Math.min(Math.floor(scaledPosition), colors.length - 2);
  const stopProgress = scaledPosition - stopIndex;
  const from = parseHex(colors[stopIndex]!);
  const to = parseHex(colors[stopIndex + 1]!);

  return `#${toHex(interpolate(from.red, to.red, stopProgress))}${toHex(
    interpolate(from.green, to.green, stopProgress),
  )}${toHex(interpolate(from.blue, to.blue, stopProgress))}`;
}

export function GradientText({ text, colors, span = Array.from(text).length }: GradientTextProps) {
  const characters = Array.from(text);
  const denominator = Math.max(1, span - 1);

  return (
    <Text>
      {characters.map((character, index) => (
        <Text key={index} color={colorAt(colors, index / denominator)}>
          {character}
        </Text>
      ))}
    </Text>
  );
}
