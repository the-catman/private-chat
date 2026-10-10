export type Bundle = { dh: string; sign: string };
export type Identity = {
    dh: CryptoKeyPair;
    sign: CryptoKeyPair;
    bundle: Bundle;
    id: string;
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
    time: number;
    iv: string;
    data: string;
    keys: Record<string, { iv: string; data: string }>;
    sig: string;
};
export type Content =
    | { kind: 'text'; text: string }
    | { kind: 'voice'; audio: string; mime: string; duration: number }
    | { kind: 'file'; data: string; name: string; mime: string; size: number };
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
    iceServers: RTCIceServer[];
    relayOnly: boolean;
    hasTurn: boolean;
    expires: number;
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
export type Signal = {
    call: string;
    description?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    media?: MediaState;
};
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
    | { type: 'error'; id: string; message: string }
    | {
          type: 'message';
          envelope: Envelope;
          received: number;
          grants?: Envelope[];
          source?: { envelope: Envelope; received: number };
      };
export type ClientPacket =
    | { type: 'join'; id: string; bundle: Bundle; name: string; sig: string }
    | { type: 'call'; scope: string | null }
    | { type: 'clear'; id: string; scope: string }
    | { type: 'envelope'; envelope: Envelope };
