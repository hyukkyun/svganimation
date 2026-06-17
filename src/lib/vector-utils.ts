import SVGPathCommander from 'svg-path-commander';

export interface Point {
  x: number;
  y: number;
}

export type PathSegment = any[]; // From svg-path-commander

export interface PathState {
  segments: PathSegment[];
  stroke: string;
  strokeWidth: number;
  fill: string;
  pointStyle: 'circle' | 'square' | 'diamond';
}

export function parsePath(d: string): PathSegment[] {
  const commander = new SVGPathCommander(d);
  const segments = (commander.normalize().toAbsolute() as any).segments as PathSegment[];
  
  // Clean up duplicate points (e.g. L points that exactly overlap with the previous point, or closing points)
  const cleaned: PathSegment[] = [];
  let subpathStartX = 0;
  let subpathStartY = 0;
  let prevX = 0;
  let prevY = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg[0] === 'M') {
      subpathStartX = seg[1] as number;
      subpathStartY = seg[2] as number;
      prevX = subpathStartX;
      prevY = subpathStartY;
      cleaned.push([...seg] as PathSegment);
    } else if (seg[0] === 'Z') {
      // If the preceding path segment ends exactly where M started, and it's an L or C, 
      // we could remove it. However, if it's L, it's definitely redundant before Z.
      const lastCleaned = cleaned[cleaned.length - 1];
      if (lastCleaned && lastCleaned[0] === 'L') {
        const lx = lastCleaned[1] as number;
        const ly = lastCleaned[2] as number;
        if (Math.abs(lx - subpathStartX) < 0.001 && Math.abs(ly - subpathStartY) < 0.001) {
          cleaned.pop(); // Remove redundant L before Z
        }
      } else if (lastCleaned && lastCleaned[0] === 'C') {
         const cx = lastCleaned[5] as number;
         const cy = lastCleaned[6] as number;
         // Sometimes C ends at the exact origin, we keep C because removing C breaks curves
      }
      cleaned.push(['Z']);
    } else {
      const type = seg[0];
      const endX = seg[seg.length - 2] as number;
      const endY = seg[seg.length - 1] as number;
      
      // If it's an L segment and it doesn't move from previous point, skip it
      if (type === 'L' && Math.abs(endX - prevX) < 0.001 && Math.abs(endY - prevY) < 0.001) {
         continue; 
      }
      
      cleaned.push([...seg] as PathSegment);
      prevX = endX;
      prevY = endY;
    }
  }

  return cleaned;
}

export function stringifyPath(segments: PathSegment[]): string {
  // Ultra-fast simple string builder for performance during dragging
  let d = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    d += seg[0] + ' ' + seg.slice(1).join(' ') + ' ';
  }
  return d.trim();
}

export function fitSegmentsToCanvas(segments: PathSegment[], targetSize = 250, cx = 150, cy = 150): PathSegment[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  segments.forEach(seg => {
    for (let i = 1; i < seg.length; i += 2) {
      const x = seg[i] as number;
      const y = seg[i+1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  });

  const width = maxX - minX;
  const height = maxY - minY;
  
  if (width === 0 && height === 0 || !isFinite(width)) return segments;

  const scale = Math.min(targetSize / Math.max(0.001, width), targetSize / Math.max(0.001, height));
  const currentCx = minX + width / 2;
  const currentCy = minY + height / 2;

  return segments.map(seg => {
    const newSeg = [seg[0]];
    for (let i = 1; i < seg.length; i += 2) {
      const x = seg[i] as number;
      const y = seg[i+1] as number;
      newSeg.push((x - currentCx) * scale + cx);
      newSeg.push((y - currentCy) * scale + cy);
    }
    return newSeg as PathSegment;
  });
}
export function getBoundingBox(segments: PathSegment[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  segments.forEach(seg => {
    for (let i = 1; i < seg.length; i += 2) {
      const x = seg[i] as number;
      const y = seg[i+1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  });
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function scaleSegments(segments: PathSegment[], targetWidth: number): PathSegment[] {
  const bbox = getBoundingBox(segments);
  if (bbox.width === 0 || !isFinite(bbox.width)) return segments;
  
  const scale = targetWidth / bbox.width;
  const currentCx = bbox.minX + bbox.width / 2;
  const currentCy = bbox.minY + bbox.height / 2;

  // We scale out from the center
  return segments.map(seg => {
    const newSeg = [seg[0]];
    for (let i = 1; i < seg.length; i += 2) {
      const x = seg[i] as number;
      const y = seg[i+1] as number;
      newSeg.push((x - currentCx) * scale + currentCx);
      newSeg.push((y - currentCy) * scale + currentCy);
    }
    return newSeg as PathSegment;
  });
}

export function lerpSegments(segA: PathSegment[], segB: PathSegment[], t: number): PathSegment[] {
  if (segA.length !== segB.length) return Math.round(t) === 0 ? segA : segB; // Fallback if structures differ

  let prevAx = 0, prevAy = 0;
  let prevBx = 0, prevBy = 0;

  return segA.map((aOrig, i) => {
    let a = aOrig;
    let bOrig = segB[i];
    let b = bOrig;

    if (a[0] === 'L' && b[0] === 'C') {
       a = ['C', 
         prevAx + ((a[1] as number) - prevAx) / 3, prevAy + ((a[2] as number) - prevAy) / 3,
         prevAx + ((a[1] as number) - prevAx) * 2 / 3, prevAy + ((a[2] as number) - prevAy) * 2 / 3,
         a[1], a[2]
       ];
    } else if (a[0] === 'C' && b[0] === 'L') {
       b = ['C',
         prevBx + ((b[1] as number) - prevBx) / 3, prevBy + ((b[2] as number) - prevBy) / 3,
         prevBx + ((b[1] as number) - prevBx) * 2 / 3, prevBy + ((b[2] as number) - prevBy) * 2 / 3,
         b[1], b[2]
       ];
    } else if (a[0] !== b[0]) {
       // Commands differ, can't easily lerp
       return Math.round(t) === 0 ? aOrig : bOrig;
    }

    const result = [a[0]];
    for (let j = 1; j < a.length; j++) {
      const valA = a[j] as number;
      const valB = b[j] as number;
      result.push(valA + (valB - valA) * t);
    }
    
    if (aOrig.length > 2) {
      prevAx = aOrig[aOrig.length - 2] as number;
      prevAy = aOrig[aOrig.length - 1] as number;
    }
    if (bOrig.length > 2) {
      prevBx = bOrig[bOrig.length - 2] as number;
      prevBy = bOrig[bOrig.length - 1] as number;
    }

    return result as PathSegment;
  });
}
