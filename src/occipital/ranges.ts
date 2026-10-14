import type { SourceChunk } from './protocol.ts';
import { OCCIPITAL_LIMITS } from './limits.ts';

const MAX_RETAINED=OCCIPITAL_LIMITS.retainedBytes;
// Explicit conservative bookkeeping allowances, not claims about V8 heap size.
const RECORD_ALLOWANCE=512, BLOCK_ALLOWANCE=256;
type Block={start:number;runs:Uint32Array};
type Identity=Pick<SourceChunk,'key'|'generation'|'profile'|'fingerprint'|'lease'>;

/** Owns only validated packed ranges. Caller supplies the remaining global
 * retention allowance after other source records and captured text. No node,
 * callback, theme, source text or raw response object is retained here. */
export class RangeAccumulator {
  private blocks:Block[]=[];
  private tail:Block|undefined;
  private identity:Identity|undefined;
  private revision=0;
  private displayRevision=0;
  private version=0;
  private sourceBytes=0;
  private committedBytes=0;
  private prefixBytes=0;
  private complete=false;
  private invalid=false;

  /** Exact post-update retention, without range allocation or state mutation.
   * Global admission uses the same plan as apply, not a duplicated estimate. */
  requiredBytes(chunk:SourceChunk):number { return this.plan(chunk).required; }

  private plan(chunk:SourceChunk) {
    const identity=this.identity;
    if(this.invalid||this.complete
      ||chunk.revision!==this.revision+1||chunk.source_version<this.version||chunk.source_bytes<this.sourceBytes
      ||chunk.replace_from!==this.committedBytes||chunk.committed_bytes<chunk.replace_from||chunk.committed_bytes>chunk.source_bytes
      ||chunk.complete&&chunk.committed_bytes!==chunk.source_bytes
      ||identity&&(['key','generation','profile','fingerprint','lease'] as const).some(key=>identity[key]!==chunk[key]))throw new Error('classification state mismatch');
    const from=chunk.replace_from,to=chunk.committed_bytes,end=chunk.source_bytes;
    const commitLength=clippedLength(chunk.runs,from,to),tailLength=clippedLength(chunk.runs,to,end);
    const nextBlocks=this.blocks.length+(commitLength?1:0)+(tailLength?1:0);
    const required=RECORD_ALLOWANCE+nextBlocks*BLOCK_ALLOWANCE+this.prefixBytes+(commitLength+tailLength)*4;
    return {commitLength,tailLength,required};
  }

  apply(chunk:SourceChunk,availableBytes=MAX_RETAINED):boolean {
    if(!Number.isSafeInteger(availableBytes)||availableBytes<0||availableBytes>MAX_RETAINED)throw new Error('classification state mismatch');
    const {commitLength,tailLength,required}=this.plan(chunk);
    const identity=this.identity,from=chunk.replace_from,to=chunk.committed_bytes,end=chunk.source_bytes;
    // No owned range allocation occurs before the complete retention check.
    // Without required coverage, this incarnation cannot consume another suffix.
    if(required>availableBytes){this.invalidate();return false;}
    const changed=!identity||end!==this.sourceBytes||!sameTail(this.tail,chunk.runs,from,end);
    const committed=commitLength?{start:from,runs:clip(chunk.runs,from,to,commitLength)}:undefined;
    const tail=tailLength?{start:to,runs:clip(chunk.runs,to,end,tailLength)}:undefined;
    if(committed){this.blocks.push(committed);this.prefixBytes+=committed.runs.byteLength;}
    this.tail=tail;
    if(!identity)this.identity={key:chunk.key,generation:chunk.generation,profile:chunk.profile,fingerprint:chunk.fingerprint,lease:chunk.lease};
    this.revision=chunk.revision;this.version=chunk.source_version;this.sourceBytes=end;
    this.committedBytes=to;this.complete=chunk.complete;
    if(changed)this.displayRevision++;
    return true;
  }

  /** Primitive-only synchronous visit: persistent views never obtain buffers. */
  visit(consume:(start:number,end:number,packedStyle:number)=>void):void {
    for(const block of this.blocks)visitBlock(block,consume);
    if(this.tail)visitBlock(this.tail,consume);
  }
  stats() {
    const tailBytes=this.tail?.runs.byteLength??0;
    return {retainedBytes:this.identity?RECORD_ALLOWANCE+(this.blocks.length+(this.tail?1:0))*BLOCK_ALLOWANCE+this.prefixBytes+tailBytes:0,
      rangeBytes:this.prefixBytes+tailBytes,tailBytes,committedChunks:this.blocks.length,prefixCopiedBytes:0,
      revision:this.revision,displayRevision:this.displayRevision,sourceVersion:this.version,sourceBytes:this.sourceBytes,committedBytes:this.committedBytes,complete:this.complete};
  }
  invalidate():void {
    this.blocks=[];this.tail=undefined;this.identity=undefined;this.prefixBytes=0;
    this.revision=0;this.displayRevision=0;this.version=0;this.sourceBytes=0;this.committedBytes=0;this.complete=false;this.invalid=true;
  }
}
function clippedLength(runs:Uint32Array,from:number,to:number):number {
  if(from===to)return 0;
  let start=0,count=0;
  for(let i=0;i<runs.length;i+=2){const end=runs[i]!;if(end>from&&start<to)count+=2;start=end;if(end>=to)break;}
  return count;
}
function clip(runs:Uint32Array,from:number,to:number,length:number):Uint32Array {
  const result=new Uint32Array(length);let start=0,next=0;
  for(let i=0;i<runs.length;i+=2){const end=runs[i]!;if(end>from&&start<to){result[next++]=Math.min(end,to);result[next++]=runs[i+1]!;}start=end;if(end>=to)break;}
  return result;
}
function visitBlock(block:Block,consume:(start:number,end:number,packedStyle:number)=>void):void {
  let start=block.start;
  for(let i=0;i<block.runs.length;i+=2){const end=block.runs[i]!;consume(start,end,block.runs[i+1]!);start=end;}
}

// Only the acknowledged provisional suffix can change; committed blocks are not walked.
function sameTail(tail:Block|undefined,runs:Uint32Array,from:number,to:number):boolean {
  let old=0,next=0,position=from;
  while(position<to){
    if(!tail||tail.runs[old+1]!==runs[next+1])return false;
    const end=Math.min(tail.runs[old]!,runs[next]!);
    if(!Number.isFinite(end)||end<=position)return false;
    position=end;
    if(tail.runs[old]===end)old+=2;
    if(runs[next]===end)next+=2;
  }
  return true;
}
