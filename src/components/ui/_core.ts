export const spacing = {
  none: 0,
  xs: 1,
  sm: 1,
  md: 2,
  lg: 3,
  xl: 4,
} as const;

export const borderStyles = {
  single: {
    topLeft: "┌",
    top: "─",
    topRight: "┐",
    left: "│",
    right: "│",
    bottomLeft: "└",
    bottom: "─",
    bottomRight: "┘",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
  double: {
    topLeft: "╔",
    top: "═",
    topRight: "╗",
    left: "║",
    right: "║",
    bottomLeft: "╚",
    bottom: "═",
    bottomRight: "╝",
    topT: "╦",
    bottomT: "╩",
    leftT: "╠",
    rightT: "╣",
    cross: "╬",
  },
  rounded: {
    topLeft: "╭",
    top: "─",
    topRight: "╮",
    left: "│",
    right: "│",
    bottomLeft: "╰",
    bottom: "─",
    bottomRight: "╯",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
  bold: {
    topLeft: "┏",
    top: "━",
    topRight: "┓",
    left: "┃",
    right: "┃",
    bottomLeft: "┗",
    bottom: "━",
    bottomRight: "┛",
    topT: "┳",
    bottomT: "┻",
    leftT: "┣",
    rightT: "┫",
    cross: "╋",
  },
  ascii: {
    topLeft: "+",
    top: "-",
    topRight: "+",
    left: "|",
    right: "|",
    bottomLeft: "+",
    bottom: "-",
    bottomRight: "+",
    topT: "+",
    bottomT: "+",
    leftT: "+",
    rightT: "+",
    cross: "+",
  },
} as const;

export type BorderStyle = keyof typeof borderStyles;

/**
 The is-unicode-supported heuristic: legacy conhost fonts lack the glyphs below,
 the listed Windows terminals come with fonts that have them.
**/
export function unicodeSupported(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return env.TERM !== "linux";
  return Boolean(
    env.WT_SESSION ||
    env.TERMINUS_SUBLIME ||
    env.CI ||
    env.ConEmuTask === "{cmd::Cmder}" ||
    env.TERM_PROGRAM === "vscode" ||
    env.TERM_PROGRAM === "Terminus-Sublime" ||
    env.TERM === "xterm-256color" ||
    env.TERM === "alacritty" ||
    env.TERM?.startsWith("rxvt-unicode") ||
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm",
  );
}

const unicode = unicodeSupported(process.env, process.platform);

const unicodeGlyphs = {
  pointer: "❯",
  check: "✔",
  cross: "✗",
  done: "✓",
  failed: "✕",
  bullet: "⏺",
  star: "✻",
  enter: "↵",
  shift: "⇧",
  warning: "⚠",
  info: "ℹ",
  file: "📄",
  folder: "📁",
  folderOpen: "📂",
};

const asciiGlyphs: typeof unicodeGlyphs = {
  pointer: ">",
  check: "*",
  cross: "x",
  done: "*",
  failed: "x",
  bullet: "o",
  star: "*",
  enter: "enter",
  shift: "shift+",
  warning: "!",
  info: "i",
  file: "-",
  folder: "+",
  folderOpen: "-",
};

export const glyphs = unicode ? unicodeGlyphs : asciiGlyphs;

const line = ["-", "\\", "|", "/"];

export const spinnerFrames = unicode
  ? {
      dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
      line,
      arc: ["◜", "◠", "◝", "◞", "◡", "◟"],
      bounce: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
    }
  : { dots: line, line, arc: line, bounce: line };

export type SpinnerType = keyof typeof spinnerFrames;

export interface InkUITheme {
  colors: {
    primary: string;
    secondary: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    muted: string;
    text: string;
    textInverse: string;
    border: string;
    focus: string;
    selection: string;
  };
  border: "single" | "double" | "rounded" | "bold" | "ascii";
}

export const darkTheme: InkUITheme = {
  colors: {
    primary: "cyan",
    secondary: "magenta",
    success: "green",
    warning: "yellow",
    error: "red",
    info: "blue",
    muted: "#888888",
    text: "white",
    textInverse: "black",
    border: "gray",
    focus: "cyan",
    selection: "blue",
  },
  border: "single",
};

export const lightTheme: InkUITheme = {
  colors: {
    primary: "blue",
    secondary: "magenta",
    success: "green",
    warning: "yellow",
    error: "red",
    info: "cyan",
    muted: "gray",
    text: "black",
    textInverse: "white",
    border: "gray",
    focus: "blue",
    selection: "cyan",
  },
  border: "rounded",
};
