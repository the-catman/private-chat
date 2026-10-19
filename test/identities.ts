import { createIdentity as create } from '../src/lib/crypto';
import type { Identity } from '../src/types';

// Test identities fetch each other's prekeys directly. The server tests cover
// prekey distribution separately.
const directory = new Map<string, Identity>();
export async function createIdentity() {
    const identity = await create();
    directory.set(identity.id, identity);
    identity.ratchet.fetch = async (id) => {
        const peer = directory.get(id);
        if (!peer) throw new Error('Unknown test identity.');
        return peer.ratchet.bundle();
    };
    return identity;
}
