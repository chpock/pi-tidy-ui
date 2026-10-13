// Research adapters, not a production renderer. Tree-sitter: upstream highlight
// queries + explicit overlap projection, no injection or locals interpreter.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
export const root = process.env.HIGHLIGHT_RESEARCH_ROOT ?? '/tmp/pi-tidy-ui-head-to-head';
const require = createRequire(`${root}/package.json`);
const load = path => import(pathToFileURL(`${root}/node_modules/${path}`).href);
export const colors = { plain: '#c6c8d1', keyword: '#c792ea', variable: '#82aaff', property: '#ffcb6b', function: '#89ddff', type: '#f78c6c', string: '#c3e88d', number: '#f07178', comment: '#676e95', operator: '#a9c8de', constant: '#ff5370' };
const colorRoles = new Map(Object.entries(colors).map(([r,c]) => [c.toLowerCase(),r]));
const theme = {name:'research', settings:[{settings:{foreground:colors.plain,background:'#202020'}}, ...Object.entries({keyword:['keyword','storage'], variable:['variable'], property:['variable.other.property','entity.other.attribute-name'], function:['entity.name.function','support.function'], type:['entity.name.type','entity.name.class','support.type','support.class'], string:['string'], number:['constant.numeric'], comment:['comment'], operator:['keyword.operator'], constant:['constant.language','constant.other']}).map(([r, scope]) => ({scope,settings:{foreground:colors[r]}}))]};
const priority = {plain:0, variable:1, operator:2, property:3, constant:4, keyword:4, number:4, string:4, comment:4, type:5, function:6};
const role = name => name.startsWith('function') ? 'function' : name.startsWith('type') || name.startsWith('constructor') ? 'type' : name.startsWith('property') || name.startsWith('attribute') ? 'property' : name.startsWith('variable') ? 'variable' : name.startsWith('keyword') ? 'keyword' : name.startsWith('comment') ? 'comment' : name.startsWith('string') || name === 'escape' ? 'string' : name.startsWith('number') || name.startsWith('float') ? 'number' : name.startsWith('constant') || name.startsWith('boolean') ? 'constant' : name.startsWith('operator') ? 'operator' : 'plain';
function push(out, a, b, r) { if (b <= a) return; const last = out.at(-1); if(last && last[1] === a && last[2] === r) last[1] = b; else out.push([a,b,r]); }
// Sweep-line overlap resolution: shortest enclosing capture first, then role
// specificity. This is an explicit research policy, not Tree-sitter's Rust highlighter.
export function project(captures, length, lower=0, upper=length) {
  const events = [], spans = [];
  for(const c of captures) {
    const start=c.node.startIndex, end=c.node.endIndex;
    const a=Math.max(lower,start), b=Math.min(upper,end);
    const r=role(c.name); if(b<=a || r==='plain') continue;
    const n=spans.length; spans.push([a,b,r,end-start]); events.push([a,1,n],[b,0,n]);
  }
  events.sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
  const active=new Set(), out=[]; let previous=lower, i=0;
  while(i<events.length) {
    const position=events[i][0]; let selected;
    for(const n of active) { const s=spans[n]; if(!selected || s[3]<selected[3] || s[3]===selected[3] && priority[s[2]]>priority[selected[2]]) selected=s; }
    push(out,previous,position,selected?.[2] ?? 'plain');
    while(i<events.length && events[i][0]===position) { const e=events[i++]; if(e[1]) active.add(e[2]); else active.delete(e[2]); }
    previous=position;
  }
  push(out,previous,upper,'plain'); return out;
}
const escapes=Object.fromEntries(Object.entries(colors).map(([role,c])=>[role,`\x1b[38;2;${[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)).join(';')}m`]));
export function serialize(text, spans) {
  let s=''; for(const [a,b,r] of spans) s+=escapes[r]+text.slice(a,b)+'\x1b[39m'; return s;
}
export function assertText(text, spans) {
  assert.equal(spans.map(([a,b])=>text.slice(a,b)).join(''),text);
  assert.equal(serialize(text,spans).replace(/\x1b\[[0-9;]*m/g,''),text);
  let end=0; for(const [a,b] of spans) {assert.equal(a,end); assert.ok(b>a && b<=text.length); end=b;} assert.equal(end,text.length);
}
const queryPath = lang => `${root}/node_modules/tree-sitter-${lang==='tsx' || lang==='typescript' ? 'typescript' : lang}/queries/highlights.scm`;
function querySource(lang) {return (['typescript','tsx'].includes(lang) ? readFileSync(queryPath('javascript'),'utf8')+'\n' : '')+(lang==='tsx'?readFileSync(`${root}/node_modules/tree-sitter-javascript/queries/highlights-jsx.scm`,'utf8')+'\n':'')+readFileSync(queryPath(lang),'utf8');}
export function point(text,index) {const prefix=text.slice(0,index); const row=prefix.split('\n').length-1; return {row,column:index-(prefix.lastIndexOf('\n')+1)};}
function merge(a,b) {const out=a.map(s=>[...s]); for(const s of b)push(out,...s);return out;}
export async function createEngine(kind, languages) {
  const start=performance.now(); const counters={parses:0,queries:0,tokenizedLines:0,queryReturnedCaptures:0};
  const engine={kind,languages,counters,resetCounters(){for(const k of Object.keys(counters))counters[k]=0;}};
  if(kind.startsWith('shiki')) {
    const {createHighlighterCore}=await load('@shikijs/core/dist/index.mjs');
    const regex=kind==='shiki-js' ? (await load('@shikijs/engine-javascript/dist/index.mjs')).createJavaScriptRegexEngine() : (await load('@shikijs/engine-oniguruma/dist/index.mjs')).createOnigurumaEngine(load('@shikijs/engine-oniguruma/dist/wasm-inlined.mjs'));
    const modules=await Promise.all(languages.map(l=>load(`@shikijs/langs/dist/${l==='bash'?'shellscript':l}.mjs`)));
    const hi=await createHighlighterCore({themes:[theme],langs:modules.map(m=>m.default),engine:regex});
    const token=(text,lang,state)=>{counters.tokenizedLines+=text.split('\n').length;return hi.codeToTokensBase(text,{lang:lang==='bash'?'shellscript':lang,theme:'research',grammarState:state,includeExplanation:false,tokenizeTimeLimit:0});};
    const convert=(text,tokens,offset=0)=> {const out=[];let pos=offset;for(const line of tokens)for(const t of line){push(out,pos,offset+t.offset,'plain');push(out,offset+t.offset,offset+t.offset+t.content.length,colorRoles.get(t.color.toLowerCase())??'plain');pos=offset+t.offset+t.content.length;}push(out,pos,offset+text.length,'plain');return out;};
    engine.full=(text,lang)=>convert(text,token(text,lang));
    engine.raw=(text,lang)=>hi.codeToTokensBase(text,{lang:lang==='bash'?'shellscript':lang,theme:'research',includeExplanation:'scopeName',tokenizeTimeLimit:0}).flat().map(t=>({text:t.content,start:t.offset,end:t.offset+t.content.length,scopes:t.explanation?.flatMap(e=>e.scopes.map(s=>s.scopeName))}));
    engine.session=lang=>{
      let text='', rows=[], states=[], current=[];
      return {update(next){
        if(next===text)return current;
        let prefix=0;while(prefix<text.length && prefix<next.length && text[prefix]===next[prefix])prefix++;
        const first=next.slice(0,prefix).split('\n').length-1, lines=next.split('\n');
        const kept=rows.slice(0,first); const keptStates=states.slice(0,first);let state=first?states[first-1]:undefined;
        let offset=lines.slice(0,first).reduce((n,s)=>n+s.length+1,0);
        for(let i=first;i<lines.length;i++) {const tokens=token(lines[i],lang,state);const row=convert(lines[i],tokens,offset);if(i<lines.length-1)push(row,offset+lines[i].length,offset+lines[i].length+1,'plain');kept.push(row);state=hi.getLastGrammarState(tokens);keptStates.push(state);offset+=lines[i].length+1;}
        text=next;rows=kept;states=keptStates; const out=[];for(const row of rows)for(const s of row)push(out,...s);current=out;return out;
      },dispose(){text='';rows=[];states=[];current=[];}};
    };
    engine.profile=(text,lang,stage)=>{let tokens=token(text,lang);stage('tokenize');let spans=convert(text,tokens);stage('project');let ansi=serialize(text,spans);stage('ansi');assertText(text,spans);stage('assert');tokens=undefined;spans=undefined;ansi=undefined;stage('released');};
    engine.loadedLanguages=hi.getLoadedLanguages(); engine.dispose=()=>hi.dispose();
  } else {
    const native=kind==='tree-native'; const lib=native?require('tree-sitter'):await load('web-tree-sitter/web-tree-sitter.js');
    const Parser=native?lib:lib.Parser; if(!native)await Parser.init();
    const configs=new Map();
    for(const lang of languages) {
      const pkg=lang==='tsx'||lang==='typescript'?'typescript':lang;
      const nativeModule=native ? (await import(pathToFileURL(require.resolve(`tree-sitter-${pkg}`)).href)).default : undefined;
      const grammar=native ? (pkg==='typescript'?nativeModule[lang]:nativeModule) : await lib.Language.load(existsSync(`${root}/node_modules/tree-sitter-${pkg}/tree-sitter-${lang}.wasm`)?`${root}/node_modules/tree-sitter-${pkg}/tree-sitter-${lang}.wasm`:`${root}/node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-${lang}.wasm`);
      const parser=new Parser();parser.setLanguage(grammar); const query=new lib.Query(grammar,querySource(lang)); configs.set(lang,{grammar,parser,query});
    }
    const capture=(tree,lang,lower=0,upper=tree.rootNode.endIndex)=>{counters.queries++;const options=lower ? {startPosition:point(tree.rootNode.text,lower)} : {};
      const cs=configs.get(lang).query.captures(tree.rootNode,options);counters.queryReturnedCaptures+=cs.length;return cs;};
    const release=tree=>tree?.delete?.();
    engine.full=(text,lang)=>{counters.parses++;const t=configs.get(lang).parser.parse(text);assert.equal(t.rootNode.endIndex,text.length);const spans=project(capture(t,lang),text.length);release(t);return spans;};
    engine.raw=(text,lang)=>{const t=configs.get(lang).parser.parse(text);const cs=capture(t,lang).map(c=>({name:c.name,text:c.node.text,start:c.node.startIndex,end:c.node.endIndex}));release(t);return cs;};
    engine.session=(lang,queryMode='full')=>{
      let text='',tree,spans=[];
      return {update(next){
        if(next===text)return spans;
        let prefix=0;while(prefix<text.length&&prefix<next.length&&text[prefix]===next[prefix])prefix++;
        let oldEnd=text.length,newEnd=next.length;while(oldEnd>prefix&&newEnd>prefix&&text[oldEnd-1]===next[newEnd-1]){oldEnd--;newEnd--;}
        const oldTree=tree;let dirty=prefix;
        if(tree){
          // Conservatively include the whole top-level syntax construct touched
          // by the edit. This intentionally degenerates for a growing function.
          let node=tree.rootNode.namedDescendantForIndex(Math.max(0,prefix-1));
          while(node.parent && node.parent.id!==tree.rootNode.id)node=node.parent;
          dirty=Math.min(dirty,node.startIndex);
          tree.edit({startIndex:prefix,oldEndIndex:oldEnd,newEndIndex:newEnd,startPosition:point(text,prefix),oldEndPosition:point(text,oldEnd),newEndPosition:point(next,newEnd)});
        }
        counters.parses++;tree=configs.get(lang).parser.parse(next,tree);
        if(oldTree)for(const range of oldTree.getChangedRanges(tree))dirty=Math.min(dirty,range.startIndex);
        if(queryMode==='full')dirty=0;
        // Range queries still run against the complete tree so ancestor patterns
        // are available. Middle replacements rebuild the suffix, not an unsafe
        // heuristic based only on getChangedRanges (which misses lexical edits).
        const prefixSpans=spans.filter(s=>s[0]<dirty).map(s=>[s[0],Math.min(dirty,s[1]),s[2]]);
        spans=merge(prefixSpans,project(capture(tree,lang,dirty,next.length),next.length,dirty));
        release(oldTree);text=next;return spans;
      },dispose(){release(tree);tree=undefined;text='';spans=[];}};
    };
    engine.profile=(text,lang,stage)=>{let tree=configs.get(lang).parser.parse(text);stage('parse');let captures=capture(tree,lang);stage('query');let spans=project(captures,text.length);stage('project');let ansi=serialize(text,spans);stage('ansi');assertText(text,spans);stage('assert');release(tree);tree=undefined;captures=undefined;spans=undefined;ansi=undefined;stage('released');};
    engine.loadedLanguages=[...configs.keys()];engine.dispose=()=>{for(const {query,parser}of configs.values()){query.delete?.();parser.delete?.();}configs.clear();};
  }
  engine.initializationMs=performance.now()-start;return engine;
}
