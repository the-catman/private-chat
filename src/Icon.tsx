import type { CSSProperties } from 'react';

const paths: Record<string, React.ReactNode> = {
    markdown: (
        <>
            <rect x="2" y="5" width="20" height="14" rx="3" />
            <path d="M5 15V9l3 3 3-3v6m6-6v6m-2-2 2 2 2-2" />
        </>
    ),
    more: (
        <>
            <circle cx="5" cy="12" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
        </>
    ),
    edit: (
        <>
            <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" />
        </>
    ),
    share: (
        <>
            <path d="M12 16V3m-5 5 5-5 5 5M5 13v8h14v-8" />
        </>
    ),
    file: (
        <>
            <path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 13h8m-8 4h6" />
        </>
    ),
    attach: (
        <path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2m3 7-9 9a1 1 0 0 1-2-2l9-9" />
    ),
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />,
    sun: (
        <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
        </>
    ),
    moon: <path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z" />,
    wave: (
        <>
            <path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4" />
        </>
    ),
    hash: (
        <>
            <path d="m10 3-4 18M18 3l-4 18M4 9h17M2 15h17" />
        </>
    ),
    lock: (
        <>
            <rect x="5" y="10" width="14" height="11" rx="3" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
        </>
    ),
    shield: (
        <>
            <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
            <path d="m8 12 3 3 5-6" />
        </>
    ),
    mic: (
        <>
            <rect x="9" y="2" width="6" height="13" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
        </>
    ),
    micOff: (
        <>
            <path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v5M5 10v2a7 7 0 0 0 11 5m3-7v2a7 7 0 0 1-.5 2.5M12 19v3m-4 0h8" />
        </>
    ),
    video: (
        <>
            <rect x="3" y="5" width="12" height="14" rx="3" />
            <path d="m15 9 6-3v12l-6-3" />
        </>
    ),
    screen: (
        <>
            <rect x="2" y="3" width="20" height="14" rx="3" />
            <path d="M12 17v4m-5 0h10m-5-8V7m-3 3 3-3 3 3" />
        </>
    ),
    headphones: (
        <>
            <path d="M3 14v-3a9 9 0 0 1 18 0v3" />
            <rect x="2" y="12" width="5" height="9" rx="2" />
            <rect x="17" y="12" width="5" height="9" rx="2" />
        </>
    ),
    phone: (
        <path d="M21 16.5v3a2 2 0 0 1-2.2 2 18.9 18.9 0 0 1-8.2-2.9 18.5 18.5 0 0 1-5.7-5.7 18.9 18.9 0 0 1-2.9-8.2A2 2 0 0 1 4 2.5h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.4 2.1L8 10.4a15 15 0 0 0 5.6 5.6l1.3-1.2a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.2 1.5Z" />
    ),
    hangup: (
        <path d="M3 17v-5c5-5 13-5 18 0v5l-5-1v-4a15 15 0 0 0-8 0v4l-5 1Z" />
    ),
    send: (
        <>
            <path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15" />
        </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    smile: (
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M8 14s1 3 4 3 4-3 4-3M8 8h.01M16 8h.01" />
        </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
    checkDouble: (
        <>
            <path d="m2 12 4 4L16 6m-5 10 10-10" />
        </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    chevron: <path d="m8 5 7 7-7 7" />,
    copy: (
        <>
            <rect x="8" y="8" width="13" height="13" rx="3" />
            <path d="M16 8V3H3v13h5" />
        </>
    ),
    people: (
        <>
            <circle cx="9" cy="8" r="4" />
            <path d="M2 21v-3a7 7 0 0 1 14 0v3m1-17a4 4 0 0 1 0 8m2 3a6 6 0 0 1 3 5" />
        </>
    ),
    settings: (
        <>
            <circle cx="12" cy="12" r="3" />
            <path d="M9.5 3h5l.6 2.4 1.3.8 2.4-.7 2.5 4.3-1.8 1.7v1.5l1.8 1.7-2.5 4.3-2.4-.7-1.3.8-.6 2.4h-5l-.6-2.4-1.3-.8-2.4.7-2.5-4.3 1.8-1.7v-1.5L2.7 9.8l2.5-4.3 2.4.7 1.3-.8L9.5 3Z" />
        </>
    ),
    logout: (
        <>
            <path d="M9 3H3v18h6m5-4 5-5-5-5m-6 5h13" />
        </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    search: (
        <>
            <circle cx="10" cy="10" r="6" />
            <path d="m15 15 6 6" />
        </>
    ),
    volume: (
        <>
            <path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
        </>
    ),
    globe: (
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18" />
        </>
    ),
    info: (
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6m0-10h.01" />
        </>
    ),
    clock: (
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6l4 2" />
        </>
    ),
    trash: (
        <>
            <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M9 10v7m6-7v7" />
        </>
    ),
    stop: <rect x="5" y="5" width="14" height="14" rx="3" />,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    shrink: <path d="M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5" />,
    popout: (
        <>
            <path d="M14 3h7v7m0-7-9 9M10 3H3v18h18v-7" />
        </>
    ),
    grid: (
        <>
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
        </>
    ),
    volumeOff: <path d="m11 4-6 5H2v6h3l6 5V4Zm5 5 6 6m0-6-6 6" />,
    sliders: (
        <>
            <path d="M4 6h5m4 0h7M4 18h9m4 0h3M9 3v6m4 6v6" />
            <circle cx="11" cy="6" r="2" />
            <circle cx="15" cy="18" r="2" />
        </>
    ),
    at: (
        <>
            <circle cx="12" cy="12" r="4" />
            <path d="M16 8v7c0 4 6 1 6-3a10 10 0 1 0-5 9" />
        </>
    ),
};

export function Icon({
    name,
    size = 20,
    style,
}: {
    name: string;
    size?: number;
    style?: CSSProperties;
}) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={style}
        >
            {paths[name] || paths.info}
        </svg>
    );
}
