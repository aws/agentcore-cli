import { createContext, useContext, useEffect, useRef } from "react";

export interface KeyHint {
  key: string;
  label: string;
}

export interface WizardControls {
  advance: () => void;
  back: () => void;
  isLast: boolean;
  setHints: (hints: KeyHint[]) => void;
}

const WizardContext = createContext<WizardControls | null>(null);

export const WizardProvider = WizardContext.Provider;

export function useWizard(): WizardControls {
  const controls = useContext(WizardContext);
  if (!controls) {
    throw new Error("wizard fields must be rendered inside a <Wizard>");
  }
  return controls;
}

export function useKeyHints(hints: KeyHint[]): void {
  const { setHints } = useWizard();

  const published = useRef<string | undefined>(undefined);
  useEffect(() => {
    const signature = hints.map((hint) => `${hint.key}:${hint.label}`).join("|");
    if (published.current === signature) return;
    published.current = signature;
    setHints(hints);
  }, [hints, setHints]);
}
