import {
    forwardRef,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
} from 'react';
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { liveMarkdown } from '../lib/live-markdown';

export type MessageInputHandle = {
    readonly element: HTMLElement | undefined;
    readonly value: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
    focus: (options?: FocusOptions) => void;
    setSelectionRange: (start: number, end: number) => void;
};
type Props = {
    value: string;
    label: string;
    placeholder?: string;
    disabled?: boolean;
    enterKeyHint?: 'enter' | 'send' | 'done';
    suggestions?: { controls: string; active: string };
    onChange: (value: string, cursor: number) => void;
    onSelect?: (cursor: number) => void;
    onKeyDown?: (event: KeyboardEvent) => void;
    onPaste?: (event: ClipboardEvent) => void;
    onLimit?: () => void;
};

// The document stays Markdown throughout. Only its presentation changes, so
// editing, emoji insertion, and encrypted message contents use the same offsets.
export const MessageInput = forwardRef<MessageInputHandle, Props>(
    function MessageInput(props, ref) {
        const host = useRef<HTMLDivElement>(null);
        const view = useRef<EditorView | null>(null);
        const current = useRef(props);
        current.current = props;
        const configuration = useRef(new Compartment());
        const attributes = () => [
            EditorState.readOnly.of(Boolean(current.current.disabled)),
            EditorView.editable.of(!current.current.disabled),
            EditorView.contentAttributes.of({
                role: 'textbox',
                'aria-multiline': 'true',
                'aria-label': current.current.label,
                'aria-disabled': String(Boolean(current.current.disabled)),
                'aria-autocomplete': 'list',
                ...(current.current.suggestions
                    ? {
                          'aria-controls': current.current.suggestions.controls,
                          'aria-activedescendant':
                              current.current.suggestions.active,
                      }
                    : {}),
                spellcheck: 'true',
                autocapitalize: 'sentences',
                enterkeyhint: current.current.enterKeyHint || 'enter',
            }),
            placeholder(current.current.placeholder || ''),
        ];
        useLayoutEffect(() => {
            const editor = new EditorView({
                parent: host.current!,
                doc: current.current.value,
                extensions: [
                    configuration.current.of(attributes()),
                    markdown({
                        base: markdownLanguage,
                        addKeymap: false,
                        completeHTMLTags: false,
                        pasteURLAsLink: false,
                    }),
                    liveMarkdown,
                    EditorView.lineWrapping,
                    history(),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    Prec.highest(
                        EditorView.domEventHandlers({
                            keydown(event) {
                                current.current.onKeyDown?.(event);
                                return event.defaultPrevented;
                            },
                            paste(event) {
                                current.current.onPaste?.(event);
                                return event.defaultPrevented;
                            },
                        })
                    ),
                    EditorState.transactionFilter.of((transaction) => {
                        if (
                            !transaction.docChanged ||
                            transaction.newDoc.length <=
                                Math.max(
                                    4000,
                                    transaction.startState.doc.length
                                )
                        )
                            return transaction;
                        current.current.onLimit?.();
                        return [];
                    }),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged)
                            current.current.onChange(
                                update.state.doc.toString(),
                                update.state.selection.main.head
                            );
                        else if (update.selectionSet)
                            current.current.onSelect?.(
                                update.state.selection.main.head
                            );
                    }),
                ],
            });
            view.current = editor;
            return () => {
                view.current = null;
                editor.destroy();
            };
        }, []);
        useImperativeHandle(
            ref,
            () => ({
                get element() {
                    return view.current?.contentDOM;
                },
                get value() {
                    return view.current?.state.doc.toString() || '';
                },
                get selectionStart() {
                    return view.current?.state.selection.main.from || 0;
                },
                get selectionEnd() {
                    return view.current?.state.selection.main.to || 0;
                },
                focus(options) {
                    view.current?.contentDOM.focus(options);
                },
                setSelectionRange(start, end) {
                    const editor = view.current;
                    if (editor)
                        editor.dispatch({
                            selection: {
                                anchor: Math.min(
                                    start,
                                    editor.state.doc.length
                                ),
                                head: Math.min(end, editor.state.doc.length),
                            },
                        });
                },
            }),
            []
        );
        useLayoutEffect(() => {
            const editor = view.current;
            if (!editor || editor.state.doc.toString() === props.value) return;
            // External changes are sending, draft restoration, or an emoji choice.
            editor.dispatch({
                changes: {
                    from: 0,
                    to: editor.state.doc.length,
                    insert: props.value,
                },
                selection: { anchor: props.value.length },
                annotations: Transaction.addToHistory.of(false),
                filter: false,
            });
        }, [props.value]);
        useLayoutEffect(() => {
            view.current?.dispatch({
                effects: configuration.current.reconfigure(attributes()),
            });
        }, [
            props.label,
            props.placeholder,
            props.disabled,
            props.enterKeyHint,
            props.suggestions?.controls,
            props.suggestions?.active,
        ]);
        return <div className="message-input" ref={host} />;
    }
);
