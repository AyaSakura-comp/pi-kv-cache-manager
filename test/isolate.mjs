// Loaded before modules: even baseline code must never see the real HOME/settings/cache.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'kv-test-home-'));
process.env.HOME = home;
delete process.env.LLAMA_SLOT_SAVE_PATH;
delete process.env.LLAMA_BASE_URL;
globalThis.fetch = async () => { throw new Error('Network forbidden in CPU tests: install a fixture'); };
process.on('exit', () => rmSync(home, {recursive:true,force:true}));
