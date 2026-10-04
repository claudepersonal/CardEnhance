import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/ocr-quality.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { confidenceStatus, assessOcr, aggregateConfidence, selectOcrPass, recognitionSize, boundingBoxStatus } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('confidence rule handles missing, invalid and exact threshold values', () => {
  for (const [value, expected] of [[null,'MISSING'],[undefined,'MISSING'],['','MISSING'],['80','INVALID'],[NaN,'INVALID'],[Infinity,'INVALID'],[-1,'INVALID'],[101,'INVALID'],[0,'REVIEW'],[79.999,'REVIEW'],[80,'READY'],[100,'READY']]) {
    assert.equal(confidenceStatus(value, 80), expected, String(value));
  }
  assert.throws(() => confidenceStatus(90, NaN), /threshold/i);
});
test('low-scoring line cannot be hidden by a high-scoring short word', () => {
  assert.equal(aggregateConfidence([{text:'GOLD', confidence:99},{text:'PLAYER NAME',confidence:20}]), (4*99+10*20)/14);
  assert.equal(aggregateConfidence([{text:'',confidence:90}]), null);
  assert.equal(aggregateConfidence([{text:'NAME',confidence:NaN}]), null);
});
test('coverage never overrides low OCR confidence and vision is unmeasured', () => {
  assert.equal(assessOcr(23.243149, 'printed name', [], 80).status, 'REVIEW');
  assert.equal(assessOcr(null, 'vision text', [], 80).status, 'MISSING');
  assert.equal(assessOcr(95, 'name', ['manufacturer'], 80).status, 'REVIEW');
  assert.equal(assessOcr(95, '', [], 80).status, 'MISSING');
  assert.equal(assessOcr(95, 'printed name', [], 80).status, 'READY');
});
test('selected OCR pass preserves raw text and orientation without merging contradictory passes', () => {
  const low = {variant:'original',rotation:0,text:'bad\nraw',confidence:10,lines:[]};
  const high = {variant:'rotated',rotation:180,text:'GOOD\nRAW',confidence:95,lines:[]};
  const selected = selectOcrPass([low,high], () => 0);
  assert.equal(selected, high);
  assert.equal(selected.text, 'GOOD\nRAW');
  assert.equal(selectOcrPass([], () => 0), null);
});
test('long line preprocessing preserves aspect ratio instead of squeezing to 320 pixels', () => {
  assert.deepEqual(recognitionSize(1000,50,48,320), {width:320,height:16,paddedWidth:320});
  assert.deepEqual(recognitionSize(100,50,48,320), {width:96,height:48,paddedWidth:96});
});

test('bounding boxes must agree with their coordinate columns', () => {
  const good = {left:184,top:376,width:83,height:20,bbox:'(184,376,267,396)'};
  assert.equal(boundingBoxStatus(good), 'OK');
  assert.equal(boundingBoxStatus({...good,bbox:'(184,376,268,396)'}), 'CHECK');
  assert.equal(boundingBoxStatus({...good,width:0}), 'CHECK');
  assert.equal(boundingBoxStatus({...good,left:-1}), 'CHECK');
  assert.equal(boundingBoxStatus({...good,bbox:'bad'}), 'CHECK');
});
