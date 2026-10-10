import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import {
    setParticipantVolume,
    useParticipantVolumes,
} from '../lib/participant-volume';

export function ParticipantVolume({ id, name }: { id: string; name: string }) {
    const volumes = useParticipantVolumes();
    const volume = volumes[id] ?? 100;
    const popupId = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    useLayoutEffect(() => {
        if (!open) return;
        const element = popup.current!;
        const win = element.ownerDocument.defaultView!;
        const position = () => {
            const box = trigger.current!.getBoundingClientRect();
            const width = element.offsetWidth;
            const height = element.offsetHeight;
            element.style.left = `${Math.max(8, Math.min(box.right - width, win.innerWidth - width - 8))}px`;
            element.style.top = `${Math.max(
                8,
                Math.min(
                    box.bottom + height + 8 <= win.innerHeight
                        ? box.bottom + 8
                        : box.top - height - 8,
                    win.innerHeight - height - 8
                )
            )}px`;
        };
        position();
        element.querySelector('input')?.focus({ preventScroll: true });
        win.addEventListener('resize', position);
        win.addEventListener('scroll', position, true);
        return () => {
            win.removeEventListener('resize', position);
            win.removeEventListener('scroll', position, true);
        };
    }, [open]);
    return (
        <span
            className={`participant-volume ${volume === 0 ? 'locally-muted' : ''}`}
        >
            <button
                ref={trigger}
                className="icon-button"
                aria-label={`Volume for ${name}`}
                title={`${name} · ${volume}% volume`}
                aria-expanded={open}
                popoverTarget={popupId}
            >
                <Icon name={volume === 0 ? 'volumeOff' : 'volume'} size={18} />
            </button>
            <div
                ref={popup}
                id={popupId}
                popover="auto"
                className="volume-popover"
                role="group"
                aria-label={`${name}'s audio`}
                onToggle={(event) => setOpen(event.newState === 'open')}
            >
                <div className="volume-heading">
                    <strong>{name}</strong>
                    <output htmlFor={`${popupId}-slider`}>{volume}%</output>
                </div>
                <input
                    id={`${popupId}-slider`}
                    type="range"
                    aria-label={`${name} volume`}
                    aria-valuetext={
                        volume === 0 ? 'Muted for you' : `${volume}%`
                    }
                    min="0"
                    max="100"
                    step="1"
                    value={volume}
                    onChange={(event) =>
                        setParticipantVolume(id, Number(event.target.value))
                    }
                />
                <div className="volume-caption">
                    <span>
                        {volume === 0
                            ? 'Muted for you'
                            : 'Only changes what you hear'}
                    </span>
                    <button
                        className="text-button"
                        disabled={volume === 100}
                        onClick={() => setParticipantVolume(id, 100)}
                    >
                        Reset
                    </button>
                </div>
            </div>
        </span>
    );
}
