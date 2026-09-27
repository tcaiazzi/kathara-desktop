// Keyboard movement inside the title bar's menus (desktop/TitleBar.tsx), as a native menu does it:
// the arrows walk the items that can take focus, wrapping at either end, and skip separators and
// disabled items. Each entry is `true` when it can take focus.

/** The next focusable index after `from` in `direction`, wrapping around; -1 when there is none.
 *  `from` may be -1 (nothing focused yet): moving down then lands on the first item, up on the last. */
export function nextFocusable(focusable: readonly boolean[], from: number, direction: 1 | -1): number {
  const n = focusable.length;
  if (n === 0) return -1;
  let i = from < 0 ? (direction === 1 ? -1 : n) : from;
  for (let step = 0; step < n; step++) {
    i = (i + direction + n) % n;
    if (focusable[i]) return i;
  }
  return -1;
}

export function firstFocusable(focusable: readonly boolean[]): number {
  return nextFocusable(focusable, -1, 1);
}

export function lastFocusable(focusable: readonly boolean[]): number {
  return nextFocusable(focusable, -1, -1);
}

/** The menu next to `current` in the bar, wrapping around, as ←/→ move between menus. */
export function adjacentMenu(count: number, current: number, direction: 1 | -1): number {
  return count === 0 ? -1 : (current + direction + count) % count;
}
