// Runs after npm install. ts-mls 1.6.4 rejects valid call groups: RFC 9420
// requires each non-blank node between an unmerged leaf L and the parent P
// listing it to also list L, but ts-mls demands that every ancestor of L hold
// exactly the same list as P. Add-only commits make those lists differ, so a
// joiner refuses a correct welcome. Remove this once ts-mls is fixed upstream.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../node_modules/ts-mls');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(
    pkg.version,
    '1.6.4',
    'ts-mls changed: check whether scripts/patch-ts-mls.ts is still needed.'
);
const file = resolve(root, 'dist/src/clientState.js');
const source = await readFile(file, 'utf8');
const broken = `                for (const parentIdx of dp) {
                    const dpNode = tree[parentIdx];
                    if (dpNode !== undefined) {
                        if (dpNode.nodeType !== "parent")
                            return new InternalError("Expected parent node");
                        if (!arraysEqual(dpNode.parent.unmergedLeaves, n.parent.unmergedLeaves))`;
const fixed = `                for (const parentIdx of dp) {
                    if (parentIdx === toNodeIndex(i))
                        break;
                    const dpNode = tree[parentIdx];
                    if (dpNode !== undefined) {
                        if (dpNode.nodeType !== "parent")
                            return new InternalError("Expected parent node");
                        if (!dpNode.parent.unmergedLeaves.includes(unmergedLeaf))`;
if (!source.includes(fixed)) {
    assert(source.includes(broken), `Unexpected contents in ${file}.`);
    await writeFile(file, source.replace(broken, fixed));
    // Vite's development pre-bundle would keep serving the unpatched copy.
    await rm(resolve(import.meta.dirname, '../.vite/deps'), {
        recursive: true,
        force: true,
    });
    console.log('Patched ts-mls ratchet tree validation.');
}
