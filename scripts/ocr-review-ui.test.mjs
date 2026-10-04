import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
const server = await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
let api;
try { api = await server.ssrLoadModule('/src/components/studio/compare-view.tsx'); } finally { await server.close(); }
const render = identity => renderToStaticMarkup(createElement(api.IdentityChips,{identity,cropped:false}));
test('preview renders a measured zero OCR score', () => {
  assert.match(render({confidence:0,ocr:{confidence:0}}),/OCR score 0 \/ 100/);
});
test('preview never labels legacy identity confidence as measured OCR evidence', () => {
  assert.doesNotMatch(render({confidence:.95}),/OCR score/);
  assert.doesNotMatch(render({confidence:.95,ocr:{confidence:null}}),/OCR score/);
});
