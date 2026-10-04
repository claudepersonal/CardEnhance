import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const compiled=ts.transpileModule(fs.readFileSync(new URL('../src/lib/yolo-geometry.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {letterboxGeometry,unletterboxBox}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('portrait letterbox uses centered padding consistent with YOLO training',()=>{
 assert.deepEqual(letterboxGeometry(400,800),{scale:.8,width:320,height:640,padX:160,padY:0});
 assert.deepEqual(unletterboxBox({x:170,y:20,w:300,h:600},letterboxGeometry(400,800),400,800),{x:12.5,y:25,w:375,h:750});
});
test('landscape decoding removes vertical padding and clips to real image',()=>{
 const geometry=letterboxGeometry(800,400);
 assert.deepEqual(unletterboxBox({x:0,y:150,w:640,h:340},geometry,800,400),{x:0,y:0,w:800,h:400});
 assert.equal(unletterboxBox({x:0,y:0,w:640,h:30},geometry,800,400),null);
 assert.equal(unletterboxBox({x:NaN,y:160,w:640,h:320},geometry,800,400),null);
});
