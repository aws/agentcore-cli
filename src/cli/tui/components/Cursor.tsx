import { Text } from 'ink';
import { useEffect, useState } from 'react';

interface CursorProps {
  /** Character to display at cursor position (default: space) */
  char?: string;
  /** Blink interval in milliseconds (default: 500) */
  interval?: number;
}

/**
 * Blinking cursor that highlights the character at cursor position.
 * When visible, shows the character with inverted colors (white bg, black text).
 * When hidden, shows the character normally.
 */
export function Cursor({ char = ' ', interval = 500 }: CursorProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => setVisible(prev => !prev), interval);
    return () => clearInterval(timer);
  }, [interval]);

  if (visible) {
    return (
      <Text backgroundColor="white" color="black">
        {char}
      </Text>
    );
  }

  return <Text>{char}</Text>;
}
