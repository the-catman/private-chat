// Encrypts every outgoing frame and decrypts every incoming one. A frame that
// has no key or fails authentication is dropped; nothing passes in the clear.
import {
    clearRanges,
    decryptFrame,
    encryptFrame,
    generation,
    parseFrame,
    ReplayWindow,
} from './dave-frame.ts';

type Frame = { data: ArrayBuffer };
type Transformer = {
    readable: ReadableStream<Frame>;
    writable: WritableStream<Frame>;
    options: {
        operation: 'encrypt' | 'decrypt';
        kind: 'audio' | 'video';
        sender?: string;
    };
};
type KeySet = {
    id: number;
    keys: Map<string, Map<number, CryptoKey>>;
    retired?: number;
};
export type WorkerMessage =
    | {
          type: 'keys';
          set: number;
          self: string;
          keys: [string, CryptoKey][];
          delay: number;
      }
    | {
          type: 'key';
          set: number;
          member: string;
          generation: number;
          key: CryptoKey;
      }
    // Sending pauses for key sets older than this one.
    | { type: 'hold'; from: number };
export type WorkerRequest = {
    type: 'need';
    set: number;
    member: string;
    generation: number;
};

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
    onrtctransform: ((event: { transformer: Transformer }) => void) | null;
    postMessage: (message: WorkerRequest) => void;
};
const GRACE_MS = 10_000;
let sets: KeySet[] = [];
let sending: KeySet | null = null;
let me = '';
let nonce = 0;
let sendFrom = 0;
const requested = new Set<string>();
// One replay window per sender and key set, shared by all of that sender's
// streams. A stream the server announces again cannot replay old frames.
const windows = new Map<string, ReplayWindow>();

// Later generations of a sender's ratchet are derived on the main thread.
function key(set: KeySet, member: string, gen: number) {
    const ratchet = set.keys.get(member);
    const found = ratchet?.get(gen);
    const tag = `${set.id}:${member}:${gen}`;
    if (ratchet && !found && !requested.has(tag)) {
        requested.add(tag);
        scope.postMessage({
            type: 'need',
            set: set.id,
            member,
            generation: gen,
        });
    }
    return found;
}

scope.onmessage = ({ data }) => {
    if (data.type === 'key') {
        sets.find((set) => set.id === data.set)
            ?.keys.get(data.member)
            ?.set(data.generation, data.key);
        return;
    }
    if (data.type === 'hold') {
        sendFrom = data.from;
        return;
    }
    const now = Date.now();
    const set: KeySet = {
        id: data.set,
        keys: new Map(
            data.keys.map(([member, k]) => [member, new Map([[0, k]])])
        ),
    };
    for (const old of sets) old.retired ??= now;
    sets = [
        ...sets.filter(
            (old) => old === sending || now - old.retired! < GRACE_MS
        ),
        set,
    ].slice(-4);
    for (const tag of windows.keys())
        if (!sets.some((s) => tag.startsWith(`${s.id}:`))) windows.delete(tag);
    me = data.self;
    // Receivers install keys first; senders switch a moment later.
    const use = () => {
        if (sets.includes(set) && (!sending || sending.id < set.id)) {
            sending = set;
            nonce = 0;
        }
    };
    if (data.delay) setTimeout(use, data.delay);
    else use();
};

scope.onrtctransform = ({ transformer }) => {
    const { kind, operation, sender } = transformer.options;
    const encrypt = async (
        frame: Frame,
        controller: TransformStreamDefaultController<Frame>
    ) => {
        const set = sending;
        if (!set || set.id < sendFrom || nonce > 0xffffffff) return;
        const n = nonce++;
        const k = key(set, me, generation(n));
        if (!k) return;
        const data = new Uint8Array(frame.data);
        frame.data = (await encryptFrame(k, n, data, clearRanges(kind, data)))
            .buffer as ArrayBuffer;
        controller.enqueue(frame);
    };
    const decrypt = async (
        frame: Frame,
        controller: TransformStreamDefaultController<Frame>
    ) => {
        const parsed = parseFrame(new Uint8Array(frame.data));
        if (!parsed || !sender) return;
        const now = Date.now();
        for (const set of [...sets].reverse()) {
            if (set.retired && now - set.retired > GRACE_MS) continue;
            const k = key(set, sender, generation(parsed.nonce));
            const plain = k && (await decryptFrame(k, parsed));
            if (!plain) continue;
            const tag = `${set.id}:${sender}`;
            let window = windows.get(tag);
            if (!window) windows.set(tag, (window = new ReplayWindow()));
            if (!window.accept(parsed.nonce)) return;
            frame.data = plain.buffer as ArrayBuffer;
            controller.enqueue(frame);
            return;
        }
    };
    transformer.readable
        .pipeThrough(
            new TransformStream<Frame, Frame>({
                transform: operation === 'encrypt' ? encrypt : decrypt,
            })
        )
        .pipeTo(transformer.writable)
        .catch(() => {});
};
