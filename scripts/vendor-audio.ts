// Usage: node --import=tsx scripts/vendor-audio.ts /path/to/unpacked/web-noise-suppressor
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const source = process.argv[2];
assert(source, 'Pass the unpacked @sapphi-red/web-noise-suppressor package.');
const pkg = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@sapphi-red/web-noise-suppressor');
assert.equal(pkg.version, '0.4.1');
const license = await readFile(resolve(source, 'LICENSE'), 'utf8');
let processor = await readFile(
    resolve(source, 'dist/gtcrn/workletProcessor.js'),
    'utf8'
);
// Report readiness/failure and start the control port explicitly. This avoids
// silent calls if model initialization fails and makes destroy messages reliable.
const start = 'this.destroyed=!1,this.port.addEventListener';
assert(processor.includes(start));
processor = processor.replace(
    start,
    'this.destroyed=!1,this.port.start(),this.port.addEventListener'
);
const ready = 'this.destroyed&&this.destroy()})()';
assert(processor.includes(ready));
processor = processor.replace(
    ready,
    'this.destroyed?this.destroy():this.port.postMessage("ready")})().catch(()=>this.port.postMessage("error"))'
);
processor = processor.replace(/\/\/# sourceMappingURL=.*$/m, '');
await mkdir('src/assets/audio', { recursive: true });
await writeFile(
    'src/assets/audio/gtcrn-worklet.js',
    `/*!\n${license.trim()}\n*/\n// Adapted for readiness, initialization errors, and control-port cleanup.\n` +
        processor
);
await copyFile(
    resolve(source, 'dist/gtcrn.wasm'),
    'src/assets/audio/gtcrn.wasm'
);
await writeFile(
    'licenses/Noise-suppression.txt',
    license + '\n' + processor.slice(0, processor.indexOf('const e='))
);
console.log('Vendored the GTCRN processor and model; no runtime CDN is used.');
