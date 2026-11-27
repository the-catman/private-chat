import type React from 'react';
import { Icon } from '../Icon';
import type { Peer } from '../types';

// What others see. Invisible people appear offline to everyone else.
export type Shown = 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';
export const statusLabels: Record<Shown, string> = {
    online: 'Online',
    idle: 'Idle',
    dnd: 'Do not disturb',
    offline: 'Offline',
    invisible: 'Invisible',
};
export function shownStatus(peer: Peer | undefined, self: string): Shown {
    if (!peer?.online) return 'offline';
    if (peer.status === 'invisible')
        return peer.id === self ? 'invisible' : 'offline';
    return peer.status;
}

const initials = (name: string) =>
    Array.from(name.trim()).slice(0, 2).join('').toUpperCase();
const colors = [
    '#6f9cf2',
    '#e0a045',
    '#4cb782',
    '#e5677d',
    '#a78bfa',
    '#3fb8c4',
];
// FNV-1a, so similar ids still spread across the palette.
export const color = (value: string) => {
    let hash = 0x811c9dc5;
    for (const c of value) hash = Math.imul(hash ^ c.charCodeAt(0), 0x01000193);
    return colors[(hash >>> 0) % colors.length];
};
export const minutes = (value: number) =>
    `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;

export function Avatar({
    name,
    id,
    status,
    image,
    size = '',
}: {
    name: string;
    id: string;
    status?: Shown;
    image?: string;
    size?: string;
}) {
    return (
        <span
            className={`avatar ${size} ${image ? 'has-image' : ''}`}
            style={{ '--avatar-color': color(id) } as React.CSSProperties}
        >
            {image ? (
                <img src={image} alt="" draggable={false} />
            ) : (
                initials(name)
            )}
            {status && <i className={`status-dot ${status}`} />}
        </span>
    );
}

export function IconButton({
    icon,
    label,
    active = false,
    danger = false,
    onClick,
    disabled = false,
    className = '',
}: {
    icon: string;
    label: string;
    active?: boolean;
    danger?: boolean;
    onClick: () => void;
    disabled?: boolean;
    className?: string;
}) {
    return (
        <button
            className={`icon-button ${active ? 'active' : ''} ${danger ? 'danger' : ''} ${className}`}
            aria-label={label}
            title={label}
            aria-pressed={active}
            onClick={onClick}
            disabled={disabled}
        >
            <Icon name={icon} />
        </button>
    );
}
