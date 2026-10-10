import type React from 'react';
import { Icon } from '../Icon';

const initials = (name: string) =>
    Array.from(name.trim()).slice(0, 2).join('').toUpperCase();
const colors = [
    '#55e2c2',
    '#b99aff',
    '#ffbe76',
    '#73baff',
    '#ff8fc7',
    '#ddd278',
];
export const color = (value: string) =>
    colors[
        Array.from(value).reduce((sum, c) => sum + c.charCodeAt(0), 0) %
            colors.length
    ];
export const minutes = (value: number) =>
    `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;

export function Avatar({
    name,
    id,
    online,
    size = '',
}: {
    name: string;
    id: string;
    online?: boolean;
    size?: string;
}) {
    return (
        <span
            className={`avatar ${size}`}
            style={{ '--avatar-color': color(id) } as React.CSSProperties}
        >
            {initials(name)}
            {online !== undefined && (
                <i className={online ? 'online-dot' : 'offline-dot'} />
            )}
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
