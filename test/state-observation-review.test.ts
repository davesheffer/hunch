import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tempStore} from './helpers.js';
import {captureBatchState} from '../src/store/stateCapture.js';
import {partitionOf,readState,writeState} from '../src/store/stateBinding.js';
import {readLedger} from '../src/store/changeLedger.js';
import {stateHash} from '../src/core/stateContract.js';

test('review withdraws only the contradicted assertion, keeps original history and linked siblings, and safely replays',()=>{
 const f=tempStore();
 try{
  const scope=partitionOf(f.store),principal={id:'codex@david',kind:'agent',grants:[scope]};
  const ref={system:'crm',object_type:'event',object_key:'42',observed_at:'2026-09-10T12:00:00Z'};
  const statements=['Office closes Friday.','Call Dana Thursday.'];
  const make=(statement:string)=>({subject:'event:42',statement,relevance:{use:'operational_fact',reason:'Plan the next visit.'},evidence:[{source:0,excerpt:statement}]});
  const initial=captureBatchState(f.store,{schema:'nuryel.state.capture-batch/1',scope,principal,sources:[{ref,source_text:statements.join(' ')}],observations:statements.map(make)});
  const records=initial.results.map(r=>{assert.equal(r.status,'saved');if(r.status!=='saved')throw Error('fixture refused');return r.result;});
  for(const r of records)writeState(f.store,{schema:'nuryel.state.write/1',principal,scope,facet:'relationships',idempotency_key:'link:'+r.record_id,record:{schema:'nuryel.relationship/1',from:r.record_id,to:'customer:Site:7',type:'observation_about',observation_hash:r.record_hash,reason:'CRM explicitly assigns this event to Site:7.',evidence:{...ref,content_hash:stateHash('explicit association')},provenance:{source:'agent_recorded',confidence:1,evidence:['CRM location']}}});
  const current='Office now opens Friday. Call Dana Thursday. Unrelated chatter.';
  const review={record_id:records[0]!.record_id,expected_hash:records[0]!.record_hash,reason:'Friday closure is explicitly replaced with Friday opening.',evidence:[{source:0,excerpt:'Office now opens Friday.'}]};
  const request={schema:'nuryel.state.capture-batch/1',scope,principal:{...principal,id:'claude@david'},sources:[{ref,source_text:current}],observations:[make('Office now opens Friday.')],reviews:[{...review,record_id:records[1]!.record_id,expected_hash:stateHash('wrong')},review]};
  let indexes=0,flushes=0;const reindex=f.store.reindex.bind(f.store);f.store.reindex=()=>{indexes++;return reindex();};
  const result=captureBatchState(f.store,request,{flush:()=>{flushes++;return 'committed';}});
  assert.deepEqual(result.reviews?.map(r=>r.status),['refused','saved']);assert.equal(indexes,1);assert.equal(flushes,1);
  const retired=f.store.getRec('derived',records[0]!.record_id)!;
  assert.equal(retired.state,'stale');assert.equal(retired.content,records[0]!.record!.content);
  assert.deepEqual(retired.dependencies,records[0]!.record!.dependencies);assert.equal(retired.review?.by,'claude@david');
  assert.match(retired.content,/codex@david/);assert.doesNotMatch(JSON.stringify(retired),/Unrelated chatter/);
  const read=(subject:string)=>readState(f.store,{schema:'nuryel.state.read/1',scope,principal,subject}).response;
  assert.equal(read('event:42').state_of_record?.observed?.length,2);
  assert.deepEqual(read('customer:Site:7').state_of_record?.observed?.map(r=>r.id),[records[1]!.record_id]);
  const replay=captureBatchState(f.store,request);
  assert.equal(replay.reviews?.[1]?.status==='saved'&&replay.reviews[1].result.outcome,'replayed');assert.equal(indexes,1);
  const ledger=readLedger(join(f.root,'.hunch'),scope);
  assert.ok(ledger.events.some(e=>e.record_id===retired.id&&e.change==='invalidated'&&e.cause?.kind==='external'));
  const badSources=[{ref:{...ref,object_key:'other'},source_text:current},{ref,source_text:statements.join(' ')},{ref:{...ref,content_hash:stateHash('incorrect')},source_text:current}];
  for(const source of badSources){const rejected=captureBatchState(f.store,{...request,observations:[],sources:[source],reviews:[review]});assert.equal(rejected.reviews?.[0]?.status,'refused');}
  assert.throws(()=>captureBatchState(f.store,{...request,principal:{...principal,grants:[{kind:'user',id:'stranger'}]}}),/grants/);
 }finally{f.cleanup();}
});
