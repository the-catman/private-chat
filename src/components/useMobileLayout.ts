import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react';

const query = '(max-width: 840px)';
const subscribe = (notify: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', notify);
    return () => media.removeEventListener('change', notify);
};

export function useMobileLayout() {
    return useSyncExternalStore(
        subscribe,
        () => window.matchMedia(query).matches
    );
}

export function useChatViewport(
    active: boolean,
    scroll: RefObject<HTMLDivElement | null>,
    nearBottom: RefObject<boolean>
) {
    useLayoutEffect(() => {
        if (!active) return;
        const viewport = window.visualViewport;
        const root = document.documentElement;
        let frame = 0;
        const keepBottom = () => {
            if (nearBottom.current && scroll.current)
                scroll.current.scrollTop = scroll.current.scrollHeight;
        };
        const update = () => {
            // A keyboard changes the visible height; pinch zoom must still pan
            // and magnify the existing layout without making it reflow.
            if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
            const height = viewport?.height ?? window.innerHeight;
            const top = viewport?.offsetTop ?? 0;
            const bottom = Math.max(0, window.innerHeight - height - top);
            root.style.setProperty('--chat-height', `${height}px`);
            root.style.setProperty('--chat-top', `${top}px`);
            root.style.setProperty('--chat-bottom', `${bottom}px`);
            root.style.setProperty(
                '--chat-safe-bottom',
                bottom > 100 ? '0px' : 'env(safe-area-inset-bottom, 0px)'
            );
            keepBottom();
        };
        const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(update);
        };
        update();
        const observer = new ResizeObserver(keepBottom);
        if (scroll.current) observer.observe(scroll.current);
        viewport?.addEventListener('resize', schedule);
        viewport?.addEventListener('scroll', schedule);
        window.addEventListener('resize', schedule);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            viewport?.removeEventListener('resize', schedule);
            viewport?.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            for (const name of ['height', 'top', 'bottom', 'safe-bottom'])
                root.style.removeProperty(`--chat-${name}`);
        };
    }, [active, scroll, nearBottom]);
}
