import { useEffect, useRef, type RefObject } from 'react';
import type React from 'react';
import type { Message, Reaction } from '../types';
import { Icon } from '../Icon';
import { color, IconButton } from './Common';
import { EmojiPicker } from './EmojiPicker';

// A one-line stand-in for a message, for quotes and lists.
export function snippet(message: Message) {
    const payload = message.payload;
    if (payload.kind === 'text')
        return payload.text.replace(/\s+/g, ' ').trim().slice(0, 140);
    return payload.kind === 'file' ? payload.name : 'Voice note';
}

export function ReplyQuote({
    parent,
    jump,
}: {
    parent: Message | undefined;
    jump: (id: string) => void;
}) {
    if (!parent)
        return (
            <div className="reply-quote missing">
                <Icon name="reply" size={14} />
                <span>Original message unavailable</span>
            </div>
        );
    return (
        <button
            type="button"
            className="reply-quote"
            aria-label={`Replying to ${parent.name}: ${snippet(parent)}`}
            title="Go to message"
            onClick={() => jump(parent.id)}
        >
            <Icon name="reply" size={14} />
            <strong
                style={
                    {
                        '--name-color': color(parent.from),
                    } as React.CSSProperties
                }
            >
                {parent.name}
            </strong>
            <span>{snippet(parent)}</span>
        </button>
    );
}

export function Reactions({
    reactions,
    scope,
    self,
    name,
    toggle,
    add,
    disabled,
}: {
    reactions: Record<string, Reaction> | undefined;
    scope: string;
    self: string;
    name: (id: string) => string;
    toggle: (emoji: string) => void;
    add: (trigger: HTMLElement) => void;
    disabled: boolean;
}) {
    // Each emoji lists who chose it, in the order people reacted.
    const groups = new Map<string, string[]>();
    for (const [author, reaction] of Object.entries(reactions || {}).sort(
        ([, a], [, b]) => a.time - b.time
    ))
        if (reaction.scope === scope)
            for (const emoji of reaction.emoji)
                groups.set(emoji, [...(groups.get(emoji) || []), author]);
    if (!groups.size) return null;
    return (
        <div className="reactions">
            {[...groups].map(([emoji, authors]) => {
                const mine = authors.includes(self);
                const people = authors.map(name).join(', ');
                return (
                    <button
                        key={emoji}
                        type="button"
                        className={`reaction ${mine ? 'mine' : ''}`}
                        aria-pressed={mine}
                        aria-label={`${emoji} ${authors.length}: ${people}`}
                        title={people}
                        disabled={disabled}
                        onClick={() => toggle(emoji)}
                    >
                        <span className="reaction-emoji">{emoji}</span>
                        <span>{authors.length}</span>
                    </button>
                );
            })}
            <button
                type="button"
                className="reaction add-reaction"
                aria-label="Add reaction"
                title="Add reaction"
                disabled={disabled}
                onClick={(event) => add(event.currentTarget)}
            >
                <Icon name="smile" size={16} />
            </button>
        </div>
    );
}

// The emoji picker, placed beside whatever opened it.
export function ReactionPicker({
    anchor,
    choose,
    close,
}: {
    anchor: HTMLElement;
    choose: (emoji: string) => void;
    close: (restoreFocus?: boolean) => void;
}) {
    const trigger = useRef(anchor) as RefObject<HTMLSpanElement | null>;
    const box = anchor.getBoundingClientRect();
    const width = Math.min(336, innerWidth - 16);
    const left = Math.max(
        8,
        Math.min(box.right - width, innerWidth - width - 8)
    );
    const above = box.top > innerHeight / 2;
    return (
        <div
            className="reaction-picker"
            style={{
                left,
                width,
                ...(above
                    ? { bottom: innerHeight - box.top + 6 }
                    : { top: box.bottom + 6 }),
            }}
        >
            <EmojiPicker trigger={trigger} choose={choose} close={close} />
        </div>
    );
}

export function PinnedPanel({
    messages,
    trigger,
    jump,
    unpin,
    close,
}: {
    messages: Message[];
    trigger: RefObject<HTMLElement | null>;
    jump: (id: string) => void;
    unpin: (id: string) => void;
    close: (restoreFocus?: boolean) => void;
}) {
    const panel = useRef<HTMLDivElement>(null);
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        const outside = (event: Event) => {
            if (
                !panel.current?.contains(event.target as Node) &&
                !trigger.current?.contains(event.target as Node)
            )
                closeRef.current();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closeRef.current(true);
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape, true);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('keydown', escape, true);
        };
    }, [trigger]);
    return (
        <div
            ref={panel}
            className="pinned-panel"
            role="dialog"
            aria-label="Pinned messages"
        >
            <h3>Pinned messages</h3>
            {messages.length ? (
                <ul>
                    {messages.map((message) => (
                        <li key={message.id}>
                            <button
                                type="button"
                                className="pinned-item"
                                onClick={() => jump(message.id)}
                            >
                                <strong>{message.name}</strong>
                                <span>{snippet(message)}</span>
                            </button>
                            <IconButton
                                icon="close"
                                label={`Unpin message from ${message.name}`}
                                onClick={() => unpin(message.id)}
                            />
                        </li>
                    ))}
                </ul>
            ) : (
                <p>No pinned messages.</p>
            )}
        </div>
    );
}
