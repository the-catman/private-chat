import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { useMobileLayout } from './useMobileLayout';

// Sheets drag from their grab area; drawers leave vertical scrolling native.
export function useMobilePanel(
    ref: RefObject<HTMLElement | null>,
    close: () => void,
    {
        open = true,
        direction = 'down',
        blocked = false,
    }: {
        open?: boolean;
        direction?: 'down' | 'left';
        blocked?: boolean;
    } = {}
) {
    const mobile = useMobileLayout();
    const closeRef = useRef(close);
    closeRef.current = close;
    const dismissRef = useRef(() => {});
    useLayoutEffect(() => {
        const node = ref.current;
        const finish = () => {
            if (node instanceof HTMLDialogElement) node.close();
            closeRef.current();
        };
        dismissRef.current = () => {
            if (!blocked) finish();
        };
        if (!mobile || !open || blocked || !node) return;
        let alive = true;
        let closing = false;
        let animation: Animation | undefined;
        let suppressClick = false;
        let drag:
            | {
                  id: number;
                  x: number;
                  y: number;
                  distance: number;
                  time: number;
                  started: boolean;
              }
            | undefined;
        const transform = (distance: number) =>
            direction === 'down'
                ? `translate3d(0, ${distance}px, 0)`
                : `translate3d(${-distance}px, 0, 0)`;
        const settle = (dismiss: boolean) => {
            if (closing) return;
            closing = dismiss;
            const from = getComputedStyle(node).transform;
            animation?.cancel();
            for (const entry of node.getAnimations()) entry.cancel();
            const distance = dismiss
                ? (direction === 'down'
                      ? node.offsetHeight
                      : node.offsetWidth) + 24
                : 0;
            if (dismiss) node.inert = true;
            const complete = () => {
                if (!alive) return;
                node.style.transform = '';
                animation?.cancel();
                animation = undefined;
                if (dismiss) finish();
            };
            if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                complete();
                return;
            }
            animation = node.animate(
                [{ transform: from }, { transform: transform(distance) }],
                {
                    duration: dismiss ? 180 : 220,
                    easing: 'cubic-bezier(.22, 1, .36, 1)',
                    fill: 'forwards',
                }
            );
            void animation.finished.then(complete, () => {});
        };
        dismissRef.current = () => settle(true);
        const down = (event: PointerEvent) => {
            if (closing || event.button !== 0 || !event.isPrimary) return;
            const target = event.target as HTMLElement;
            if (
                target.closest(
                    'input, textarea, select, a, [contenteditable="true"]'
                )
            )
                return;
            if (direction === 'down' && !target.closest('[data-panel-handle]'))
                return;
            if (!node.contains(target)) return;
            suppressClick = false;
            drag = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                distance: 0,
                time: event.timeStamp,
                started: false,
            };
        };
        const move = (event: PointerEvent) => {
            if (!drag || drag.id !== event.pointerId || closing) return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            const distance = direction === 'down' ? dy : -dx;
            const cross = direction === 'down' ? Math.abs(dx) : Math.abs(dy);
            if (!drag.started) {
                if (Math.max(Math.abs(distance), cross) < 8) return;
                if (distance <= 0 || cross > distance) {
                    drag = undefined;
                    return;
                }
                drag.started = true;
                suppressClick = true;
                for (const entry of node.getAnimations()) entry.cancel();
                node.setPointerCapture(event.pointerId);
            }
            event.preventDefault();
            drag.distance = Math.max(0, distance);
            node.style.transform = transform(drag.distance);
        };
        const up = (event: PointerEvent) => {
            if (!drag || drag.id !== event.pointerId) return;
            const current = drag;
            drag = undefined;
            if (!current.started) return;
            const size =
                direction === 'down' ? node.offsetHeight : node.offsetWidth;
            const velocity =
                current.distance / Math.max(1, event.timeStamp - current.time);
            if (node.hasPointerCapture(event.pointerId))
                node.releasePointerCapture(event.pointerId);
            settle(
                event.type !== 'pointercancel' &&
                    (current.distance > Math.min(110, size * 0.28) ||
                        (current.distance > 35 && velocity > 0.6))
            );
        };
        const click = (event: MouseEvent) => {
            if (!suppressClick && !closing) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            suppressClick = false;
        };
        node.addEventListener('pointerdown', down);
        node.addEventListener('pointermove', move, { passive: false });
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
        node.addEventListener('click', click, true);
        return () => {
            alive = false;
            animation?.cancel();
            if (drag && node.hasPointerCapture(drag.id))
                node.releasePointerCapture(drag.id);
            node.style.transform = '';
            node.inert = false;
            node.removeEventListener('pointerdown', down);
            node.removeEventListener('pointermove', move);
            node.removeEventListener('pointerup', up);
            node.removeEventListener('pointercancel', up);
            node.removeEventListener('click', click, true);
        };
    }, [mobile, open, blocked, direction, ref]);
    return useCallback(() => dismissRef.current(), []);
}
