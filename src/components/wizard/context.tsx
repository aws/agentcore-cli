import React, { useContext, useEffect, useRef } from "react";

export interface KeyHint {
  key: string;
  label: string;
}

// WizardControls is what a field needs from the wizard around it: where to go
// next, where to go back to, and a way to tell the footer what its keys do.
export interface WizardControls {
  // advance moves to the next step, or submits when the active step is last.
  advance: () => void;
  // back steps to the previous step, or cancels out of the wizard on the first.
  back: () => void;
  // isLast reports whether the active step is the final one, so a field can
  // label its enter hint "submit" rather than "continue".
  isLast: boolean;
  // setHints replaces the footer's action hints. Fields call it via useKeyHints.
  setHints: (hints: KeyHint[]) => void;
}

const WizardContext = React.createContext<WizardControls | null>(null);

export const WizardProvider = WizardContext.Provider;

export function useWizard(): WizardControls {
  const controls = useContext(WizardContext);
  if (!controls) {
    throw new Error("wizard fields must be rendered inside a <Wizard>");
  }
  return controls;
}

// useKeyHints publishes the active field's footer hints. Each field declares
// what its own keys do, so <Wizard> never has to switch on step kind the way
// the hand-written wizards' hintsFor() does.
export function useKeyHints(hints: KeyHint[]): void {
  const { setHints } = useWizard();

  // The caller passes a fresh array literal on every render, so the effect is
  // keyed on the hints' content and reads the latest array from a ref. Keying
  // on the array itself would publish, re-render, and publish again forever.
  const latest = useRef(hints);
  latest.current = hints;
  const signature = hints.map((hint) => `${hint.key}:${hint.label}`).join("|");

  useEffect(() => {
    setHints(latest.current);
  }, [signature, setHints]);
}
