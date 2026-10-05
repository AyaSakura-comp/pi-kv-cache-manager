import '../../test/isolate.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { BaseCacheManager } from '../../dist/base-cache.js';
import { LruManager } from '../../dist/lru-manager.js';
import { DEFAULT_CONFIG } from '../../dist/config.js';
const root=process.argv[2];
globalThis.fetch=async(url,options)=>{
 const body=options?.body&&JSON.parse(options.body);
 if(url.endsWith('/slots'))return Response.json([{id:0,is_processing:false,snapshot_filename:''}]);
 if(url.endsWith('/apply-template'))return Response.json({prompt:'rendered'});
 if(url.endsWith('/completion')){await fs.appendFile(path.join(root,'warms.log'),`${process.pid}\n`);return Response.json({});}
 if(url.endsWith('action=save')){await fs.writeFile(path.join(root,body.filename),'kv');return Response.json({n_saved:50,n_written:2});}
 if(url.endsWith('action=erase'))return Response.json({});
 throw new Error('unfixture\'d fetch: '+url);
};
const config={...DEFAULT_CONFIG,cacheDir:root,goldenPrefix:'golden_worker_',goldenCwd:root,extensionsFingerprint:'v1',extensionLoadedAt:1};
await new BaseCacheManager(config,new LruManager(root)).ensureGolden('prefix',[]);
