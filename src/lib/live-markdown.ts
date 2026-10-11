import { StateField, type Range } from '@codemirror/state';
import {
    Decoration,
    EditorView,
    keymap,
    type DecorationSet,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { deleteCharBackward, deleteCharForward } from '@codemirror/commands';

const tags: Record<string, string> = {
    StrongEmphasis: 'strong',
    Emphasis: 'em',
    Strikethrough: 'del',
    InlineCode: 'code',
};

// Style the editable text itself. Completed inline delimiters are hidden;
// incomplete Markdown remains ordinary editable text. No HTML or URLs execute.
const formatting = StateField.define<{
    decorations: DecorationSet;
    hidden: DecorationSet;
}>({
    create: (state) => decorate(state),
    update(value, transaction) {
        return transaction.docChanged ||
            syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
            ? decorate(transaction.state)
            : value;
    },
    provide: (field) => [
        EditorView.decorations.from(field, (value) => value.decorations),
        EditorView.atomicRanges.of((view) => view.state.field(field).hidden),
    ],
});

function decorate(state: import('@codemirror/state').EditorState) {
    const ranges: Range<Decoration>[] = [];
    const hidden: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
        enter({ node }) {
            const tag = tags[node.name];
            if (tag) {
                ranges.push(
                    Decoration.mark({ tagName: tag }).range(node.from, node.to)
                );
                for (
                    let child = node.firstChild;
                    child;
                    child = child.nextSibling
                ) {
                    if (
                        [
                            'EmphasisMark',
                            'StrikethroughMark',
                            'CodeMark',
                        ].includes(child.name)
                    ) {
                        const range = Decoration.replace({}).range(
                            child.from,
                            child.to
                        );
                        ranges.push(range);
                        hidden.push(range);
                    }
                }
                if (node.name === 'InlineCode') return false;
            }
            if (node.name === 'Link')
                ranges.push(
                    Decoration.mark({ class: 'input-link' }).range(
                        node.from,
                        node.to
                    )
                );
            if (/^ATXHeading\d$/.test(node.name))
                ranges.push(
                    Decoration.line({ class: 'input-heading' }).range(node.from)
                );
            if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
                const first = state.doc.lineAt(node.from).number;
                const last = state.doc.lineAt(node.to).number;
                for (let line = first; line <= last; line++)
                    ranges.push(
                        Decoration.line({ class: 'input-code-line' }).range(
                            state.doc.line(line).from
                        )
                    );
                return false;
            }
        },
    });
    return {
        decorations: Decoration.set(ranges, true),
        hidden: Decoration.set(hidden, true),
    };
}

function deleteFormatted(view: EditorView, backward: boolean) {
    const selection = view.state.selection.main;
    if (!selection.empty || view.state.readOnly) return false;
    const position = selection.head;
    for (
        let node = syntaxTree(view.state).resolveInner(
            position,
            backward ? -1 : 1
        );
        node.parent;
        node = node.parent
    ) {
        if (!tags[node.name]) continue;
        const first = node.firstChild;
        const last = node.lastChild;
        if (!first || !last || first === last) continue;
        const content = view.state.sliceDoc(first.to, last.from);
        const singleCharacter =
            [
                ...new Intl.Segmenter(undefined, {
                    granularity: 'grapheme',
                }).segment(content),
            ].length === 1;
        if (
            singleCharacter &&
            (backward
                ? position === node.to || position === last.from
                : position === node.from || position === first.to)
        ) {
            view.dispatch({
                changes: { from: node.from, to: node.to },
                selection: { anchor: node.from },
                userEvent: 'delete',
            });
            return true;
        }
        if (backward ? position !== node.to : position !== node.from)
            return false;
        // Delete visible text instead of an invisible closing/opening delimiter.
        view.dispatch({
            selection: { anchor: backward ? last.from : first.to },
        });
        return backward ? deleteCharBackward(view) : deleteCharForward(view);
    }
    return false;
}

export const liveMarkdown = [
    formatting,
    keymap.of([
        { key: 'Backspace', run: (view) => deleteFormatted(view, true) },
        { key: 'Delete', run: (view) => deleteFormatted(view, false) },
    ]),
];
