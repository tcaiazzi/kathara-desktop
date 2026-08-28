import { useCallback, useEffect, useState } from "react";

// Numeric pixel dimensions of a DOM element, kept in sync via ResizeObserver. react-arborist's
// <Tree> (react-window under the hood) needs real width/height, not "100%"/"auto".
//
// Uses a callback ref (not useRef + useEffect([])) so the observer attaches whenever the DOM node
// itself shows up — a plain useRef's effect only ever checks ref.current once, at this hook's own
// mount, which is too early if the caller's target element is behind a conditional that isn't true
// yet on first render (e.g. rendered only once some data has loaded).
export function useElementSize<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const ref = useCallback((el: T | null) => {
    setNode(el);
  }, []);

  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return { ref, width: size.width, height: size.height };
}
