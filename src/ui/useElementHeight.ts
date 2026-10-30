import { useCallback, useRef, useState } from 'react';

/** A callback ref and the current border-box height of the element it is attached to. */
export function useElementHeight<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      return;
    }
    const measure = () => setHeight(Math.ceil(el.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);

  return [ref, height];
}
