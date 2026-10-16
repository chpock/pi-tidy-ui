import './fixtures/test-guard.mjs';
import {test} from 'node:test';
import {readInputs} from '../scripts/test/context.mjs';
import {checkCargoAncestry} from '../scripts/test/native-harness.mjs';

test('real pinned Cargo cannot inherit the checkout ancestor rustc wrapper',()=>{
  checkCargoAncestry(readInputs());
});
