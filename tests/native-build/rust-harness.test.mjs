import '../../scripts/test/native-guard.mjs';
import {test} from 'node:test';
import {readNativeInputs} from '../../scripts/test/prepare-native.mjs';
import {checkCargoAncestry} from '../../scripts/test/native-harness.mjs';

test('real pinned Cargo cannot inherit the checkout ancestor rustc wrapper',()=>{
  checkCargoAncestry(readNativeInputs(process.env.TIDY_NATIVE_TEST_INPUTS));
});
