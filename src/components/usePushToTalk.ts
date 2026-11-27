import { useEffect, useSyncExternalStore } from 'react';
import type { ChatClient } from '../lib/client';
import {
    getAudioPreferences,
    subscribeAudioPreferences,
} from '../lib/audio-preferences';

// Talking stops a moment after the key is released, so the last word is sent.
const RELEASE_MS = 200;

// Events from the pop-out come from another window, so no instanceof here.
const within = (target: EventTarget | null, selector: string) =>
    Boolean((target as Element | null)?.closest?.(selector));
const typingIn = (target: EventTarget | null) =>
    within(
        target,
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    );
const pressable = (target: EventTarget | null) =>
    within(
        target,
        'button, a[href], summary, input, select, [role="button"], [role="menuitem"], [role="slider"]'
    );

// Holding the push-to-talk key turns the microphone on, but only while this
// tab or its call pop-out has focus. Browsers do not offer global keys.
export function usePushToTalk(client: ChatClient, popout?: Window | null) {
    const prefs = useSyncExternalStore(
        subscribeAudioPreferences,
        getAudioPreferences
    );
    const { pushToTalk, pushToTalkKey: key } = prefs;
    useEffect(() => {
        if (!pushToTalk) return;
        let held = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
            clearTimeout(timer);
            held = false;
            client.rtc?.talk(false);
        };
        const down = (event: KeyboardEvent) => {
            if (event.code !== key || event.defaultPrevented) return;
            // A key that types or presses stays itself where it would.
            if (typingIn(event.target) && event.key.length === 1) return;
            if (event.code === 'Space' && pressable(event.target)) return;
            event.preventDefault();
            if (event.repeat && held) return;
            clearTimeout(timer);
            held = true;
            client.rtc?.talk(true);
        };
        const up = (event: KeyboardEvent) => {
            if (event.code !== key || !held) return;
            event.preventDefault();
            held = false;
            clearTimeout(timer);
            timer = setTimeout(() => client.rtc?.talk(false), RELEASE_MS);
        };
        const hidden = () => {
            if (document.visibilityState === 'hidden') stop();
        };
        const views = [
            window,
            ...(popout && popout !== window ? [popout] : []),
        ];
        for (const view of views) {
            view.addEventListener('keydown', down);
            view.addEventListener('keyup', up);
            view.addEventListener('blur', stop);
        }
        document.addEventListener('visibilitychange', hidden);
        return () => {
            for (const view of views) {
                view.removeEventListener('keydown', down);
                view.removeEventListener('keyup', up);
                view.removeEventListener('blur', stop);
            }
            document.removeEventListener('visibilitychange', hidden);
            stop();
        };
    }, [client, pushToTalk, key, popout]);
    return prefs;
}
