// Coupled JSON/owned/shared emergency guards; not V8, SDK or whole-Pi RSS caps.
const wireBytes=64*1024*1024;
export const OCCIPITAL_LIMITS=Object.freeze({
  wireBytes, sourceBytes:wireBytes,
  // Each positive length/style pair costs at least four JSON bytes.
  runs:wireBytes/4,
  // 512 admitted foreground entries + default, three font bits, neutral Plain.
  styles:(512+1)*8+1,
  batchSources:8, retainedBytes:1024*1024*1024,
  // Source-controller data policy; control/discovery deadlines remain separate.
  dataDeadlineMs:300_000,
});
