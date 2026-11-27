import {
    createCommit,
    createGroup,
    decodeMlsMessage,
    defaultCapabilities,
    defaultLifetime,
    emptyPskIndex,
    encodeMlsMessage,
    generateKeyPackageWithKey,
    getCiphersuiteFromName,
    getCiphersuiteImpl,
    joinGroup,
    mlsExporter,
    processMessage,
    type CiphersuiteImpl,
    type ClientConfig,
    type ClientState,
    type Credential,
    type IncomingMessageCallback,
    type KeyPackage,
    type PrivateKeyPackage,
    type Proposal,
} from 'ts-mls';
import { defaultClientConfig } from 'ts-mls/clientConfig.js';
import { deriveTreeSecret } from 'ts-mls/crypto/kdf.js';
import { toLeafIndex } from 'ts-mls/treemath.js';
import type {
    Bundle,
    Identity,
    MlsClientPacket,
    MlsServerPacket,
} from '../types';
import { b64, identityId, sign, unb64, verify } from './crypto.ts';

// DAVE for Hush: the server is only the MLS delivery service. Every leaf's
// signature key is signed by its Hush identity for this call, so the server
// cannot add anyone to a call or read a single media frame.
const SUITE = 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256';
const LABEL = 'Hush Secure Frames v0';
const ID = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
// Wait this long to be admitted before asking again.
const ADMIT_MS = 12_000;
let suite: Promise<CiphersuiteImpl> | undefined;
// A failed chunk load must not break every later call on this page.
const cipherSuite = () =>
    (suite ||= getCiphersuiteImpl(getCiphersuiteFromName(SUITE)).catch(
        (error) => {
            suite = undefined;
            throw error;
        }
    ));

export const attestation = (boot: string, scope: string, key: Uint8Array) =>
    JSON.stringify(['hush-call-v1', boot, scope, b64(key)]);
export function credentialId(credential: Credential) {
    if (credential.credentialType !== 'basic') return null;
    try {
        const [id, sig, ...rest] = dec.decode(credential.identity).split('.');
        return ID.test(id) && sig && !rest.length ? { id, sig } : null;
    } catch {
        return null;
    }
}

// The per-sender hash ratchet. The generation is the nonce's top byte.
export async function ratchetKey(base: Uint8Array, generation: number) {
    const { kdf } = await cipherSuite();
    let secret = base;
    for (let g = 0; g < generation; g++)
        secret = await deriveTreeSecret(secret, 'secret', g, kdf.size, kdf);
    const raw = await deriveTreeSecret(secret, 'key', generation, 16, kdf);
    return crypto.subtle.importKey(
        'raw',
        new Uint8Array(raw),
        'AES-GCM',
        false,
        ['encrypt', 'decrypt']
    );
}

// People who still hold this call's keys but no longer show in the call. The
// server could keep someone who hung up in the group, so every member checks.
export const lingering = (
    keyed: Iterable<string>,
    members: { id: string; online: boolean; call: string | null }[],
    self: string,
    scope: string
) =>
    [...keyed].filter(
        (id) =>
            id !== self &&
            !members.some((m) => m.id === id && m.online && m.call === scope)
    );

type Sync = Extract<MlsServerPacket, { action: 'sync' }>;
type Options = {
    identity: Identity;
    boot: string;
    scope: string;
    bundle: (id: string) => Bundle | undefined;
    // Whether this person is visibly in the call. The leader admits no one
    // else, so the server cannot add a hidden member.
    present: (id: string) => boolean;
    send: (packet: MlsClientPacket) => void;
    // Receives every member's base secret for the new epoch.
    install: (secrets: Map<string, Uint8Array>, delay: number) => void;
    // This browser dropped its keys and is asking to be admitted again.
    reset: () => void;
};
const wire = (message: Parameters<typeof encodeMlsMessage>[0]) =>
    b64(encodeMlsMessage(message));
function read(value: string) {
    try {
        return decodeMlsMessage(unb64(value), 0)?.[0];
    } catch {
        return undefined;
    }
}

export class DaveSession {
    private state: ClientState | null = null;
    private pending: { offer: number; state: ClientState } | null = null;
    private keyPackage?: {
        version: string;
        publicPackage: KeyPackage;
        privatePackage: PrivateKeyPackage;
    };
    private queue = Promise.resolve();
    private closed = false;
    private restarts: number[] = [];
    private retry?: ReturnType<typeof setTimeout>;
    private watchdog?: ReturnType<typeof setTimeout>;
    private config: ClientConfig = {
        ...defaultClientConfig,
        authService: {
            validateCredential: (credential, key) =>
                this.validate(credential, key),
        },
    };
    constructor(private options: Options) {}
    start() {
        this.enqueue(() => this.rejoin());
    }
    receive(packet: MlsServerPacket) {
        this.enqueue(() => this.handle(packet));
    }
    // Drops these keys and asks to be admitted again, e.g. when the group
    // still includes someone who left.
    resync() {
        this.enqueue(async () => {
            throw new Error('Resync.');
        });
    }
    close() {
        this.closed = true;
        clearTimeout(this.retry);
        clearTimeout(this.watchdog);
        this.state = this.pending = null;
        this.keyPackage = undefined;
    }
    // Who can decrypt this call, according to the group itself.
    members() {
        const ids = new Set<string>();
        for (const node of this.state?.ratchetTree || [])
            if (node?.nodeType === 'leaf') {
                const owner = credentialId(node.leaf.credential);
                if (owner) ids.add(owner.id);
            }
        return ids;
    }
    private enqueue(task: () => Promise<void>) {
        this.queue = this.queue
            .then(() => (this.closed ? undefined : task()))
            .catch(() => this.recover());
    }
    // Any commit, welcome, or setup that cannot be applied leads here. This
    // browser starts over with a fresh key package. Repeated failures back off,
    // but it keeps trying for as long as the call lasts.
    private recover() {
        if (this.closed) return;
        this.state = this.pending = null;
        this.keyPackage = undefined;
        clearTimeout(this.watchdog);
        clearTimeout(this.retry);
        this.options.reset();
        const now = Date.now();
        this.restarts = this.restarts.filter((time) => now - time < 60_000);
        const delay = this.restarts.length
            ? Math.min(8000, 250 * 2 ** (this.restarts.length - 1)) *
              (0.75 + Math.random() / 2)
            : 0;
        this.restarts.push(now);
        this.retry = setTimeout(() => {
            this.retry = undefined;
            this.enqueue(() => this.rejoin());
        }, delay);
    }
    private async validate(credential: Credential, key: Uint8Array) {
        const owner = credentialId(credential);
        const { scope, boot } = this.options;
        if (
            !owner ||
            (scope !== 'room' && !scope.split(':').slice(1).includes(owner.id))
        )
            return false;
        const bundle = this.options.bundle(owner.id);
        return Boolean(
            bundle &&
            (await identityId(bundle)) === owner.id &&
            (await verify(bundle, attestation(boot, scope, key), owner.sig))
        );
    }
    // A fresh key package asks the server to (re)admit this browser. It is
    // also the recovery path whenever a commit or welcome cannot be applied.
    private async rejoin() {
        this.state = this.pending = null;
        const impl = await cipherSuite();
        const { identity, boot, scope } = this.options;
        const signature = await impl.signature.keygen();
        const sig = await sign(
            identity,
            attestation(boot, scope, signature.publicKey)
        );
        const keyPackage = await generateKeyPackageWithKey(
            {
                credentialType: 'basic',
                identity: enc.encode(`${identity.id}.${sig}`),
            },
            defaultCapabilities(),
            defaultLifetime,
            [],
            signature,
            impl
        );
        if (this.closed) return;
        const version = crypto.randomUUID();
        this.keyPackage = { version, ...keyPackage };
        this.options.send({
            type: 'mls',
            scope,
            action: 'key-package',
            version,
            keyPackage: wire({
                version: 'mls10',
                wireformat: 'mls_key_package',
                keyPackage: keyPackage.publicPackage,
            }),
        });
        // If no one admits this key package, for any reason, ask again.
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(
            () =>
                this.enqueue(async () => {
                    if (this.keyPackage?.version === version)
                        throw new Error('Not admitted.');
                }),
            ADMIT_MS
        );
    }
    private async handle(packet: MlsServerPacket) {
        if (packet.scope !== this.options.scope) return;
        const impl = await cipherSuite();
        if (packet.action === 'reset') {
            clearTimeout(this.retry);
            this.retry = undefined;
            this.options.reset();
            return this.rejoin();
        }
        if (packet.action === 'create' || packet.action === 'welcome') {
            const kp = this.keyPackage;
            // Meant for a key package this browser has since replaced.
            if (!kp || packet.version !== kp.version) return;
            if (packet.action === 'create')
                this.state = await createGroup(
                    unb64(packet.group),
                    kp.publicPackage,
                    kp.privatePackage,
                    [],
                    impl,
                    this.config
                );
            else {
                const message = read(packet.welcome);
                if (message?.wireformat !== 'mls_welcome')
                    throw new Error('Invalid welcome.');
                this.state = await joinGroup(
                    message.welcome,
                    kp.publicPackage,
                    kp.privatePackage,
                    emptyPskIndex,
                    impl,
                    undefined,
                    undefined,
                    this.config
                );
            }
            this.keyPackage = undefined;
            clearTimeout(this.watchdog);
            return this.publish(0);
        }
        if (!this.state) {
            // Asked to commit while waiting to retry: retry now, so the server
            // sees this browser is no longer on the current epoch and asks
            // someone else.
            if (packet.action === 'sync' && this.retry) {
                clearTimeout(this.retry);
                this.retry = undefined;
                return this.rejoin();
            }
            return;
        }
        if (packet.action === 'commit') {
            const message = read(packet.commit);
            if (
                message?.wireformat !== 'mls_private_message' &&
                message?.wireformat !== 'mls_public_message'
            )
                throw new Error('Invalid commit.');
            const result = await processMessage(
                message,
                this.state,
                emptyPskIndex,
                membershipOnly,
                impl
            );
            if (result.kind !== 'newState' || result.actionTaken !== 'accept')
                throw new Error('Rejected commit.');
            this.state = result.newState;
            return this.publish(1000);
        }
        if (packet.action === 'committed' || packet.action === 'rejected') {
            if (this.pending?.offer !== packet.offer) return;
            if (packet.action === 'committed') this.state = this.pending.state;
            this.pending = null;
            if (packet.action === 'committed') await this.publish(1000);
            return;
        }
        if (packet.action === 'sync') return this.commit(packet, impl);
    }
    // Only the server-chosen leader commits, so epochs never fork.
    private async commit(sync: Sync, impl: CiphersuiteImpl) {
        const state = this.state!;
        this.pending = null;
        // A returning member's old leaf goes in the same commit as its new one.
        const leaving = new Set([
            ...sync.remove,
            ...sync.add.map((candidate) => candidate.id),
        ]);
        const removals: Proposal[] = [];
        state.ratchetTree.forEach((node, index) => {
            if (
                node?.nodeType === 'leaf' &&
                index / 2 !== state.privatePath.leafIndex &&
                leaving.has(credentialId(node.leaf.credential)?.id!)
            )
                removals.push({
                    proposalType: 'remove',
                    remove: { removed: toLeafIndex(index / 2) },
                });
        });
        const adds: Proposal[] = [];
        const added: string[] = [];
        for (const candidate of sync.add) {
            const message = read(candidate.keyPackage);
            if (message?.wireformat !== 'mls_key_package') continue;
            const { leafNode, cipherSuite } = message.keyPackage;
            if (
                cipherSuite !== SUITE ||
                credentialId(leafNode.credential)?.id !== candidate.id ||
                !this.options.present(candidate.id) ||
                !(await this.validate(
                    leafNode.credential,
                    leafNode.signaturePublicKey
                ))
            )
                continue;
            adds.push({
                proposalType: 'add',
                add: { keyPackage: message.keyPackage },
            });
            added.push(candidate.version);
        }
        const attempt = async (proposals: Proposal[]) =>
            proposals.length
                ? createCommit(
                      { state, cipherSuite: impl },
                      { extraProposals: proposals, ratchetTreeExtension: true }
                  )
                : undefined;
        let result: Awaited<ReturnType<typeof attempt>>;
        try {
            result = await attempt([...removals, ...adds]);
        } catch {
            // One unusable key package must not block everyone else's removal.
            added.length = 0;
            result = await attempt(removals);
        }
        if (this.closed || this.state !== state) return;
        if (result)
            this.pending = { offer: sync.offer, state: result.newState };
        this.options.send({
            type: 'mls',
            scope: this.options.scope,
            action: 'commit',
            offer: sync.offer,
            added,
            ...(result && {
                commit: wire(result.commit),
                ...(result.welcome && {
                    welcome: wire({
                        version: 'mls10',
                        wireformat: 'mls_welcome',
                        welcome: result.welcome,
                    }),
                }),
            }),
        });
    }
    private async publish(delay: number) {
        const state = this.state!;
        const impl = await cipherSuite();
        const secrets = new Map<string, Uint8Array>();
        for (const id of this.members())
            secrets.set(
                id,
                await mlsExporter(
                    state.keySchedule.exporterSecret,
                    LABEL,
                    enc.encode(id),
                    32,
                    impl
                )
            );
        if (!this.closed && this.state === state)
            this.options.install(secrets, delay);
    }
}

const membershipOnly: IncomingMessageCallback = (incoming) =>
    incoming.kind === 'commit' &&
    incoming.proposals.every(
        ({ proposal }) =>
            proposal.proposalType === 'add' ||
            proposal.proposalType === 'remove'
    )
        ? 'accept'
        : 'reject';
