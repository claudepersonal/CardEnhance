import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
const server = await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
let api;
try { api = await server.ssrLoadModule('/src/lib/identify.ts'); } finally { await server.close(); }

test('sports card parser keeps product specificity and the original transcription', () => {
  const text = '2024 BOWMAN CHROME\nSHOHEI OHTANI\n#BCP-12\n15/50';
  const result = api.parseCardText(text);
  assert.equal(result.player, 'Shohei Ohtani');
  assert.equal(result.set, 'Bowman Chrome');
  assert.equal(result.number, 'BCP-12');
  assert.equal(result.rawText, text);
});
test('vintage years, accented names and one-of-one serials survive parsing', () => {
  const vintage = api.parseCardText('1952 TOPPS\nMICKEY MANTLE\n#311');
  assert.equal(vintage.year, 1952);
  const accented = api.parseCardText('2024 TOPPS CHROME\nJOSÉ RAMÍREZ\n01/01');
  assert.equal(accented.player, 'José Ramírez');
  assert.equal(accented.parallel, '01/01');
  assert.equal(api.parseCardText('2024 TOPPS\nMIKE TROUT\n1234/9999').parallel, '1234/9999');
  assert.equal(api.parseCardText('2024 TOPPS\nMIKE TROUT\n200/99').parallel, undefined);
});
test('filename hints cannot become OCR readings or measured confidence', async () => {
  const result = await api.identifyCard({}, 'mina-shirakawa-dazzlers.jpg');
  assert.equal(result.identity.player, null);
  assert.equal(result.identity.ocr.status, 'MISSING');
  assert.equal(result.identity.ocr.confidence, null);
  assert.equal(result.identity.filenameHints.player, 'Mina Shirakawa');
});
test('printed card numbers outrank ordinary hyphenated product text', () => {
  assert.equal(api.parseCardText('2024 O-Pee-Chee\nSIDNEY CROSBY\n#87').number, '87');
  assert.equal(api.parseCardText('2024 TOPPS CHROME\nMIKE TROUT\nALL-STAR\nNo. 27').number, '27');
  assert.equal(api.parseCardText('2024 TOPPS\nMIKE TROUT\nALL-STAR').number, undefined);
  assert.equal(api.parseCardText('2024 TOPPS\nMIKE TROUT\n#SW-AB').number, 'SW-AB');
  assert.equal(api.parseCardText('2024 TOPPS\nMIKE TROUT\nBCP-12').number, 'BCP-12');
});
test('OCR retries until the same required fields used by review are ready', () => {
  const pass = text => ({text, confidence:95, variant:'original',rotation:0,lines:[]});
  assert.equal(api.isOcrPassReady(pass('2024 TOPPS\nMIKE TROUT'),80), false);
  assert.equal(api.isOcrPassReady(pass('TOPPS CHROME\nMIKE TROUT'),80), false);
  assert.equal(api.isOcrPassReady(pass('2024 TOPPS CHROME\nMIKE TROUT'),80), true);
  assert.equal(api.isOcrPassReady({...pass('2024 TOPPS CHROME\nMIKE TROUT'),confidence:40},80), false);
});
