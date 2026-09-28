const ERASE_SCREEN_AND_HOME = "\u001B[2J\u001B[H";

// clearScreenOnNarrowing wipes the whole alternate screen whenever the terminal
// gets narrower. Ink erases its previous frame by moving up one row per frame
// line, but the terminal has already rewrapped any line wider than the new
// width onto several rows, so that erase falls short and leaves stale copies of
// full-width rows (dividers, the key-hint rule) stacked above the next frame.
// The listener is prepended so it runs before Ink's own resize handler, which
// on narrowing forgets its previous frame and repaints the whole frame from the
// home position this leaves the cursor at. Widening needs nothing: no line
// wraps, and Ink keeps diffing against its previous frame, so clearing there
// would blank the rows it does not rewrite. Returns the unsubscribe function.
export function clearScreenOnNarrowing(stdout: NodeJS.WriteStream): () => void {
  let lastColumns = stdout.columns;
  const onResize = () => {
    const columns = stdout.columns;
    if (columns && lastColumns && columns < lastColumns) {
      stdout.write(ERASE_SCREEN_AND_HOME);
    }
    lastColumns = columns;
  };
  stdout.prependListener("resize", onResize);
  return () => {
    stdout.off("resize", onResize);
  };
}
