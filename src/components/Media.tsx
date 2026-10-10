import React, { useEffect, useRef, useState } from 'react';

export function Media({
    stream,
    audio = false,
    muted = false,
    volume = 1,
    className = '',
}: {
    stream?: MediaStream | null;
    audio?: boolean;
    muted?: boolean;
    volume?: number;
    className?: string;
}) {
    const ref = useRef<HTMLMediaElement>(null);
    const [blocked, setBlocked] = useState(false);
    useEffect(() => {
        if (ref.current) ref.current.volume = Math.max(0, Math.min(1, volume));
    }, [stream, volume]);
    useEffect(() => {
        const element = ref.current;
        if (!element || !stream) return;
        element.srcObject = stream;
        void element.play().catch(() => setBlocked(true));
        return () => {
            element.srcObject = null;
        };
    }, [stream]);
    if (!stream) return null;
    return (
        <>
            {audio ? (
                <audio
                    ref={ref as React.RefObject<HTMLAudioElement>}
                    autoPlay
                    muted={muted}
                />
            ) : (
                <video
                    ref={ref as React.RefObject<HTMLVideoElement>}
                    className={className}
                    autoPlay
                    playsInline
                    muted={muted}
                />
            )}
            {blocked && (
                <button
                    className="enable-audio"
                    onClick={() => {
                        void ref.current?.play().then(() => setBlocked(false));
                    }}
                >
                    Enable {audio ? 'sound' : 'video'}
                </button>
            )}
        </>
    );
}
