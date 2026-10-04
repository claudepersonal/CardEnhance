/** Centered letterbox geometry shared with the Ultralytics model export contract. */
export function letterboxGeometry(width: number, height: number, input = 640) {
  if (![width,height,input].every(v => Number.isFinite(v) && v > 0)) throw new RangeError('Invalid image dimensions');
  const scale = input / Math.max(width,height);
  const w = Math.max(1,Math.round(width*scale)), h = Math.max(1,Math.round(height*scale));
  return {scale,width:w,height:h,padX:Math.floor((input-w)/2),padY:Math.floor((input-h)/2)};
}

export function unletterboxBox(box: {x:number;y:number;w:number;h:number}, geometry: ReturnType<typeof letterboxGeometry>, width:number, height:number) {
  if (![box.x,box.y,box.w,box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return null;
  const x = Math.max(0,(box.x-geometry.padX)/geometry.scale);
  const y = Math.max(0,(box.y-geometry.padY)/geometry.scale);
  const right = Math.min(width,(box.x+box.w-geometry.padX)/geometry.scale);
  const bottom = Math.min(height,(box.y+box.h-geometry.padY)/geometry.scale);
  if (right <= x || bottom <= y) return null;
  return {x,y,w:right-x,h:bottom-y};
}
