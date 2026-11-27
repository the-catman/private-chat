// Code is shown literally, so links and mentions inside it are ignored.
export const withoutCode = (text: string) =>
    text
        .replace(
            /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*|$)/gm,
            ' '
        )
        .replace(/`[^`\n]*`/g, ' ');

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "@Name" for any of these names, longest first so "@Ann Lee" wins over
// "@Ann". The first group is what precedes the @.
export function mentionPattern(names: string[]) {
    const unique = [...new Set(names.filter(Boolean))].sort(
        (a, b) => b.length - a.length
    );
    if (!unique.length) return null;
    return new RegExp(
        `(^|[^\\p{L}\\p{N}_@])@(${unique.map(escape).join('|')})(?![\\p{L}\\p{N}_])`,
        'giu'
    );
}

export const mentions = (text: string, name: string) =>
    Boolean(name) && mentionPattern([name])!.test(withoutCode(text));

// The "@partial" being typed just before the cursor, if any.
export function mentionQuery(text: string, cursor: number, names: string[]) {
    const typed = /(^|[\s(])@([^\s@]{0,32})$/u.exec(text.slice(0, cursor));
    if (!typed) return null;
    const query = typed[2]!.toLowerCase();
    const results = [
        ...names.filter((name) => name.toLowerCase().startsWith(query)),
        ...names.filter(
            (name) =>
                !name.toLowerCase().startsWith(query) &&
                name.toLowerCase().includes(query)
        ),
    ].slice(0, 8);
    return results.length
        ? { start: cursor - typed[2]!.length - 1, end: cursor, results }
        : null;
}
