import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { types as ms } from 'mediasoup';
import type { Config } from './config';
import type {
    MediaKind,
    MediaRequest,
    MlsClientPacket,
    ServerPacket,
} from '../src/types';

// A selective forwarding unit: browsers send media to this server only, and
// it forwards DAVE frames it cannot decrypt. MLS keys never pass through here;
// the server only orders commits and delivers welcomes as the DAVE gateway.
type Seat = {
    id: string;
    send: (packet: ServerPacket) => void;
    transports: Map<string, ms.WebRtcTransport>;
    producers: Map<string, { producer: ms.Producer; source: MediaKind }>;
    consumers: Map<string, ms.Consumer>;
    version?: string;
    keyPackage?: string;
    refused?: string;
};
type Offer = {
    n: number;
    add: { id: string; version: string }[];
    remove: string[];
    timer: ReturnType<typeof setTimeout>;
};
type Group = {
    id: string;
    // Who the leader has put in the group, and with which key package.
    entries: Map<string, string>;
    leader: string;
    offer?: Offer;
};
type Call = {
    scope: string;
    router: Promise<ms.Router>;
    seats: Map<string, Seat>;
    group: Group | null;
    offers: number;
};

const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const encoded = (x: unknown, max: number): x is string =>
    typeof x === 'string' && x.length > 0 && x.length <= max && B64.test(x);
const plain = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x);
const SOURCES: Record<MediaKind, 'audio' | 'video'> = {
    mic: 'audio',
    camera: 'video',
    screen: 'video',
    system: 'audio',
};
const LEADER_MS = 10_000;

export class CallError extends Error {}

export function createCalls(
    config: Pick<
        Config,
        'origin' | 'maxClients' | 'mediaPort' | 'mediaListenIp' | 'mediaAddress'
    >
) {
    const calls = new Map<string, Call>();
    let media:
        Promise<{ worker: ms.Worker; server: ms.WebRtcServer }> | undefined;

    async function announced() {
        if (config.mediaAddress) return config.mediaAddress;
        const host = new URL(config.origin).hostname.replace(/^\[|\]$/g, '');
        if (isIP(host)) return host;
        const found = await lookup(host, { family: 4 })
            .catch(() => lookup(host))
            .catch(() => {
                throw new CallError(
                    'could not resolve APP_ORIGIN. Set MEDIA_ANNOUNCED_ADDRESS.'
                );
            });
        return found.address;
    }
    function start() {
        media ||= (async () => {
            const { createWorker } = await import('mediasoup');
            const address = await announced();
            const worker = await createWorker({ logLevel: 'error' });
            worker.on('died', () => {
                console.error('The media server stopped. Rejoin the call.');
                media = undefined;
                for (const call of calls.values())
                    for (const seat of call.seats.values()) leave(seat.id);
            });
            const listen = (protocol: 'udp' | 'tcp') => ({
                protocol,
                ip: config.mediaListenIp,
                announcedAddress: address,
                ...(config.mediaPort ? { port: config.mediaPort } : {}),
            });
            try {
                const server = await worker.createWebRtcServer({
                    listenInfos: [listen('udp'), listen('tcp')],
                });
                return { worker, server };
            } catch (error) {
                worker.close();
                throw error;
            }
        })().catch((error) => {
            media = undefined;
            console.error(
                `Calls are unavailable: ${error instanceof CallError ? error.message : `could not listen on media port ${config.mediaPort}.`}`
            );
            throw error;
        });
        return media;
    }

    function seatOf(id: string) {
        for (const call of calls.values()) {
            const seat = call.seats.get(id);
            if (seat) return { call, seat };
        }
        return null;
    }
    function others(call: Call, seat: Seat) {
        return Array.from(call.seats.values()).filter((s) => s !== seat);
    }

    function join(scope: string, id: string, send: Seat['send']) {
        leave(id);
        let call = calls.get(scope);
        if (!call) {
            const router = start().then(({ worker }) =>
                worker.createRouter({
                    mediaCodecs: [
                        {
                            kind: 'audio',
                            mimeType: 'audio/opus',
                            clockRate: 48000,
                            channels: 2,
                        },
                        {
                            kind: 'video',
                            mimeType: 'video/VP8',
                            clockRate: 90000,
                        },
                    ],
                })
            );
            router.catch(() => {});
            call = { scope, router, seats: new Map(), group: null, offers: 0 };
            calls.set(scope, call);
        }
        call.seats.set(id, {
            id,
            send,
            transports: new Map(),
            producers: new Map(),
            consumers: new Map(),
        });
    }

    function leave(id: string) {
        const found = seatOf(id);
        if (!found) return;
        const { call, seat } = found;
        call.seats.delete(id);
        for (const { producer } of seat.producers.values())
            closed(call, producer);
        for (const transport of seat.transports.values()) transport.close();
        if (call.seats.size) return settle(call);
        clearTimeout(call.group?.offer?.timer);
        calls.delete(call.scope);
        call.router.then((router) => router.close()).catch(() => {});
    }
    function closed(call: Call, producer: ms.Producer) {
        if (!producer.closed) producer.close();
        for (const seat of call.seats.values())
            seat.send({
                type: 'producer-closed',
                scope: call.scope,
                producer: producer.id,
            });
    }

    async function request(id: string, packet: MediaRequest) {
        const found = seatOf(id);
        if (!found) throw new CallError('Join the call first.');
        const { call, seat } = found;
        const router = await call.router.catch(() => {
            throw new CallError(
                'Calls are unavailable. The media server could not start.'
            );
        });
        const transport = (direction: 'send' | 'recv') => {
            const t = Array.from(seat.transports.values()).find(
                (t) => t.appData.direction === direction
            );
            if (!t) throw new CallError('Unknown transport.');
            return t;
        };
        switch (packet.action) {
            case 'setup':
                return {
                    rtpCapabilities: router.rtpCapabilities,
                    producers: others(call, seat).flatMap((s) =>
                        Array.from(s.producers.values(), (p) => ({
                            producer: p.producer.id,
                            member: s.id,
                            source: p.source,
                        }))
                    ),
                };
            case 'transport': {
                const direction = packet.direction;
                if (
                    !['send', 'recv'].includes(direction) ||
                    Array.from(seat.transports.values()).some(
                        (t) => t.appData.direction === direction
                    )
                )
                    throw new CallError('Invalid transport.');
                const { server } = await start();
                const t = await router.createWebRtcTransport({
                    webRtcServer: server,
                    enableUdp: true,
                    enableTcp: true,
                    preferUdp: true,
                    initialAvailableOutgoingBitrate: 1_000_000,
                    appData: { direction },
                });
                if (direction === 'send')
                    await t.setMaxIncomingBitrate(8_000_000);
                if (call.seats.get(id) !== seat) {
                    t.close();
                    throw new CallError('Join the call first.');
                }
                seat.transports.set(t.id, t);
                return {
                    id: t.id,
                    iceParameters: t.iceParameters,
                    iceCandidates: t.iceCandidates,
                    dtlsParameters: t.dtlsParameters,
                };
            }
            case 'connect': {
                const t = seat.transports.get(packet.transport);
                if (!t || !plain(packet.dtlsParameters))
                    throw new CallError('Unknown transport.');
                await t.connect({
                    dtlsParameters: packet.dtlsParameters as ms.DtlsParameters,
                });
                return {};
            }
            case 'restart': {
                const t = seat.transports.get(packet.transport);
                if (!t) throw new CallError('Unknown transport.');
                return { iceParameters: await t.restartIce() };
            }
            case 'produce': {
                const t = transport('send');
                if (t.id !== packet.transport)
                    throw new CallError('Unknown transport.');
                const source = packet.source;
                if (
                    !Object.hasOwn(SOURCES, source) ||
                    SOURCES[source] !== packet.kind ||
                    !plain(packet.rtpParameters) ||
                    Array.from(seat.producers.values()).some(
                        (p) => p.source === source
                    )
                )
                    throw new CallError('Invalid media.');
                const producer = await t.produce({
                    kind: packet.kind,
                    rtpParameters: packet.rtpParameters as ms.RtpParameters,
                });
                if (call.seats.get(id) !== seat) {
                    producer.close();
                    throw new CallError('Join the call first.');
                }
                seat.producers.set(producer.id, { producer, source });
                producer.on('transportclose', () =>
                    seat.producers.delete(producer.id)
                );
                for (const s of others(call, seat))
                    s.send({
                        type: 'producer',
                        scope: call.scope,
                        producer: producer.id,
                        member: id,
                        source,
                    });
                return { id: producer.id };
            }
            case 'close': {
                const p = seat.producers.get(packet.producer);
                if (!p) return {};
                seat.producers.delete(packet.producer);
                closed(call, p.producer);
                return {};
            }
            case 'consume': {
                const t = transport('recv');
                const owner = others(call, seat).find((s) =>
                    s.producers.has(packet.producer)
                );
                if (
                    !owner ||
                    !plain(packet.rtpCapabilities) ||
                    seat.consumers.size >= config.maxClients * 4 ||
                    !router.canConsume({
                        producerId: packet.producer,
                        rtpCapabilities:
                            packet.rtpCapabilities as ms.RtpCapabilities,
                    })
                )
                    throw new CallError('That media is no longer available.');
                const consumer = await t.consume({
                    producerId: packet.producer,
                    rtpCapabilities:
                        packet.rtpCapabilities as ms.RtpCapabilities,
                    paused: true,
                });
                seat.consumers.set(consumer.id, consumer);
                const forget = () => seat.consumers.delete(consumer.id);
                consumer.on('transportclose', forget);
                consumer.on('producerclose', forget);
                return {
                    id: consumer.id,
                    producerId: consumer.producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                };
            }
            case 'resume': {
                const consumer = seat.consumers.get(packet.consumer);
                if (!consumer) throw new CallError('Unknown media.');
                await consumer.resume();
                return {};
            }
        }
        throw new CallError('Invalid request.');
    }

    // Level-triggered: compare who should hold keys with who does, and ask the
    // leader for one commit at a time. The server sequences, never decrypts.
    function settle(call: Call) {
        let group = call.group;
        const valid = (id: string) =>
            Boolean(
                group?.entries.has(id) &&
                call.seats.get(id)?.version === group.entries.get(id)
            );
        if (group && !valid(group.leader)) {
            clearTimeout(group.offer?.timer);
            group.offer = undefined;
            const next = Array.from(group.entries.keys()).find(valid);
            if (next) group.leader = next;
            else call.group = group = null;
        }
        if (!group) {
            const first = Array.from(call.seats.values()).find(
                (seat) => seat.keyPackage
            );
            if (!first) return;
            group = call.group = {
                id: randomBytes(16).toString('base64url'),
                entries: new Map([[first.id, first.version!]]),
                leader: first.id,
            };
            first.keyPackage = undefined;
            first.send({
                type: 'mls',
                scope: call.scope,
                action: 'create',
                group: group.id,
            });
        }
        if (group.offer) return;
        const remove = Array.from(group.entries)
            .filter(([id, version]) => call.seats.get(id)?.version !== version)
            .map(([id]) => id);
        const add = Array.from(call.seats.values()).filter(
            (seat) => seat.keyPackage && seat.refused !== seat.version
        );
        if (!remove.length && !add.length) return;
        const n = ++call.offers;
        group.offer = {
            n,
            add: add.map((seat) => ({ id: seat.id, version: seat.version! })),
            remove,
            timer: setTimeout(() => stalled(call, n), LEADER_MS),
        };
        call.seats.get(group.leader)!.send({
            type: 'mls',
            scope: call.scope,
            action: 'sync',
            offer: n,
            add: add.map((seat) => ({
                id: seat.id,
                version: seat.version!,
                keyPackage: seat.keyPackage!,
            })),
            remove,
        });
    }
    // An unresponsive leader is reset and re-admitted like anyone else.
    function stalled(call: Call, n: number) {
        const group = call.group;
        if (calls.get(call.scope) !== call || group?.offer?.n !== n) return;
        group.offer = undefined;
        const leader = call.seats.get(group.leader);
        if (leader) {
            leader.version = leader.keyPackage = undefined;
            leader.send({ type: 'mls', scope: call.scope, action: 'reset' });
        }
        settle(call);
    }

    function mls(id: string, packet: MlsClientPacket) {
        const found = seatOf(id);
        if (!found || packet.scope !== found.call.scope) return;
        const { call, seat } = found;
        if (packet.action === 'key-package') {
            if (
                typeof packet.version !== 'string' ||
                !UUID.test(packet.version) ||
                !encoded(packet.keyPackage, 16_384)
            )
                throw new CallError('Invalid key package.');
            seat.version = packet.version;
            seat.keyPackage = packet.keyPackage;
            seat.refused = undefined;
            return settle(call);
        }
        if (packet.action !== 'commit') throw new CallError('Invalid request.');
        const group = call.group;
        const offer = group?.offer;
        const added = packet.added;
        const reject = () =>
            seat.send({
                type: 'mls',
                scope: call.scope,
                action: 'rejected',
                offer: Number(packet.offer) || 0,
            });
        if (
            !group ||
            !offer ||
            group.leader !== id ||
            packet.offer !== offer.n ||
            !Array.isArray(added) ||
            new Set(added).size !== added.length ||
            added.some((v) => !offer.add.some((a) => a.version === v))
        )
            return reject();
        const commit = packet.commit;
        if (
            commit === undefined
                ? added.length || offer.remove.length || packet.welcome
                : !encoded(commit, 65_536) ||
                  (added.length
                      ? !encoded(packet.welcome, 262_144)
                      : packet.welcome !== undefined)
        )
            return reject();
        clearTimeout(offer.timer);
        group.offer = undefined;
        for (const a of offer.add) {
            const s = call.seats.get(a.id);
            if (s?.version === a.version && !added.includes(a.version))
                s.refused = a.version;
        }
        if (commit !== undefined) {
            // Members still on this epoch apply the commit; arrivals get the welcome.
            for (const [member, version] of group.entries) {
                const s = call.seats.get(member);
                if (
                    member !== id &&
                    !offer.remove.includes(member) &&
                    s?.version === version
                )
                    s.send({
                        type: 'mls',
                        scope: call.scope,
                        action: 'commit',
                        commit,
                    });
            }
            for (const member of offer.remove) group.entries.delete(member);
            for (const a of offer.add) {
                if (!added.includes(a.version)) continue;
                group.entries.delete(a.id);
                group.entries.set(a.id, a.version);
                const s = call.seats.get(a.id);
                if (s?.version !== a.version) continue;
                s.keyPackage = undefined;
                s.send({
                    type: 'mls',
                    scope: call.scope,
                    action: 'welcome',
                    welcome: packet.welcome!,
                });
            }
            seat.send({
                type: 'mls',
                scope: call.scope,
                action: 'committed',
                offer: offer.n,
            });
        }
        settle(call);
    }

    return {
        join,
        leave,
        request,
        mls,
        // Test-only: raw RTP as the SFU sees it, to prove frames are encrypted.
        async inspect(scope: string, duration = 1500) {
            const call = calls.get(scope);
            if (!call) return [];
            const router = await call.router;
            const tap = await router.createDirectTransport();
            const packets: { source: MediaKind; packet: Buffer }[] = [];
            for (const seat of call.seats.values())
                for (const { producer, source } of seat.producers.values()) {
                    const consumer = await tap.consume({
                        producerId: producer.id,
                        rtpCapabilities: router.rtpCapabilities,
                    });
                    consumer.on('rtp', (packet) => {
                        if (packets.length < 2000)
                            packets.push({ source, packet });
                    });
                }
            await new Promise((resolve) => setTimeout(resolve, duration));
            tap.close();
            return packets;
        },
        async close() {
            for (const call of calls.values())
                for (const seat of call.seats.values()) leave(seat.id);
            const running = await media?.catch(() => undefined);
            media = undefined;
            running?.worker.close();
        },
    };
}
