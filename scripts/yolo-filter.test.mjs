import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
const server = await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
let api;
try { api = await server.ssrLoadModule('/src/lib/yolo.ts'); } finally { await server.close(); }
test('fine-tuned card detector accepts full-frame scans while COCO stays conservative', () => {
  const card = {x:0,y:0,w:400,h:600,score:.95,classId:0,label:'card'};
  assert.ok(api.cardFitnessSheet(card,400,600,true) > .22);
  assert.equal(api.cardFitnessSheet({...card,label:'person'},400,600,false), 0);
  assert.equal(api.cardFitnessSheet({...card,classId:73,label:'book'},400,600,false), 0);
});
test('decode clips both edges instead of shifting a box that crosses the image boundary', () => {
  const [box] = api.decodeYoloOutput({data:new Float32Array([20,100,60,100,.95]),dims:[1,1,5]},1,640,640,true);
  assert.equal(box.x, 0);
  assert.equal(box.w, 50);
  assert.equal(box.y, 50);
  assert.equal(box.h, 100);
});
