// Transport-independent client validation for the actual occipital protocol v2.
// JSON uses length/style pairs; retained classifications keep absolute endpoints.
import { OCCIPITAL_LIMITS } from './limits.ts';
export const PROTOCOL_VERSION = 2;
export const CAPABILITY = 'syntax-highlight/v2';
// SDK JSON decoding precedes this boundary; these checks are not an SDK heap cap.
const MAX_SOURCE = OCCIPITAL_LIMITS.sourceBytes, MAX_RUNS = OCCIPITAL_LIMITS.runs, MAX_STYLES = OCCIPITAL_LIMITS.styles;
const roles = ['plain','syntaxComment','syntaxKeyword','syntaxString','syntaxNumber','syntaxType','syntaxFunction','syntaxVariable','syntaxOperator','syntaxPunctuation'] as const;
export type WireStyle = {role: typeof roles[number]} | {rgb: [number,number,number];attributes:number} | {index:number;attributes:number} | {terminal_default:true;attributes:number};
type Invalid = 'invalid_header'|'provider_changed'|'invalid_descriptor'|'invalid_source'|'invalid_close';
export class ProtocolError extends Error {
  readonly code: Invalid;
  constructor(code: Invalid) { super(`occipital ${code}`); this.code=code; }
}
export class RemoteFault extends Error {
  readonly code:string;readonly execution:'not_started'|'started';
  constructor(code: string, execution: 'not_started'|'started') { super(`occipital ${code}`);this.code=code;this.execution=execution; }
}
export interface ProfileDescription { readonly id:string;readonly label:string;readonly fingerprint:string }
export interface Limits {
  request_bytes:number;reply_bytes:number;control_request_bytes:number;control_reply_bytes:number;
  source_bytes:number;line_bytes:number;batch_sources:number;queue_wait_ms:number;
  state_pool_bytes:number;leases:number;leases_per_route:number;runs:number;styles:number;
  idle_ms:number;age_ms:number;quantum_ms:number;data_per_route:number;control_per_route:number;routes:number;workers:number;
}
export interface Description {
  instance:string;assets:string;backend_version:string;catalogue_revision:number;
  profiles:readonly ProfileDescription[];diagnostic:string|null;limits:Limits;
  runtime:Readonly<Record<'pid'|'routes'|'leases'|'data_bytes'|'data_jobs'|'queued'|'control_bytes'|'control_jobs',number>>;
}
export interface Counters { committed_line_calls:number;committed_line_bytes:number;tail_calls:number;tail_bytes:number }
export interface ExpectedSource {
  key:string;generation:number;source_version:number;profile:string;fingerprint:string;
  revision:number;replace_from:number;source_bytes:number;complete:boolean;lease?:string;
  /** Only the requested replacement suffix: no full-prefix UTF8 encode per append. */
  replacementText:string;
}
export interface SourceChunk extends Omit<ExpectedSource,'replacementText'> {
  committed_bytes:number;
  /** [absoluteEndByte, packedStyle, ...]. No result-local palette retained. */
  runs:Uint32Array;
  counters:Counters;
}
function object(value:unknown): value is Record<string,unknown> { return value!==null&&typeof value==='object'&&!Array.isArray(value); }
function integer(value:unknown,minimum=0,maximum=Number.MAX_SAFE_INTEGER): value is number { return typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum&&value<=maximum; }
function text(value:unknown,cap=64,empty=false): value is string {
  return typeof value==='string'&&(empty||value.length>0)&&value.length<=cap&&Buffer.byteLength(value)<=cap&&!/[\p{Cc}\p{Cs}]/u.test(value);
}
function coherent(text:string):boolean {
  for(let i=0;i<text.length;i++) {
    const unit=text.charCodeAt(i);
    if(unit>=0xdc00&&unit<=0xdfff)return false;
    if(unit>=0xd800&&unit<=0xdbff) { const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false; }
  }
  return true;
}
function fingerprint(value:unknown): value is string { return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value); }
function header(value:unknown,ticket:string,identity?:Pick<Description,'instance'|'assets'>): {instance:string;assets:string;body:unknown} {
  if(!object(value)||value.v!==PROTOCOL_VERSION||value.ticket!==ticket||!text(value.ticket)||!text(value.instance)||!text(value.assets,256)
    ||(value.status!=='ok'&&value.status!=='error'))throw new ProtocolError('invalid_header');
  if(identity&&(identity.instance!==value.instance||identity.assets!==value.assets))throw new ProtocolError('provider_changed');
  if(value.status==='error') {
    if(Object.hasOwn(value,'body')||!object(value.error)||!text(value.error.code)||(value.error.execution!=='not_started'&&value.error.execution!=='started'))throw new ProtocolError('invalid_header');
    throw new RemoteFault(value.error.code,value.error.execution);
  }
  if(!Object.hasOwn(value,'body')||Object.hasOwn(value,'error'))throw new ProtocolError('invalid_header');
  return {instance:value.instance,assets:value.assets,body:value.body};
}
function includes(value:unknown,required:readonly string[],cap:number):boolean {
  return Array.isArray(value)&&value.length<=cap&&value.every(item=>text(item,64))&&new Set(value).size===value.length&&required.every(item=>value.includes(item));
}
export function decodeDescription(value:unknown,ticket:string):Description {
  const envelope=header(value,ticket),body=envelope.body;
  const fail=()=>{throw new ProtocolError('invalid_descriptor');};
  if(!object(body)||body.kind!=='descriptor'||body.protocol_version!==PROTOCOL_VERSION||body.category_version!==1
    ||body.assets!==envelope.assets||body.capability!==CAPABILITY||body.service!=='syntax'||!text(body.backend_version,128)
    ||!integer(body.catalogue_revision,0)||!includes(body.operations,['describe','themes.refresh','highlight','stream.open','stream.append','stream.close'],16)
    ||!includes(body.modes,['one_shot','growing'],4)||!includes(body.admission,['try_now','bounded_queue'],4)
    ||!Array.isArray(body.profiles)||body.profiles.length===0||body.profiles.length>49
    ||(body.diagnostic!==null&&!text(body.diagnostic,256))||!object(body.limits)||!object(body.runtime))return fail();
  const seen=new Set<string>(),profiles:ProfileDescription[]=[];
  for(const profile of body.profiles) {
    if(!object(profile)||!text(profile.id)||!text(profile.label,128)||!fingerprint(profile.fingerprint)||seen.has(profile.id))return fail();
    seen.add(profile.id);profiles.push({id:profile.id,label:profile.label,fingerprint:profile.fingerprint});
  }
  if(!seen.has('pi'))return fail();
  const requiredLimits=['request_bytes','reply_bytes','control_request_bytes','control_reply_bytes',
    'source_bytes','line_bytes','batch_sources','queue_wait_ms','state_pool_bytes','leases','leases_per_route',
    'runs','styles','idle_ms','age_ms','quantum_ms','data_per_route','control_per_route','routes','workers'] as const satisfies readonly (keyof Limits)[];
  // Preserve actual server limits, especially server-owned expiry/worker timing.
  // Client allocation caps apply separately at the source boundary below.
  const limits={} as Limits;
  for(const key of requiredLimits) {
    const limit=body.limits[key];if(!integer(limit,1,4294967295))return fail();limits[key]=limit;
  }
  // Runtime is informational, never substituted for protocol/session progress.
  const runtime={} as Description['runtime'];
  for(const key of ['pid','routes','leases','data_bytes','data_jobs','queued','control_bytes','control_jobs'] as const) {
    const count=body.runtime[key];if(!integer(count,key==='pid'?1:0))return fail();
    (runtime as Record<string,number>)[key]=count;
  }
  return {instance:envelope.instance,assets:envelope.assets,backend_version:body.backend_version,catalogue_revision:body.catalogue_revision,
    profiles,diagnostic:body.diagnostic as string|null,limits,runtime};
}
function exactKeys(value:Record<string,unknown>,keys:readonly string[]):boolean { return Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)); }
function packStyle(value:unknown,pi:boolean):number {
  if(!object(value))throw new ProtocolError('invalid_source');
  if(pi) {
    if(!exactKeys(value,['role']))throw new ProtocolError('invalid_source');
    const role=roles.indexOf(value.role as typeof roles[number]);if(role<0)throw new ProtocolError('invalid_source');return role;
  }
  // Unclassified coverage inherits the caller's ordinary text style even with
  // an independent native theme. Other Pi syntax colors remain profile-specific.
  if(exactKeys(value,['role'])&&value.role==='plain')return 0;
  if(!integer(value.attributes,0,7))throw new ProtocolError('invalid_source');
  const attributes=value.attributes<<24;
  if(exactKeys(value,['rgb','attributes'])&&Array.isArray(value.rgb)&&value.rgb.length===3&&value.rgb.every(c=>integer(c,0,255)))
    return ((1<<30)|attributes|(value.rgb[0]<<16)|(value.rgb[1]<<8)|value.rgb[2])>>>0;
  if(exactKeys(value,['index','attributes'])&&integer(value.index,0,255))return ((2<<30)|attributes|value.index)>>>0;
  if(exactKeys(value,['terminal_default','attributes'])&&value.terminal_default===true)return ((3<<30)|attributes)>>>0;
  throw new ProtocolError('invalid_source');
}
export function unpackStyle(value:number):WireStyle {
  const kind=value>>>30,attributes=(value>>>24)&7;
  if(kind===0)return {role:roles[value]!};
  if(kind===1)return {rgb:[(value>>>16)&255,(value>>>8)&255,value&255],attributes};
  if(kind===2)return {index:value&255,attributes};
  return {terminal_default:true,attributes};
}
type ValidatedSource={metadata:Omit<SourceChunk,'runs'>;wireRuns:readonly number[];palette:readonly number[]};
function validateSource(value:unknown,expected:ExpectedSource,descriptor:Description):ValidatedSource {
  const fail=()=>{throw new ProtocolError('invalid_source');};
  const sourceCap=Math.min(MAX_SOURCE,descriptor.limits.source_bytes);
  if(!object(value)||!text(value.key)||!integer(value.generation,1,4294967295)||!integer(value.source_version,0,4294967295)
    ||!integer(value.revision,1,4294967295)||!integer(value.source_bytes,0,sourceCap)
    ||!integer(value.replace_from,0,value.source_bytes)||!integer(value.committed_bytes,value.replace_from,value.source_bytes)
    ||!text(value.profile)||!fingerprint(value.fingerprint)||typeof value.complete!=='boolean'
    ||!Array.isArray(value.styles)||value.styles.length>Math.min(MAX_STYLES,descriptor.limits.styles)||!Array.isArray(value.runs)
    ||value.runs.length%2!==0||value.runs.length>Math.min(MAX_RUNS,descriptor.limits.runs)*2||!object(value.counters))return fail();
  for(const key of ['key','generation','source_version','revision','source_bytes','replace_from','profile','fingerprint','complete'] as const)
    if(value[key]!==expected[key])return fail();
  if(!descriptor.profiles.some(profile=>profile.id===value.profile&&profile.fingerprint===value.fingerprint))return fail();
  // A final append acknowledges the same now-ended lease. One-shot replies
   // have no lease. Finalization commits all source bytes without adding a newline.
  if(expected.lease!==undefined?value.lease!==expected.lease||!text(value.lease)
    :value.complete?Object.hasOwn(value,'lease'):!text(value.lease))return fail();
  const counters={} as Counters;
  for(const key of ['committed_line_calls','committed_line_bytes','tail_calls','tail_bytes'] as const) {
    const count=value.counters[key];if(!integer(count))return fail();counters[key]=count;
  }
  const suffixBytes=value.source_bytes-value.replace_from;
  if(!coherent(expected.replacementText)||expected.replacementText.length>sourceCap||Buffer.byteLength(expected.replacementText)!==suffixBytes)return fail();
  // Only the newly returned suffix is encoded for byte-boundary validation.
  const suffix=Buffer.from(expected.replacementText,'utf8');
  const boundary=(absolute:number)=>absolute===value.source_bytes||((suffix[absolute-(value.replace_from as number)]!&0xc0)!==0x80);
   const committed=value.complete?value.source_bytes:value.replace_from+suffix.lastIndexOf(10)+1;
   if(value.committed_bytes!==committed||!boundary(value.committed_bytes))return fail();
  const palette=value.styles.map(style=>packStyle(style,value.profile==='pi'));
  if(new Set(palette).size!==palette.length)return fail();
  let end=value.replace_from,previous:number|undefined;
  for(let i=0;i<value.runs.length;i+=2) {
    const length=value.runs[i],id=value.runs[i+1];
    if(!integer(length,1,value.source_bytes-end)||!integer(id,0,palette.length-1))return fail();
    const next=end+length;
    if(!boundary(next)||palette[id]===previous)return fail();
    end=next;previous=palette[id];
  }
  if(end!==value.source_bytes)return fail();
   return {wireRuns:value.runs as number[],palette,metadata:{key:value.key,generation:value.generation,source_version:value.source_version,revision:value.revision,
     source_bytes:value.source_bytes,committed_bytes:value.committed_bytes,replace_from:value.replace_from,
     profile:value.profile,fingerprint:value.fingerprint,complete:value.complete,...(value.lease!==undefined?{lease:value.lease as string}:{}),counters}};
}
function materializeSource(value:ValidatedSource):SourceChunk {
  const runs=new Uint32Array(value.wireRuns.length);
  let absolute=value.metadata.replace_from;
  for(let i=0;i<runs.length;i+=2) {absolute+=value.wireRuns[i]!;runs[i]=absolute;runs[i+1]=value.palette[value.wireRuns[i+1]!]!;}
  return {...value.metadata,runs};
}
export function decodeSources(value:unknown,ticket:string,descriptor:Description,expected:readonly ExpectedSource[]):SourceChunk[] {
  const body=header(value,ticket,descriptor).body;
  if(!object(body)||body.kind!=='source'||!Array.isArray(body.sources)||expected.length===0||expected.length>Math.min(OCCIPITAL_LIMITS.batchSources,descriptor.limits.batch_sources)
    ||body.sources.length!==expected.length)throw new ProtocolError('invalid_source');
   const values=new Map<string,unknown>();
   const sourceCap=Math.min(MAX_SOURCE,descriptor.limits.source_bytes);
   let total=0;
   for(const item of body.sources) {
     if(!object(item)||!text(item.key)||values.has(item.key)||!integer(item.source_bytes,0,sourceCap))throw new ProtocolError('invalid_source');
     total+=item.source_bytes;if(total>sourceCap)throw new ProtocolError('invalid_source');
     values.set(item.key,item);
   }
  if(new Set(expected.map(item=>item.key)).size!==expected.length)throw new ProtocolError('invalid_source');
   // Validate the complete batch before owning even its first range vector.
   const validated=expected.map(demand=>validateSource(values.get(demand.key),demand,descriptor));
   return validated.map(materializeSource);
}
export function decodeClosed(value:unknown,ticket:string,descriptor:Description):void {
  const body=header(value,ticket,descriptor).body;
  if(!object(body)||!exactKeys(body,['kind'])||body.kind!=='closed')throw new ProtocolError('invalid_close');
}
