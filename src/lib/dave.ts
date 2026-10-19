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
let suite: Promise<CiphersuiteImpl> | undefined;
const cipherSuite = () =>
    (suite ||= getCiphersuiteImpl(getCiphersuiteFromName(SUITE)));

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

type Sync = Extract<MlsServerPacket, { action: 'sync' }>;
type Options = {
    identity: Identity;
    boot: string;
    scope: string;
    bundle: (id: string) => Bundle | undefined;
    send: (packet: MlsClientPacket) => void;
    // Receives every member's base secret for the new epoch.
    install: (secrets: Map<string, Uint8Array>, delay: number) => void;
    fail: () => void;
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
        publicPackage: KeyPackage;
        privatePackage: PrivateKeyPackage;
    };
    private queue = Promise.resolve();
    private closed = false;
    private restarts: number[] = [];
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
    close() {
        this.closed = true;
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
            .catch(() => (this.closed ? undefined : this.rejoin()))
            .catch(() => this.options.fail());
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
        const now = Date.now();
        this.restarts = this.restarts.filter((time) => now - time < 30_000);
        if (this.restarts.push(now) > 4)
            throw new Error('Call encryption keeps failing.');
        this.state = this.pending = null;
        const impl = await cipherSuite();
        const { identity, boot, scope } = this.options;
        const signature = await impl.signature.keygen();
        const sig = await sign(
            identity,
            attestation(boot, scope, signature.publicKey)
        );
        this.keyPackage = await generateKeyPackageWithKey(
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
        this.options.send({
            type: 'mls',
            scope,
            action: 'key-package',
            version: crypto.randomUUID(),
            keyPackage: wire({
                version: 'mls10',
                wireformat: 'mls_key_package',
                keyPackage: this.keyPackage.publicPackage,
            }),
        });
    }
    private async handle(packet: MlsServerPacket) {
        if (packet.scope !== this.options.scope) return;
        const impl = await cipherSuite();
        if (packet.action === 'reset') return this.rejoin();
        if (packet.action === 'create' || packet.action === 'welcome') {
            const kp = this.keyPackage;
            if (!kp) return;
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
            return this.publish(0);
        }
        if (!this.state) return;
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
