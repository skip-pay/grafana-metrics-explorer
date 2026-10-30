import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Portal, useStyles2 } from '@grafana/ui';

import { preventDefault } from './utils';

export interface PopoverProps {
  /** Element the popover is attached to (below it, or above when there is no room below). */
  anchor: HTMLElement | null;
  open: boolean;
  children: React.ReactNode;
  /** Called on a mousedown outside both the anchor and the popover. */
  onClose?: () => void;
  /** Preferred width in px, clamped to the viewport; by default the content decides, at least the anchor's width. */
  width?: number;
  maxHeight?: number;
  /** Mousedown inside the popover does not move focus, so the anchor's input keeps it. */
  keepFocus?: boolean;
  className?: string;
  testId?: string;
}

const GAP = 2;
const MARGIN = 8;

/**
 * A fixed-position overlay rendered through Grafana's portal, so the panel's `overflow: hidden` cannot clip it.
 * Positioning writes styles directly to the element (no re-render) and follows scroll, resize and size changes.
 */
export const Popover = ({
  anchor,
  open,
  children,
  onClose,
  width,
  maxHeight = 420,
  keepFocus,
  className,
  testId,
}: PopoverProps) => {
  const styles = useStyles2(getStyles);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !anchor || !el) {
      return;
    }
    let frame = 0;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = vh - rect.bottom - GAP - MARGIN;
      const above = rect.top - GAP - MARGIN;
      const up = below < Math.min(maxHeight, 240) && above > below;
      const fixedWidth = width === undefined ? undefined : Math.min(width, vw - 2 * MARGIN);
      el.style.minWidth = `${Math.min(rect.width, vw - 2 * MARGIN)}px`;
      el.style.maxWidth = `${vw - 2 * MARGIN}px`;
      el.style.width = fixedWidth === undefined ? '' : `${fixedWidth}px`;
      el.style.maxHeight = `${Math.max(120, Math.min(maxHeight, up ? above : below))}px`;
      const elWidth = fixedWidth ?? el.offsetWidth;
      el.style.left = `${Math.max(MARGIN, Math.min(rect.left, vw - elWidth - MARGIN))}px`;
      el.style.top = up ? '' : `${rect.bottom + GAP}px`;
      el.style.bottom = up ? `${vh - rect.top + GAP}px` : '';
      el.style.visibility = 'visible';
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(anchor);
    observer?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [open, anchor, width, maxHeight]);

  useEffect(() => {
    if (!open || !onClose) {
      return;
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Node && (ref.current?.contains(target) || anchor?.contains(target))) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [open, onClose, anchor]);

  if (!open) {
    return null;
  }
  return (
    <Portal>
      <div
        ref={ref}
        className={cx(styles.popover, className)}
        style={{ visibility: 'hidden' }}
        onMouseDown={keepFocus ? preventDefault : undefined}
        data-testid={testId}
      >
        {children}
      </div>
    </Portal>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  popover: css({
    position: 'fixed',
    zIndex: theme.zIndex.dropdown,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: theme.colors.background.elevated,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    boxShadow: theme.shadows.z3,
    color: theme.colors.text.primary,
    fontSize: theme.typography.body.fontSize,
  }),
});
