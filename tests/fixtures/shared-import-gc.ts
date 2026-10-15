import { setInterval, clearInterval, setTimeout } from 'node:timers';

import './test-guard.mjs';


if (!global.gc) throw new Error('shared import ownership control requires --expose-gc');
let collections = 0;
const collector = setInterval(() => { global.gc!(); collections++; }, 1);
setTimeout(() => {
  clearInterval(collector);
  console.log(JSON.stringify({ sharedImportCollections: collections }));
}, 500);
