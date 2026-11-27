// The tab icon, with a dot while there is something unread.
const icon = (dot: boolean) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<mask id="m"><rect width="32" height="32" fill="#fff"/>` +
    (dot ? `<circle cx="26" cy="6" r="9" fill="#000"/>` : '') +
    `</mask><g mask="url(#m)">` +
    `<rect width="32" height="32" rx="8" fill="#3d72d6"/>` +
    `<path d="M11 9h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-6l-4.5 3.5V21H11a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Z" fill="#fff"/>` +
    `</g>` +
    (dot ? `<circle cx="26" cy="6" r="6" fill="#e5484d"/>` : '') +
    `</svg>`;

export function setFavicon(dot: boolean) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/svg+xml';
        document.head.append(link);
    }
    const href = `data:image/svg+xml,${encodeURIComponent(icon(dot))}`;
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    link.dataset.unread = String(dot);
}
