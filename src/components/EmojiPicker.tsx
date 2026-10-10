import {
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type RefObject,
} from 'react';
import { EMOJI_GROUPS, searchEmoji } from '../lib/emoji';
import { Icon } from '../Icon';

const PAGE_SIZE = 120;
const categoryIcons: Record<number, string> = {
    0: '😄',
    1: '👋',
    2: '🧩',
    3: '🐻',
    4: '🍕',
    5: '🚗',
    6: '⚽',
    7: '💡',
    8: '💜',
    9: '🏳️',
};

export function EmojiPicker({
    trigger,
    choose,
    close,
}: {
    trigger: RefObject<HTMLSpanElement | null>;
    choose: (emoji: string) => void;
    close: (restoreFocus?: boolean) => void;
}) {
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState('all');
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const id = useId();
    const tabs = [
        ['all', 'All emojis'],
        ...EMOJI_GROUPS.map(([key, name]) => [String(key), name]),
    ];
    const selectCategory = (key: string) => {
        setCategory(key);
        setSearch('');
        resetScroll();
    };
    const panel = useRef<HTMLDivElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const moreButton = useRef<HTMLButtonElement>(null);
    const closeRef = useRef(close);
    closeRef.current = close;
    const matches = useMemo(
        () =>
            searchEmoji(
                search,
                category === 'all' ? undefined : Number(category)
            ),
        [search, category]
    );
    const hasMore = visibleCount < matches.length;
    const resetScroll = () => {
        setVisibleCount(PAGE_SIZE);
        if (scroller.current) scroller.current.scrollTop = 0;
    };
    const revealMore = (focusIndex?: number) => {
        setVisibleCount((count) => Math.min(matches.length, count + PAGE_SIZE));
        if (focusIndex !== undefined)
            requestAnimationFrame(() => {
                scroller.current
                    ?.querySelectorAll<HTMLButtonElement>('.emoji-grid button')
                    [Math.min(focusIndex, matches.length - 1)]?.focus();
            });
    };
    useEffect(() => {
        const outside = (event: Event) => {
            if (
                !panel.current?.contains(event.target as Node) &&
                !trigger.current?.contains(event.target as Node)
            )
                closeRef.current();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeRef.current(true);
            }
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('focusin', outside);
        document.addEventListener('keydown', escape, true);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('focusin', outside);
            document.removeEventListener('keydown', escape, true);
        };
    }, [trigger]);
    return (
        <div
            ref={panel}
            className="emoji-picker"
            role="dialog"
            aria-label="Emoji picker"
        >
            <div className="emoji-search">
                <Icon name="search" size={18} />
                <input
                    aria-label="Search emojis"
                    placeholder="Find an emoji…"
                    value={search}
                    autoFocus
                    onChange={(event) => {
                        setSearch(event.target.value);
                        setCategory('all');
                        resetScroll();
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            panel.current
                                ?.querySelector<HTMLButtonElement>(
                                    '.emoji-grid button'
                                )
                                ?.focus();
                        } else if (event.key === 'Enter' && matches[0]) {
                            event.preventDefault();
                            choose(matches[0].emoji);
                        }
                    }}
                />
                <button
                    className="icon-button"
                    aria-label="Close emoji picker"
                    onClick={() => close(true)}
                >
                    <Icon name="close" size={18} />
                </button>
            </div>
            <div
                className="emoji-categories"
                role="tablist"
                aria-label="Emoji categories"
                onKeyDown={(event) => {
                    const buttons = [
                        ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                            '[role="tab"]'
                        ),
                    ];
                    const current = buttons.indexOf(
                        event.target as HTMLButtonElement
                    );
                    if (current < 0) return;
                    const next =
                        event.key === 'ArrowRight'
                            ? (current + 1) % tabs.length
                            : event.key === 'ArrowLeft'
                              ? (current + tabs.length - 1) % tabs.length
                              : event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? tabs.length - 1
                                  : -1;
                    if (next < 0) return;
                    event.preventDefault();
                    selectCategory(tabs[next][0]);
                    buttons[next].focus();
                    buttons[next].scrollIntoView({
                        block: 'nearest',
                        inline: 'nearest',
                    });
                }}
            >
                {tabs.map(([key, name]) => (
                    <button
                        key={key}
                        role="tab"
                        id={`${id}-${key}`}
                        aria-controls={`${id}-results`}
                        aria-label={name}
                        title={name}
                        aria-selected={category === key}
                        tabIndex={category === key ? 0 : -1}
                        onClick={() => selectCategory(key)}
                    >
                        {key === 'all' ? (
                            <Icon name="grid" size={19} />
                        ) : (
                            <span aria-hidden="true">
                                {categoryIcons[Number(key)]}
                            </span>
                        )}
                    </button>
                ))}
            </div>
            <div
                ref={scroller}
                className="emoji-results"
                role="tabpanel"
                id={`${id}-results`}
                aria-labelledby={`${id}-${category}`}
                onScroll={(event) => {
                    const { scrollTop, scrollHeight, clientHeight } =
                        event.currentTarget;
                    if (
                        hasMore &&
                        document.activeElement !== moreButton.current &&
                        scrollHeight - scrollTop - clientHeight < 100
                    )
                        revealMore();
                }}
                onKeyDown={(event) => {
                    const offsets: Record<string, number> = {
                        ArrowLeft: -1,
                        ArrowRight: 1,
                        ArrowUp: -6,
                        ArrowDown: 6,
                    };
                    if (!(event.key in offsets)) return;
                    const buttons = [
                        ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                            '.emoji-grid button'
                        ),
                    ];
                    const index = buttons.indexOf(
                        document.activeElement as HTMLButtonElement
                    );
                    if (index < 0) return;
                    event.preventDefault();
                    const next = index + offsets[event.key];
                    if (next >= buttons.length && hasMore) {
                        revealMore(next);
                        return;
                    }
                    buttons[
                        Math.max(0, Math.min(buttons.length - 1, next))
                    ]?.focus();
                }}
            >
                <div className="emoji-grid">
                    {matches
                        .slice(0, visibleCount)
                        .map(({ emoji, label, names }) => (
                            <button
                                key={emoji}
                                title={`${label} · :${names[0]}:`}
                                aria-label={`Insert :${names[0]}:`}
                                onClick={() => choose(emoji)}
                            >
                                {emoji}
                            </button>
                        ))}
                </div>
                {hasMore && (
                    <button
                        ref={moreButton}
                        className="emoji-more"
                        onClick={() => revealMore(visibleCount)}
                    >
                        Show more emojis
                    </button>
                )}
            </div>
            {matches.length === 0 && (
                <p className="emoji-empty" role="status">
                    No emojis found. Try another name.
                </p>
            )}
            <small className="emoji-picker-hint">
                <span role="status">
                    {matches.length.toLocaleString()} emoji
                </span>
                <span>
                    {category === 'all'
                        ? 'Type :smile:'
                        : tabs.find(([key]) => key === category)?.[1]}
                </span>
            </small>
        </div>
    );
}
