export type Bundle = { dh: string; sign: string };
export type Identity = {
    dh: CryptoKeyPair;
    sign: CryptoKeyPair;
    bundle: Bundle;
    id: string;
    // Signal sessions for this identity; never stored with the identity keys.
    ratchet: import('./lib/signal').Ratchet;
};
export type SignedPrekey = { id: number; key: string; sig: string };
export type Prekey = { id: number; key: string };
export type PrekeyBundle = { spk: SignedPrekey; opk?: Prekey };
export type Prekeys = { spk: SignedPrekey; opks: Prekey[] };
// The author's own copy of a message key, sealed with a key kept in this browser.
export type SelfKey = { iv: string; data: string };
// A Double Ratchet message carrying a message key to one recipient.
export type RatchetKey = {
    dh: string;
    pn: number;
    n: number;
    data: string;
    // X3DH values, sent until the recipient first replies.
    pre?: { ek: string; spk: number; opk?: number };
};
export type Recipient = { id: string; bundle: Bundle };
export type Peer = Recipient & {
    name: string;
    online: boolean;
    call: string | null;
};
export type Envelope = {
    v: number;
    boot: string;
    id: string;
    from: string;
    scope: string;
    type: 'chat' | 'signal' | 'typing' | 'edit' | 'delete' | 'share';
    targets?: string[];
    revision?: string;
    parts?: number;
    time: number;
    iv: string;
    data: string;
    keys: Record<string, SelfKey | RatchetKey>;
    sig: string;
};
export type Content =
    | { kind: 'text'; text: string }
    | { kind: 'voice'; audio: string; mime: string; duration: number }
    | {
          kind: 'file';
          name: string;
          mime: string;
          size: number;
          // SHA-256 of each plaintext part; the bytes arrive separately.
          hashes: string[];
      };
export type Message = {
    id: string;
    from: string;
    name: string;
    scope: string;
    time: number;
    payload: Content;
    status: 'sending' | 'sent' | 'failed';
    envelope: Envelope;
    audience: string[];
    edited?: boolean;
    sharedBy?: string;
    historyGrant?: Envelope;
    // File bytes stay in memory only. Progress is set while parts transfer.
    bytes?: Uint8Array<ArrayBuffer>;
    progress?: number;
    unavailable?: boolean;
};
export type Presence = {
    id: string;
    userId: string;
    name: string;
    action: 'joined' | 'left';
    time: number;
};
export type SessionConfig = {
    boot: string;
    maxClients: number;
    expires: number;
    protocol?: number;
    // The public address, for invite links opened from localhost.
    origin?: string;
};
export type MediaKind = 'mic' | 'camera' | 'screen' | 'system';
export type MediaState = {
    muted: boolean;
    deafened: boolean;
    camera: boolean;
    screen: boolean;
    screenAudio: boolean;
};
export type CallState = MediaState & {
    noiseReduction: import('./lib/audio-preferences').NoiseReduction;
    noisePending: boolean;
    screenAudioAvailable: boolean;
    scope: string;
    started: number;
    local: {
        mic: MediaStream | null;
        camera: MediaStream | null;
        screen: MediaStream | null;
    };
    peers: {
        id: string;
        state: Partial<MediaState>;
        status: RTCPeerConnectionState;
        streams: Partial<Record<MediaKind, MediaStream>>;
    }[];
};
// Media state travels end-to-end encrypted, like any other DM envelope.
export type Signal = { call: string; media?: MediaState };
// The SFU forwards DAVE-encrypted frames; MLS gives each epoch its keys.
export type MediaRequest =
    | { action: 'setup' }
    | { action: 'transport'; direction: 'send' | 'recv' }
    | { action: 'connect'; transport: string; dtlsParameters: unknown }
    | { action: 'restart'; transport: string }
    | {
          action: 'produce';
          transport: string;
          source: MediaKind;
          kind: 'audio' | 'video';
          rtpParameters: unknown;
      }
    | { action: 'close'; producer: string }
    | { action: 'consume'; producer: string; rtpCapabilities: unknown }
    | { action: 'resume'; consumer: string };
export type MlsClientPacket =
    | {
          type: 'mls';
          scope: string;
          action: 'key-package';
          version: string;
          keyPackage: string;
      }
    | {
          type: 'mls';
          scope: string;
          action: 'commit';
          offer: number;
          added: string[];
          commit?: string;
          welcome?: string;
      };
export type MlsServerPacket =
    | { type: 'mls'; scope: string; action: 'create'; group: string }
    | { type: 'mls'; scope: string; action: 'welcome'; welcome: string }
    | { type: 'mls'; scope: string; action: 'commit'; commit: string }
    | {
          type: 'mls';
          scope: string;
          action: 'sync';
          offer: number;
          add: { id: string; version: string; keyPackage: string }[];
          remove: string[];
      }
    | {
          type: 'mls';
          scope: string;
          action: 'committed' | 'rejected';
          offer: number;
      }
    | { type: 'mls'; scope: string; action: 'reset' };
export type MediaEvent =
    | {
          type: 'producer';
          scope: string;
          producer: string;
          member: string;
          source: MediaKind;
      }
    | { type: 'producer-closed'; scope: string; producer: string };
export type ChatState = {
    phase: 'loading' | 'login' | 'joining' | 'online' | 'reconnecting';
    name: string;
    self: string | null;
    peers: Peer[];
    messages: Message[];
    presence: Presence[];
    scope: string;
    error: string;
    notice: string;
    typing: Record<string, number>;
    unread: Record<string, number>;
    config: SessionConfig | null;
    call: CallState | null;
};
export type ServerPacket =
    | { type: 'challenge'; boot: string; nonce: string }
    | { type: 'ready'; boot: string; peers: Peer[] }
    | { type: 'peers'; peers: Peer[] }
    | { type: 'presence'; event: Presence }
    | { type: 'cleared'; id: string; scope: string; by: string }
    | { type: 'access'; id: string; grant: Envelope }
    | { type: 'history-end' }
    | { type: 'ack'; id: string; deleted?: boolean }
    | { type: 'progress'; id: string; parts: number }
    | { type: 'error'; id: string; message: string }
    | { type: 'media'; request: number; data?: unknown; error?: string }
    | { type: 'bundle'; request: number; bundle?: PrekeyBundle; error?: string }
    | { type: 'prekeys'; remaining: number }
    | MlsServerPacket
    | MediaEvent
    | {
          type: 'message';
          envelope: Envelope;
          received: number;
          grants?: Envelope[];
          source?: { envelope: Envelope; received: number };
      };
export type ClientPacket =
    | {
          type: 'join';
          id: string;
          bundle: Bundle;
          name: string;
          sig: string;
          prekeys: Prekeys;
      }
    | { type: 'bundle'; request: number; id: string }
    | ({ type: 'prekeys' } & Prekeys)
    | { type: 'call'; scope: string | null }
    | { type: 'clear'; id: string; scope: string }
    | { type: 'fetch'; id: string }
    | ({ type: 'media'; request: number } & MediaRequest)
    | MlsClientPacket
    | { type: 'envelope'; envelope: Envelope };
