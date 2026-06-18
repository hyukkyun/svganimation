import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { User, signOut } from 'firebase/auth';
import { collection, query, orderBy, getDocs, setDoc, deleteDoc, doc } from 'firebase/firestore';
import { auth, db } from './firebase';
import AdminPanel from './AdminPanel';
import { 
  Upload, 
  Settings2, 
  Play, 
  Square, 
  Circle, 
  Diamond,
  Trash2,
  Download,
  MousePointer2,
  RefreshCcw,
  Layers,
  Hand,
  Search,
  Maximize2,
  ZoomIn,
  ZoomOut,
  Video,
  Loader2,
  Undo2,
  Redo2,
  LogOut,
  UserCircle,
  ShieldAlert
} from 'lucide-react';
import { cn } from './lib/utils';
import { parsePath, stringifyPath, lerpSegments, fitSegmentsToCanvas, getBoundingBox, scaleSegments, PathState, PathSegment } from './lib/vector-utils';
import { animate } from 'framer-motion';
import * as Mp4Muxer from 'mp4-muxer';

interface CornerPoint {
  sIdx: number;
  pX: number; pY: number;
  prevX: number; prevY: number;
  nextX: number; nextY: number;
  zIdx: number;
  isStartM: boolean;
  isRoundedCurve?: boolean;
  curveIdx?: number;
  currentRadius?: number;
}

const findCorners = (segs: PathSegment[], includeAll = false): CornerPoint[] => {
  const corners: CornerPoint[] = [];
  let subpathStartIdx = 0;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg[0] === 'M') {
      subpathStartIdx = i;
    }
    
    // Check if this segment is a 'C' that mathematically forms a perfect rounded corner
    if (seg[0] === 'C' && i > 0) {
      const prevSeg = segs[i - 1];
      if (prevSeg[0] === 'L' || prevSeg[0] === 'M') {
        const P1x = prevSeg[prevSeg.length - 2] as number;
        const P1y = prevSeg[prevSeg.length - 1] as number;
        const C1x = seg[1] as number; const C1y = seg[2] as number;
        const C2x = seg[3] as number; const C2y = seg[4] as number;
        const P2x = seg[5] as number; const P2y = seg[6] as number;

        const V1x = C1x - P1x; const V1y = C1y - P1y;
        const V2x = C2x - P2x; const V2y = C2y - P2y;
        
        const drX = P2x - P1x; const drY = P2y - P1y;
        const det = V1x * V2y - V1y * V2x;

        if (Math.abs(det) > 0.001) {
          const t = (drX * V2y - drY * V2x) / det;
          const u = (drX * V1y - drY * V1x) / det;
          
          if (t > 0 && u > 0) {
            const Bx = P1x + t * V1x;
            const By = P1y + t * V1y;
            
            const dist1 = Math.sqrt(Math.pow(P1x - Bx, 2) + Math.pow(P1y - By, 2));
            const dist2 = Math.sqrt(Math.pow(P2x - Bx, 2) + Math.pow(P2y - By, 2));
            
            if (Math.abs(dist1 - dist2) < 2) {
              const actualD = (dist1 + dist2) / 2;
              const len1 = Math.sqrt(V1x*V1x + V1y*V1y);
              const len2 = Math.sqrt(V2x*V2x + V2y*V2y);
              
              const uX = (P1x - Bx) / actualD; const uY = (P1y - By) / actualD;
              const vX = (P2x - Bx) / actualD; const vY = (P2y - By) / actualD;
              const dot = uX * vX + uY * vY;
              const alpha = Math.acos(Math.max(-1, Math.min(1, dot)));
              const expectedL = actualD * (4/3) * Math.tan((Math.PI - alpha) / 4);
              
              if (Math.abs(len1 - expectedL) < 2 && Math.abs(len2 - expectedL) < 2) {
                // It's a pristine rounded corner! Reconstruct the sharp corner point.
                let Ax = 0, Ay = 0;
                let AId = i - 2;
                if (AId >= 0) {
                  Ax = segs[AId][segs[AId].length - 2] as number;
                  Ay = segs[AId][segs[AId].length - 1] as number;
                }
                let nextX = 0, nextY = 0;
                if (i + 1 < segs.length) {
                  const nSeg = segs[i + 1];
                  if (nSeg[0] === 'Z') {
                    const afterMSeg = segs[subpathStartIdx + 1];
                    if (afterMSeg) {
                      nextX = afterMSeg[afterMSeg.length - 2] as number;
                      nextY = afterMSeg[afterMSeg.length - 1] as number;
                    }
                  } else if (nSeg[0] !== 'Z' && nSeg[0] !== 'M') {
                    nextX = nSeg[nSeg.length - 2] as number;
                    nextY = nSeg[nSeg.length - 1] as number;
                  }
                } else if (segs[0][0] === 'M') {
                  nextX = segs[0][1] as number;
                  nextY = segs[0][2] as number;
                }
                
                corners.push({
                  sIdx: i - 1, // Point it to the preceding L segment so applyCornerRadius can overwrite it
                  pX: Bx, pY: By,
                  prevX: Ax, prevY: Ay,
                  nextX: nextX, nextY: nextY,
                  zIdx: -1,
                  isStartM: false, // In live corners, we've already lost the StartM topological complexity.
                  isRoundedCurve: true,
                  curveIdx: i,
                  currentRadius: actualD
                });
                continue;
              }
            }
          }
        }
      }
    }

    if (seg[0] !== 'M' && seg[0] !== 'L') continue;
    
    const B = { x: seg[seg.length-2] as number, y: seg[seg.length-1] as number };
    
    // Point A (Previous)
    let A = null;
    let prevIsCurve = false;
    if (i > subpathStartIdx) {
      const prevSeg = segs[i-1];
      if (prevSeg[0] === 'C') prevIsCurve = true;
      // Use the last coordinate of the previous segment as A
      A = { x: prevSeg[prevSeg.length-2] as number, y: prevSeg[prevSeg.length-1] as number };
    } else {
      // Start of subpath: Check for 'Z' to see if it's closed
      let zIdxLocal = -1;
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[j][0] === 'M') break;
        if (segs[j][0] === 'Z') { zIdxLocal = j; break; }
      }
      if (zIdxLocal !== -1) {
         // The point before 'M' in a closed path is the end of the segment before 'Z'
         const lastSeg = segs[zIdxLocal - 1];
         if (lastSeg[0] === 'C') prevIsCurve = true;
         A = { x: lastSeg[lastSeg.length-2] as number, y: lastSeg[lastSeg.length-1] as number };
      }
    }
    
    // Point C (Next)
    let C = null;
    let nextIsCurve = false;
    if (i < segs.length - 1) {
      const nextSeg = segs[i+1];
      if (nextSeg[0] === 'C') nextIsCurve = true;
      if (nextSeg[0] !== 'Z' && nextSeg[0] !== 'M') {
        C = { x: nextSeg[nextSeg.length-2] as number, y: nextSeg[nextSeg.length-1] as number };
      } else if (nextSeg[0] === 'Z') {
        const mSeg = segs[subpathStartIdx];
        C = { x: mSeg[1] as number, y: mSeg[2] as number };
      }
    }

    // Skip if this anchor point is ALREADY starting a curve.
    // We allow it if prevIsCurve is true, as a sharp corner can follow a curve.
    if (nextIsCurve) continue;
    
    // For the very first 'M' point in a closed path, check if it's already rounded at the end of the loop
    if (seg[0] === 'M') {
      let zIdxLocal = -1;
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[j][0] === 'M') break;
        if (segs[j][0] === 'Z') { zIdxLocal = j; break; }
      }
      if (zIdxLocal !== -1 && segs[zIdxLocal - 1][0] === 'C') {
         // Is this C actually the rounded StartM, or just the previous corner's rounding?
         // If it's the rounded StartM, its end point should match the M point
         const cSeg = segs[zIdxLocal - 1];
         const mSeg = segs[i];
         const cEndX = cSeg[5] as number;
         const cEndY = cSeg[6] as number;
         const mX = mSeg[1] as number;
         const mY = mSeg[2] as number;
         if (Math.abs(cEndX - mX) < 0.1 && Math.abs(cEndY - mY) < 0.1) {
            continue; // It truly is the rounded StartM, skip sharp check
         }
      }
    }
    
    if (A && C) {
       const isCollinearSafe = (Math.abs(B.x - A.x) > 0.1 || Math.abs(B.y - A.y) > 0.1) && (Math.abs(B.x - C.x) > 0.1 || Math.abs(B.y - C.y) > 0.1);
       if (isCollinearSafe || includeAll) {
         // Vector AB and BC
         const ux = A.x - B.x; const uy = A.y - B.y;
         const vx = C.x - B.x; const vy = C.y - B.y;
         const magU = Math.max(0.000001, Math.sqrt(ux*ux + uy*uy));
         const magV = Math.max(0.000001, Math.sqrt(vx*vx + vy*vy));
         
         // Calculate angle to filter out collinear points
         const dot = (ux*vx + uy*vy) / (magU * magV);
         const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
         
         // If angle is near PI, it's a straight line, not a corner
         if (angle < Math.PI - 0.01 || includeAll) {
            corners.push({
              sIdx: i,
              pX: B.x, pY: B.y,
              prevX: A.x, prevY: A.y,
              nextX: C.x, nextY: C.y,
              zIdx: -1,
              isStartM: i === subpathStartIdx
            });
         }
       }
    }
  }
  
  corners.forEach(c => {
    if (c.isStartM) {
      for (let j = c.sIdx + 1; j < segs.length; j++) {
         if (segs[j][0] === 'M') break;
         if (segs[j][0] === 'Z') { c.zIdx = j; break; }
      }
    }
  });

  return corners;
};

const applyCornerRadius = (segs: PathSegment[], corner: CornerPoint, d: number, forceTopology = false): PathSegment[] => {
   if (d <= 0.1 && !forceTopology && !corner.isRoundedCurve) return segs;
   
   const newSegs = segs.map(s => [...s] as PathSegment);
   
   let targetA = { x: corner.prevX, y: corner.prevY };
   let targetB = { x: corner.pX, y: corner.pY };
   let targetC = { x: corner.nextX, y: corner.nextY };
   let currentSIdx = corner.sIdx;
   let currentZIdx = corner.zIdx;

   if (forceTopology) {
     const allCorners = findCorners(segs, true);
     // Use a stable proximity match to find the same corner in the current topology
     let matched = allCorners.find(c => c.sIdx === corner.sIdx);
     if (!matched) {
       matched = allCorners.find(c => Math.abs(c.pX - corner.pX) < 2 && Math.abs(c.pY - corner.pY) < 2);
     }
     if (matched) {
       // We keep the original target points from the 'corner' object passed in 
       // to prevent drifting, but we need the current indices
       currentSIdx = matched.sIdx;
       currentZIdx = matched.zIdx;
     } else {
       return segs;
     }
   }
   
   const B = targetB;
   const A = targetA;
   const C = targetC;
   
   const ux = A.x - B.x; const uy = A.y - B.y;
   const vx = C.x - B.x; const vy = C.y - B.y;
   const lenU = Math.sqrt(ux*ux + uy*uy);
   const lenV = Math.sqrt(vx*vx + vy*vy);
   
   if ((lenU < 0.1 || lenV < 0.1) && !forceTopology) return segs;

   const safeLenU = Math.max(lenU, 0.000001);
   const safeLenV = Math.max(lenV, 0.000001);

   const u = { x: ux / safeLenU, y: uy / safeLenU };
   const v = { x: vx / safeLenV, y: vy / safeLenV };

   const maxD = Math.min(lenU, lenV) * 0.99; // Almost the full length
   const actualD = Math.max(0, Math.min(d, maxD));

   const B1 = { x: B.x + actualD * u.x, y: B.y + actualD * u.y };
   const B2 = { x: B.x + actualD * v.x, y: B.y + actualD * v.y };

   const dot = u.x * v.x + u.y * v.y;
   const alpha = Math.acos(Math.max(-1, Math.min(1, dot)));
   const l = actualD * (4/3) * Math.tan((Math.PI - alpha) / 4);

   const C1 = { x: B1.x - l * u.x, y: B1.y - l * u.y };
   const C2 = { x: B2.x - l * v.x, y: B2.y - l * v.y };

   if (corner.isStartM) {
      newSegs[currentSIdx] = ['M', B2.x, B2.y];
      if (currentZIdx !== -1) {
         // Dynamically find Z command to prevent index shifting issues
         let dynamicZIdx = currentSIdx + 1;
         for (; dynamicZIdx < newSegs.length; dynamicZIdx++) {
            if (newSegs[dynamicZIdx][0] === 'Z' || newSegs[dynamicZIdx][0] === 'M') break;
         }
         
         const curveSeq = [
            ['L', B1.x, B1.y],
            ['C', C1.x, C1.y, C2.x, C2.y, B2.x, B2.y]
         ] as PathSegment[];
         newSegs.splice(dynamicZIdx, 0, ...curveSeq);
      }
   } else {
      const curve = ['C', C1.x, C1.y, C2.x, C2.y, B2.x, B2.y] as PathSegment;
      
      if (corner.isRoundedCurve && corner.curveIdx !== undefined) {
         if (d <= 0.1 && !forceTopology) {
            newSegs.splice(corner.curveIdx, 1);
            newSegs[currentSIdx] = [newSegs[currentSIdx][0], corner.pX, corner.pY];
         } else {
            newSegs[currentSIdx] = [newSegs[currentSIdx][0], B1.x, B1.y];
            newSegs[corner.curveIdx] = curve;
         }
      } else {
         newSegs[currentSIdx] = [newSegs[currentSIdx][0], B1.x, B1.y];
         newSegs.splice(currentSIdx + 1, 0, curve);
      }
   }
   
   return newSegs;
};

const PathWidthModifier = ({ segments, onApply }: { segments: PathSegment[], onApply: (w: number) => void }) => {
  const [localWidth, setLocalWidth] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  
  useEffect(() => {
    if (isFocused) return; // Allow user to type without interruption
    const bbox = getBoundingBox(segments);
    const w = Math.round(bbox.width);
    // Don't update if nothing renders or width is not valid
    if (w <= 0 || !isFinite(w)) return;
    setLocalWidth(w.toString());
  }, [segments, isFocused]);

  const handleApply = () => {
    setIsFocused(false);
    let w = parseInt(localWidth);
    
    // Fallback if empty or invalid
    if (isNaN(w) || w <= 0) {
      const bbox = getBoundingBox(segments);
      setLocalWidth(Math.round(bbox.width).toString());
      return;
    }
    
    if (w < 200) w = 200;
    if (w > 999) w = 999;
    
    setLocalWidth(w.toString());
    onApply(w);
  };

  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-text-dim/80">Path Width</span>
      <div className="flex items-center gap-1">
        <input 
           type="number" 
           min={200} max={999}
           value={localWidth}
           onFocus={() => setIsFocused(true)}
           onChange={e => setLocalWidth(e.target.value)}
           onBlur={handleApply}
           onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
           className="w-16 bg-background border border-border rounded px-2 h-6 text-xs text-right font-mono text-text outline-none focus:border-accent appearance-none"
        />
        <span className="text-xs text-text-dim">px</span>
      </div>
    </div>
  );
};

const DEFAULT_PATH = 'M 50 50 L 250 50 L 250 250 L 50 250 Z';

const DEFAULT_PATH_SCALED = scaleSegments(parsePath(DEFAULT_PATH), 300);

export interface GuideLine {
  id: string;
  type: 'vertical' | 'horizontal';
  position: number;
}

const ColorInput = ({ label, value, onChange }: { label: string, value: string, onChange: (v: string) => void }) => {
  const [localVal, setLocalVal] = useState(value);
  
  useEffect(() => {
    setLocalVal(value);
  }, [value]);

  const handleBlur = () => {
    let v = localVal.trim();
    if (v.startsWith('#') && v.length === 4) {
      v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(v)) {
      v = '#000000';
    }
    setLocalVal(v);
    onChange(v);
  };
  
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex items-center gap-1.5 focus-within:ring-1 focus-within:ring-accent rounded transition-all">
        <input 
          type="color" 
          value={value} 
          onChange={(e) => onChange(e.target.value)}
          className="w-6 h-6 rounded border border-border cursor-pointer appearance-none bg-transparent flex-shrink-0"
        />
        <input 
          type="text" 
          value={localVal}
          onChange={(e) => setLocalVal(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="w-[64px] bg-background border border-border rounded px-1.5 h-6 text-xs font-mono text-text outline-none focus:border-accent"
        />
      </div>
    </div>
  );
};

export default function App({ user }: { user?: User }) {
  const [uiTheme, setUiTheme] = useState<'dark' | 'light' | 'notion' | 'retro'>('dark');
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', uiTheme);
  }, [uiTheme]);

  const [segments, setSegments] = useState<PathSegment[]>(DEFAULT_PATH_SCALED);
  const [initialImportedPath, setInitialImportedPath] = useState<PathSegment[]>(DEFAULT_PATH_SCALED);
  const [keyframes, setKeyframes] = useState<PathSegment[][]>([DEFAULT_PATH_SCALED]);
  const [keyframeTimes, setKeyframeTimes] = useState<number[]>([0]);
  
  type ConfigSettings = {
    stroke: string;
    strokeWidth: number;
    fill: string;
    fillOpacity: number;
    canvasBg: string;
    pointStyle: 'circle' | 'square' | 'i-shape';
    handleStyle: 'circle' | 'square' | 'x-shape' | 'i-shape';
    anchorSize: number;
    anchorColor: string;
    anchorStrokeColor: string;
    anchorFillOpacity: number;
    handleSize: number;
    handleColor: string;
    handleFillOpacity: number;
    handleLineColor: string;
    handleLineWidth: number;
    guideColor: string;
    guideThickness: number;
    guideZIndex: 'front' | 'back';
    snapToGuides: boolean;
  };

  type HistoryState = {
    keyframes: PathSegment[][][];
    keyframeTimes: number[];
    activeKeyIdx: number;
    settings: ConfigSettings;
  };
  const initialSettings: ConfigSettings = {
    stroke: '#eeeeee', strokeWidth: 1, fill: '#000000', fillOpacity: 1, canvasBg: '#111111',
    pointStyle: 'square', handleStyle: 'circle', anchorSize: 3, anchorColor: '#111111',
    anchorStrokeColor: '#eeeeee', anchorFillOpacity: 1, handleSize: 2, handleColor: '#111111',
    handleFillOpacity: 1, handleLineColor: '#eeeeee', handleLineWidth: 1, guideColor: '#ffeb3b',
    guideThickness: 1, guideZIndex: 'back', snapToGuides: true
  };

  const [history, setHistory] = useState<HistoryState[]>([{
    keyframes: [DEFAULT_PATH_SCALED],
    keyframeTimes: [0],
    activeKeyIdx: 0,
    settings: initialSettings,
  }]);

  const [historyPtr, setHistoryPtr] = useState(0);
  const [activeKeyIdx, setActiveKeyIdx] = useState(0);
  
  const [stroke, setStroke] = useState('#eeeeee');
  const [strokeWidth, setStrokeWidth] = useState(1);
  const [fill, setFill] = useState('#000000');
  const [fillOpacity, setFillOpacity] = useState(1);
  const [canvasBg, setCanvasBg] = useState('#111111');
  const [pointStyle, setPointStyle] = useState<'circle' | 'square' | 'i-shape'>('square');
  const [handleStyle, setHandleStyle] = useState<'circle' | 'square' | 'x-shape' | 'i-shape'>('circle');
  
  // Customization settings
  const [anchorSize, setAnchorSize] = useState(3);
  const [anchorColor, setAnchorColor] = useState('#111111');
  const [anchorStrokeColor, setAnchorStrokeColor] = useState('#eeeeee');
  const [anchorFillOpacity, setAnchorFillOpacity] = useState(1);
  const [handleSize, setHandleSize] = useState(2);
  const [handleColor, setHandleColor] = useState('#111111');
  const [handleFillOpacity, setHandleFillOpacity] = useState(1);
  const [handleLineColor, setHandleLineColor] = useState('#eeeeee');
  const [handleLineWidth, setHandleLineWidth] = useState(1);
  
  // Guides
  const [guides, setGuides] = useState<GuideLine[]>([]);
  const [guideColor, setGuideColor] = useState('#ffeb3b');
  const [guideThickness, setGuideThickness] = useState(1);
  const [guideZIndex, setGuideZIndex] = useState<'front' | 'back'>('back');
  const [snapToGuides, setSnapToGuides] = useState(true);
  const SNAP_THRESHOLD = 8;
  const [activeGuide, setActiveGuide] = useState<string | null>(null);
  const [draggingGuide, setDraggingGuide] = useState<string | null>(null);
  
  const [isAnimating, setIsAnimating] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [activePoint, setActivePoint] = useState<{ sIdx: number; pIdx: number; startPos?: { x: number, y: number }, isSmooth?: boolean } | null>(null);
  const [selectedAnchors, setSelectedAnchors] = useState<number[]>([]);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  
  // Animation settings
  const [animDuration, setAnimDuration] = useState(2);
  const [animEasing, setAnimEasing] = useState('easeInOut');
  const [easingMode, setEasingMode] = useState<'global'|'local'>('local');
  const [showControlsDuringAnim, setShowControlsDuringAnim] = useState(true);
  const [animProgress, setAnimProgress] = useState(0);
  
  const [exportRes, setExportRes] = useState<'720p' | '1080p' | '2k' | '4k'>('1080p');
  const [exportFraming, setExportFraming] = useState<'auto' | 'viewport'>('auto');

  // Presets state
  const [presets, setPresets] = useState<{id: string; name: string; settings: ConfigSettings; createdAt: number}[]>([]);
  const [isPresetsLoading, setIsPresetsLoading] = useState(false);
  const [isSavingPreset, setIsSavingPreset] = useState(false);
  const [presetInputName, setPresetInputName] = useState('');
  const [presetError, setPresetError] = useState('');
  const [presetLoadError, setPresetLoadError] = useState('');

  const BUILTIN_PRESETS = [
    {
      id: 'builtin-default',
      name: '기본 프리셋',
      createdAt: 0,
      settings: initialSettings
    },
    {
      id: 'builtin-preset-2',
      name: '기본프리셋 2',
      createdAt: 1,
      settings: {
        ...initialSettings,
        canvasBg: '#36915b',
        fill: '#932ece',
        stroke: '#ffe600',
        anchorStrokeColor: '#ffe600',
        anchorColor: '#932ece',
        handleColor: '#ffe600',
        handleLineColor: '#ffe600',
        anchorSize: 1.8,
        handleLineWidth: 0.7,
        strokeWidth: 0.7,
        handleSize: 1.8,
        handleStyle: 'x-shape'
      }
    },
    {
      id: 'builtin-preset-3',
      name: '기본프리셋 3',
      createdAt: 2,
      settings: {
        ...initialSettings,
        canvasBg: '#fafafa',
        fill: '#fafafa',
        stroke: '#111111',
        anchorStrokeColor: '#111111',
        anchorColor: '#fafafa',
        handleColor: '#111111',
        handleLineColor: '#111111',
        guideColor: '#111111',
        anchorSize: 1.8,
        handleLineWidth: 0.8,
        strokeWidth: 0.8,
        handleSize: 2.5,
        pointStyle: 'i-shape',
        handleStyle: 'i-shape',
        guideThickness: 0.8
      }
    }
  ];

  useEffect(() => {
    if (!user) return;
    const loadPresets = async () => {
      setIsPresetsLoading(true);
      setPresetLoadError('');
      try {
        const snapshot = await getDocs(query(collection(db, 'users', user.uid, 'presets'), orderBy('createdAt', 'asc')));
        const loaded = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));
        setPresets(loaded);
      } catch (err: any) {
        console.error("Failed to load presets", err);
        setPresetLoadError(err.message || '알 수 없는 오류');
      } finally {
        setIsPresetsLoading(false);
      }
    };
    loadPresets();
  }, [user]);

  const handleSavePresetClick = () => {
    if (!user) return;
    if (presets.length >= 10) {
      alert("스타일 프리셋은 최대 10개까지 저장할 수 있습니다.");
      return;
    }
    setPresetInputName(`스타일 ${presets.length + 1}`);
    setPresetError('');
    setIsSavingPreset(true);
  };

  const confirmSavePreset = async () => {
    setPresetError('');
    if (!user) {
      setPresetError("로그인이 필요합니다.");
      setIsSavingPreset(false);
      return;
    }
    if (!presetInputName.trim()) {
      setPresetError("프리셋 이름을 입력해주세요.");
      return;
    }
    if (isPresetsLoading) return;

    setIsPresetsLoading(true);

    try {
      const currentSettings = getCurrentSettings();
      // Ensure all settings are defined
      Object.keys(currentSettings).forEach((key) => {
        if ((currentSettings as any)[key] === undefined) {
          throw new Error(`${key} is undefined in currentSettings`);
        }
      });
      
      const newPresetRef = doc(collection(db, 'users', user.uid, 'presets'));
      const presetData = {
        name: presetInputName.trim(),
        settings: currentSettings,
        createdAt: Date.now()
      };
      await setDoc(newPresetRef, presetData);
      setPresets(prev => [...prev, { id: newPresetRef.id, ...presetData }]);
      setIsSavingPreset(false);
      setPresetInputName('');
    } catch (err: any) {
      console.error('Preset save error:', err);
      setPresetError(`프리셋 저장 실패: ${err.message || '알 수 없음'}`);
    } finally {
      setIsPresetsLoading(false);
    }
  };

  const deletePreset = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm("정말로 이 프리셋을 삭제하시겠습니까?")) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'presets', id));
      setPresets(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      console.error(err);
      alert("삭제에 실패했습니다.");
    }
  };

  const applyPreset = (settings: ConfigSettings) => {
    applySettings(settings);
  };

  // Viewport state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<'select' | 'hand' | 'zoom'>('select');
  const [isDrawing, setIsDrawing] = useState(false);
  const [cornerDrag, setCornerDrag] = useState<{
    originalSegments: PathSegment[];
    originalKeyframes: PathSegment[][];
    keyframeIdx: number;
    corner: CornerPoint;
    dirX: number;
    dirY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  const liveSelectedAnchors = useMemo(() => {
    if (!cornerDrag) return selectedAnchors;
    if (segments.length === cornerDrag.originalSegments.length) return selectedAnchors;
    
    const isAddingCurve = segments.length > cornerDrag.originalSegments.length;
    const oldCorners = findCorners(cornerDrag.originalSegments).filter(c => 
        c.sIdx === cornerDrag.corner.sIdx || 
        (selectedAnchors.includes(cornerDrag.corner.sIdx) && selectedAnchors.includes(c.sIdx))
    );
    oldCorners.sort((a, b) => a.sIdx - b.sIdx);

    let updatedSelection: number[] = [];
    for (const oldIdx of selectedAnchors) {
        let offset = 0;
        for (const c of oldCorners) {
            if (c.sIdx < oldIdx) {
                offset += isAddingCurve ? (c.isStartM ? 2 : 1) : -1;
            }
        }
        const splitOrMergeCorner = oldCorners.find(c => c.sIdx === oldIdx || c.curveIdx === oldIdx);
        
        if (isAddingCurve) {
            if (splitOrMergeCorner && splitOrMergeCorner.sIdx === oldIdx) {
                updatedSelection.push(oldIdx + offset);
                if (splitOrMergeCorner.isStartM && splitOrMergeCorner.zIdx !== undefined) {
                    updatedSelection.push(splitOrMergeCorner.zIdx + offset);
                    updatedSelection.push(splitOrMergeCorner.zIdx + offset + 1);
                } else {
                    updatedSelection.push(oldIdx + offset + 1);
                }
            } else {
                updatedSelection.push(oldIdx + offset);
            }
        } else {
             // Removing curve
             if (splitOrMergeCorner) {
                 updatedSelection.push(splitOrMergeCorner.sIdx + (splitOrMergeCorner.sIdx < oldIdx ? offset + 1 : offset));
             } else {
                 updatedSelection.push(oldIdx + offset);
             }
        }
    }
    return [...new Set(updatedSelection)];
  }, [cornerDrag, segments.length, selectedAnchors]);

  const svgRef = useRef<SVGSVGElement>(null);
  const segmentsRef = useRef<PathSegment[]>(segments);
  const keyframesRef = useRef<PathSegment[][]>(keyframes);
  
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    keyframesRef.current = keyframes;
  }, [keyframes]);

  const centerView = () => {
    if (!svgRef.current || !contentRef.current || segments.length === 0) return;
    
    // Grab the actual bounding box by selecting only the path element to avoid infinite guides!
    const pathEl = contentRef.current.querySelector('path');
    if (!pathEl) return;
    const contentBBox = pathEl.getBBox();
    
    // Prevent errors if bounding box has no size (e.g. valid path but 0x0)
    if (!contentBBox || contentBBox.width === 0 || contentBBox.height === 0) return;

    const svgWidth = 300;
    const svgHeight = 300;
    
    const scale = Math.min(
      (svgWidth * 0.8) / contentBBox.width,
      (svgHeight * 0.8) / contentBBox.height
    );
    
    const finalScale = isFinite(scale) ? Math.min(Math.max(scale, 0.1), 5) : 1;
    
    setZoom(finalScale);
    setPan({
      x: (svgWidth / 2) - (contentBBox.x + contentBBox.width / 2) * finalScale,
      y: (svgHeight / 2) - (contentBBox.y + contentBBox.height / 2) * finalScale,
    });
  };

  const lastPushedSettingsRef = useRef(JSON.stringify(initialSettings));

  const getCurrentSettings = (): ConfigSettings => ({
    stroke, strokeWidth, fill, fillOpacity, canvasBg,
    pointStyle, handleStyle, anchorSize, anchorColor,
    anchorStrokeColor, anchorFillOpacity, handleSize,
    handleColor, handleFillOpacity, handleLineColor,
    handleLineWidth, guideColor, guideThickness,
    guideZIndex, snapToGuides
  });

  useEffect(() => {
    const currentSettingsStr = JSON.stringify(getCurrentSettings());
    if (currentSettingsStr !== lastPushedSettingsRef.current) {
      const timer = setTimeout(() => {
        const { keyframes, keyframeTimes, activeKeyIdx, pushHistory } = bindRef.current;
        pushHistory({ keyframes, keyframeTimes, activeKeyIdx });
        lastPushedSettingsRef.current = currentSettingsStr;
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [stroke, strokeWidth, fill, fillOpacity, canvasBg, pointStyle, handleStyle, anchorSize, anchorColor, anchorStrokeColor, anchorFillOpacity, handleSize, handleColor, handleFillOpacity, handleLineColor, handleLineWidth, guideColor, guideThickness, guideZIndex, snapToGuides]);

  const pushHistory = (newState: Omit<HistoryState, 'settings'> & { settings?: ConfigSettings }) => {
    const newHistory = history.slice(0, historyPtr + 1);
    const completeState: HistoryState = {
      ...newState,
      settings: newState.settings ?? getCurrentSettings()
    };
    newHistory.push(JSON.parse(JSON.stringify(completeState)));
    // Limit history size to 50
    if (newHistory.length > 50) newHistory.shift();
    setHistory(newHistory);
    setHistoryPtr(newHistory.length - 1);
    lastPushedSettingsRef.current = JSON.stringify(completeState.settings);
  };

  const applySettings = (s: ConfigSettings) => {
    lastPushedSettingsRef.current = JSON.stringify(s);
    setStroke(s.stroke); setStrokeWidth(s.strokeWidth); setFill(s.fill); setFillOpacity(s.fillOpacity); setCanvasBg(s.canvasBg);
    setPointStyle(s.pointStyle); setHandleStyle(s.handleStyle); setAnchorSize(s.anchorSize); setAnchorColor(s.anchorColor);
    setAnchorStrokeColor(s.anchorStrokeColor); setAnchorFillOpacity(s.anchorFillOpacity); setHandleSize(s.handleSize);
    setHandleColor(s.handleColor); setHandleFillOpacity(s.handleFillOpacity); setHandleLineColor(s.handleLineColor);
    setHandleLineWidth(s.handleLineWidth); setGuideColor(s.guideColor); setGuideThickness(s.guideThickness);
    setGuideZIndex(s.guideZIndex); setSnapToGuides(s.snapToGuides);
  };

  const undo = useCallback(() => {
    if (historyPtr > 0) {
      const prev = history[historyPtr - 1];
      setHistoryPtr(historyPtr - 1);
      const cloned = JSON.parse(JSON.stringify(prev));
      setKeyframes(cloned.keyframes);
      setKeyframeTimes(cloned.keyframeTimes);
      setActiveKeyIdx(cloned.activeKeyIdx);
      setSegments(cloned.keyframes[cloned.activeKeyIdx]);
      if (cloned.settings) applySettings(cloned.settings);
    }
  }, [history, historyPtr]);

  const redo = useCallback(() => {
    if (historyPtr < history.length - 1) {
      const next = history[historyPtr + 1];
      setHistoryPtr(historyPtr + 1);
      const cloned = JSON.parse(JSON.stringify(next));
      setKeyframes(cloned.keyframes);
      setKeyframeTimes(cloned.keyframeTimes);
      setActiveKeyIdx(cloned.activeKeyIdx);
      setSegments(cloned.keyframes[cloned.activeKeyIdx]);
      if (cloned.settings) applySettings(cloned.settings);
    }
  }, [history, historyPtr]);

  const revertToSavedState = useCallback(() => {
    const prev = history[historyPtr];
    const cloned = JSON.parse(JSON.stringify(prev));
    setKeyframes(cloned.keyframes);
    setKeyframeTimes(cloned.keyframeTimes);
    setActiveKeyIdx(cloned.activeKeyIdx);
    setSegments(cloned.keyframes[cloned.activeKeyIdx]);
    if (cloned.settings) applySettings(cloned.settings);
  }, [history, historyPtr]);

  const bindRef = useRef({ activeGuide, selectedAnchors, activeKeyIdx, tool, undo, redo, keyframeTimes, keyframes, segments, pushHistory, getCurrentSettings, lastPushedSettingsStr: lastPushedSettingsRef.current, historyPtr, revertToSavedState, addKeyframe: null as null | (() => void) });
  useEffect(() => {
    bindRef.current = { activeGuide, selectedAnchors, activeKeyIdx, tool, undo, redo, keyframeTimes, keyframes, segments, pushHistory, getCurrentSettings, lastPushedSettingsStr: lastPushedSettingsRef.current, historyPtr, revertToSavedState, addKeyframe: null };
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (isInput) {
        const type = (e.target as HTMLInputElement).type;
        const isTextInput = type === 'text' || type === 'number' || e.target instanceof HTMLTextAreaElement;
        if (isTextInput) return;
      }
      
      const { activeGuide, selectedAnchors, activeKeyIdx, tool, undo, redo, keyframeTimes, keyframes, segments, getCurrentSettings, lastPushedSettingsStr, revertToSavedState } = bindRef.current;
      
      // Guide deletion
      if ((e.code === 'Delete' || e.code === 'Backspace') && activeGuide) {
        e.preventDefault();
        setGuides(prev => prev.filter(g => g.id !== activeGuide));
        setActiveGuide(null);
        return; 
      }

      // Point deletion
      if ((e.code === 'Delete' || e.code === 'Backspace') && selectedAnchors.length > 0) {
        e.preventDefault();
        const ptsToDelete = new Set(selectedAnchors.map(a => a.sIdx));
        if (ptsToDelete.size > 0 && ptsToDelete.size < segmentsRef.current.length) {
           const newSegments = segmentsRef.current.filter((_, idx) => !ptsToDelete.has(idx));
           // Ensure first segment is always M if not empty
           if (newSegments.length > 0 && newSegments[0][0] !== 'M') {
             newSegments[0][0] = 'M';
             // M takes x, y. Just slice out handle points if it was a curve
             if (newSegments[0].length === 7) {
                newSegments[0] = ['M', newSegments[0][5], newSegments[0][6]];
             } else if (newSegments[0].length === 3) {
                newSegments[0] = ['M', newSegments[0][1], newSegments[0][2]];
             }
           }
           
           // Apply topology change to ALL keyframes to keep lerping compatible
           const newKeyframes = keyframesRef.current.map((kf, i) => {
              if (i === activeKeyIdx) return newSegments;
              const kfSegs = kf.filter((_, idx) => !ptsToDelete.has(idx));
              if (kfSegs.length > 0 && kfSegs[0][0] !== 'M') {
                kfSegs[0][0] = 'M';
                if (kfSegs[0].length === 7) kfSegs[0] = ['M', kfSegs[0][5], kfSegs[0][6]];
                else if (kfSegs[0].length === 3) kfSegs[0] = ['M', kfSegs[0][1], kfSegs[0][2]];
              }
              return kfSegs;
           });
           setKeyframes(newKeyframes);

           pushHistory({ keyframes: newKeyframes, keyframeTimes, activeKeyIdx });
           setSegments(newSegments);
           setSelectedAnchors([]);
        }
        return;
      }

      // Undo/Redo shortcuts
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        
        const currentStr = JSON.stringify(getCurrentSettings());
        if (currentStr !== lastPushedSettingsStr) {
          revertToSavedState();
        } else {
          if (e.shiftKey) redo();
          else undo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault();
        redo();
      }

      switch(e.code) {
        case 'KeyV': setTool('select'); break;
        case 'KeyH': setTool('hand'); break;
        case 'KeyZ': setTool('zoom'); break;
        case 'KeyD':
          if (bindRef.current.addKeyframe) {
            bindRef.current.addKeyframe();
          } else {
            const { keyframes, segments, keyframeTimes, pushHistory } = bindRef.current;
            const newKeyframes = [...keyframes];
            newKeyframes.push(JSON.parse(JSON.stringify(segments)));
            
            let newTimes: number[];
            if (keyframeTimes.length === 1) {
              newTimes = [0, 100];
            } else {
              const scale = (keyframeTimes.length - 1) / keyframeTimes.length;
              newTimes = keyframeTimes.map(t => t * scale);
              newTimes.push(100);
            }
            
            setKeyframeTimes(newTimes);
            setKeyframes(newKeyframes);
            setActiveKeyIdx(newKeyframes.length - 1);
            pushHistory({ keyframes: newKeyframes, keyframeTimes: newTimes, activeKeyIdx: newKeyframes.length - 1 });
          }
          break;
        case 'Space': 
          e.preventDefault();
          if (!e.repeat) setTool('hand'); 
          break;
        case 'Digit0':
        case 'Numpad0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            resetView();
          }
          break;
        case 'KeyF':
          centerView();
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const { tool } = bindRef.current;
      if (e.code === 'Space' && tool === 'hand') {
        setTool('select');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const processUploadedSvgContent = (content: string) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'image/svg+xml');
    
    let allPathData = "";
    const paths = doc.querySelectorAll('path');
    paths.forEach(p => {
      const d = p.getAttribute('d');
      if (d) allPathData += " " + d;
    });
    
    let parsedSegments: PathSegment[] | null = null;
    if (allPathData.trim()) {
      try {
        parsedSegments = parsePath(allPathData.trim());
      } catch (err) {
        console.error("Failed to parse SVG path", err);
      }
    }
    
    if (!parsedSegments) {
      // Did not find a path element or parsing failed. Convert rect, circle, etc. to path.
      const convertToPathData = (tagName: string, el: Element): string | null => {
         if (tagName === 'rect') {
            const x = parseFloat(el.getAttribute('x') || '0');
            const y = parseFloat(el.getAttribute('y') || '0');
            const w = parseFloat(el.getAttribute('width') || '0');
            const h = parseFloat(el.getAttribute('height') || '0');
            const rx = parseFloat(el.getAttribute('rx') || '0');
            const ry = parseFloat(el.getAttribute('ry') || rx.toString());
            if (w === 0 || h === 0) return null;
            if (rx > 0 || ry > 0) {
               return `M${x+rx},${y} l${w-rx*2},0 a${rx},${ry} 0 0,1 ${rx},${ry} l0,${h-ry*2} a${rx},${ry} 0 0,1 -${rx},${ry} l-${w-rx*2},0 a${rx},${ry} 0 0,1 -${rx},-${ry} l0,-${h-ry*2} a${rx},${ry} 0 0,1 ${rx},-${ry} Z`;
            }
            return `M${x},${y} L${x+w},${y} L${x+w},${y+h} L${x},${y+h} Z`;
         }
         if (tagName === 'circle' || tagName === 'ellipse') {
            const cx = parseFloat(el.getAttribute('cx') || '0');
            const cy = parseFloat(el.getAttribute('cy') || '0');
            const rx = parseFloat(el.getAttribute(tagName === 'circle' ? 'r' : 'rx') || '0');
            const ry = parseFloat(el.getAttribute(tagName === 'circle' ? 'r' : 'ry') || '0');
            if (rx === 0 || ry === 0) return null;
            return `M ${cx - rx}, ${cy} a ${rx},${ry} 0 1,0 ${rx * 2},0 a ${rx},${ry} 0 1,0 -${rx * 2},0`;
         }
         if (tagName === 'line') {
            const x1 = parseFloat(el.getAttribute('x1') || '0');
            const y1 = parseFloat(el.getAttribute('y1') || '0');
            const x2 = parseFloat(el.getAttribute('x2') || '0');
            const y2 = parseFloat(el.getAttribute('y2') || '0');
            return `M ${x1},${y1} L ${x2},${y2}`;
         }
         if (tagName === 'polygon' || tagName === 'polyline') {
            const points = el.getAttribute('points') || "";
            const p = points.trim().split(/[\s,]+/).map(parseFloat);
            if (p.length < 2) return null;
            let d = `M ${p[0]},${p[1]} `;
            for (let i = 2; i < p.length; i += 2) {
               d += `L ${p[i]},${p[i+1]} `;
            }
            if (tagName === 'polygon') d += 'Z';
            return d;
         }
         return null;
      };

      const shapeTypes = ['rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'];
      for (const shape of shapeTypes) {
         const els = doc.querySelectorAll(shape);
         els.forEach(el => {
            const foundPath = convertToPathData(shape, el);
            if (foundPath) {
               allPathData += " " + foundPath;
            }
         });
      }
    }

    if (allPathData.trim()) {
      try {
        parsedSegments = parsePath(allPathData.trim());
      } catch(e) {}
    }

    if (parsedSegments && parsedSegments.length > 0) {
      // Option 2: Normalize the coordinate data directly
      const fittedSegments = fitSegmentsToCanvas(parsedSegments, 300, 150, 150);
      
      const clonedFitted = JSON.parse(JSON.stringify(fittedSegments));
      setKeyframes([clonedFitted]);
      setKeyframeTimes([0]);
      setInitialImportedPath(clonedFitted);
      setActiveKeyIdx(0);
      setSegments(clonedFitted);
      setHistory([{ keyframes: [clonedFitted], keyframeTimes: [0], activeKeyIdx: 0 }]);
      setHistoryPtr(0);
      
      // Reset the camera back to origin
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      alert('No supported shapes (path, rect, circle, ellipse, line, polygon) found in the SVG.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      processUploadedSvgContent(content);
    };
    reader.readAsText(file);
  };

  const contentRef = useRef<SVGGElement>(null);
  
  useEffect(() => {
    // Small delay to ensure refs are ready
    const timer = setTimeout(() => {
      centerView();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent) => {
    // Better mouse coordinate detection for wheel
    if (!svgRef.current || !contentRef.current) return;
    
    // Ctrl + Wheel to zoom
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      
      const pt = svgRef.current.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const cursor = pt.matrixTransform(contentRef.current.getScreenCTM()?.inverse());

      const delta = -e.deltaY;
      const factor = 1.1;
      const newZoom = Math.min(Math.max(delta > 0 ? zoom * factor : zoom / factor, 0.1), 10);
      
      const newPanX = pan.x + cursor.x * (zoom - newZoom);
      const newPanY = pan.y + cursor.y * (zoom - newZoom);

      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    } else {
      // Regular wheel panning
      setPan(prev => ({
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY
      }));
    }
  };

  const [isPanning, setIsPanning] = useState(false);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      let cursor: { x: number; y: number } | null = null;
      if (svgRef.current && contentRef.current) {
        const pt = svgRef.current.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        cursor = pt.matrixTransform(contentRef.current.getScreenCTM()?.inverse());
      }

      if (selectionBox && cursor) {
        setSelectionBox(prev => prev ? { ...prev, currentX: cursor!.x, currentY: cursor!.y } : null);
      } else if (draggingGuide && cursor) {
        setGuides(prev => prev.map(g => {
          if (g.id === draggingGuide) {
             let snappedPos = g.type === 'horizontal' ? cursor!.y : cursor!.x;
             
             if (snapToGuides) {
               let minDiff = SNAP_THRESHOLD / zoom;
               for (const s of segmentsRef.current) {
                 const isAnchor = (s[0] === 'M' || s[0] === 'L') ? true : (s[0] === 'C' ? true : false);
                 if (!isAnchor) continue;
                 
                 const ptX = (s[0] === 'M' || s[0] === 'L') ? s[1] as number : s[5] as number;
                 const ptY = (s[0] === 'M' || s[0] === 'L') ? s[2] as number : s[6] as number;
                 
                 if (g.type === 'horizontal') {
                   if (Math.abs(ptY - snappedPos) < minDiff) {
                     snappedPos = ptY;
                     minDiff = Math.abs(ptY - snappedPos);
                   }
                 } else {
                   if (Math.abs(ptX - snappedPos) < minDiff) {
                     snappedPos = ptX;
                     minDiff = Math.abs(ptX - snappedPos);
                   }
                 }
               }
             }

             return { ...g, position: snappedPos };
          }
          return g;
        }));
      } else if (activePoint && cursor) {
        setSegments(prev => {
          const next = prev.map(s => [...s] as PathSegment);
          const currentSeg = next[activePoint.sIdx];
          const isAltPressed = e.altKey;
          const isShiftPressed = e.shiftKey;
          
          let newX = cursor!.x - dragOffset.x;
          let newY = cursor!.y - dragOffset.y;

          // M/L anchor is at index 1, C anchor is at index 5
          const isAnchor = (currentSeg[0] === 'M' || currentSeg[0] === 'L') 
            ? activePoint.pIdx === 1 
            : activePoint.pIdx === 5;
            
          // Guide Snapping Logic (Only snap anchors, not handles, unless shift is pressed? Snap everything is fine)
          if (snapToGuides && isAnchor) {
            let snappedX = newX;
            let snappedY = newY;
            
            guides.forEach(g => {
              if (g.type === 'vertical') {
                if (Math.abs(newX - g.position) < SNAP_THRESHOLD / zoom) {
                  snappedX = g.position;
                }
              } else if (g.type === 'horizontal') {
                if (Math.abs(newY - g.position) < SNAP_THRESHOLD / zoom) {
                  snappedY = g.position;
                }
              }
            });
            
            newX = snappedX;
            newY = snappedY;
          }

          // Shift constraint logic
          if (isShiftPressed) {
            let refX: number | null = null;
            let refY: number | null = null;

            if (isAnchor && activePoint.startPos) {
              refX = activePoint.startPos.x;
              refY = activePoint.startPos.y;
            } else if (!isAnchor) {
              if (activePoint.pIdx === 1) { // Outgoing handle (belongs to prev anchor)
                const prevSeg = next[activePoint.sIdx - 1];
                if (prevSeg) {
                  refX = prevSeg[prevSeg.length - 2] as number;
                  refY = prevSeg[prevSeg.length - 1] as number;
                }
              } else if (activePoint.pIdx === 3) { // Incoming handle (belongs to current anchor)
                refX = currentSeg[5] as number;
                refY = currentSeg[6] as number;
              }
            }

            if (refX !== null && refY !== null) {
              const dxC = newX - refX;
              const dyC = newY - refY;
              const angle = Math.atan2(dyC, dxC);
              // snap to nearest 45 degrees
              const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
              const dist = Math.sqrt(dxC*dxC + dyC*dyC);
              newX = refX + Math.cos(snappedAngle) * dist;
              newY = refY + Math.sin(snappedAngle) * dist;
            }
          }

          const oldX = currentSeg[activePoint.pIdx] as number;
          const oldY = currentSeg[activePoint.pIdx + 1] as number;
          const dx = newX - oldX;
          const dy = newY - oldY;

          // M/L anchor is at index 1, C anchor is at index 5
          if (isAnchor) {
            // First collect all indices to move (the active one, plus any selected ones if the active one is selected)
            const indicesToMove = new Set<number>();
            indicesToMove.add(activePoint.sIdx);
            if (selectedAnchors.includes(activePoint.sIdx)) {
              selectedAnchors.forEach(idx => indicesToMove.add(idx));
            }
            
            indicesToMove.forEach(sIdx => {
               const seg = next[sIdx];
               const pIdx = (seg[0] === 'M' || seg[0] === 'L') ? 1 : 5;
               
               if (sIdx === activePoint.sIdx) {
                 seg[pIdx] = newX;
                 seg[pIdx + 1] = newY;
               } else {
                 seg[pIdx] = (seg[pIdx] as number) + dx;
                 seg[pIdx + 1] = (seg[pIdx + 1] as number) + dy;
               }

               if (seg[0] === 'C') {
                 // Move Incoming handle along with anchor
                 seg[3] = (seg[3] as number) + dx;
                 seg[4] = (seg[4] as number) + dy;
               }
               const nSeg = next[sIdx + 1];
               if (nSeg && nSeg[0] === 'C') {
                 // Move Outgoing handle for this point, found on the *next* segment
                 nSeg[1] = (nSeg[1] as number) + dx;
                 nSeg[2] = (nSeg[2] as number) + dy;
               }
               
               // In case this is a starting M point, we might also need to move the very last C segment's handle if path is closed
               if (seg[0] === 'M') {
                 const lastSeg = next[next.length - 1];
                 if (lastSeg && lastSeg[0] === 'Z') {
                   const closeC = next[next.length - 2];
                   // If the last drawing segment before Z is C, and closes back to M (often implicitly), its incoming handle doesn't move with M, but we don't worry about close handles here unless explicit.
                 }
               }
            });
          } else {
            // It's a handle (pIdx 1 or 3 in a 'C' segment)
            // Just move the specific handle to the precise cursor position
            currentSeg[activePoint.pIdx] = newX;
            currentSeg[activePoint.pIdx + 1] = newY;

            if (!isAltPressed && activePoint.isSmooth) {
               if (activePoint.pIdx === 1) { // Outgoing handle (belongs to prev anchor)
                  const prevSeg = next[activePoint.sIdx - 1];
                  if (prevSeg) {
                     const anchorX = prevSeg[prevSeg.length - 2] as number;
                     const anchorY = prevSeg[prevSeg.length - 1] as number;
                     const dx = newX - anchorX;
                     const dy = newY - anchorY;
                     const angleC = Math.atan2(dy, dx);
                     const oppAngle = angleC + Math.PI;
                     
                     if (prevSeg[0] === 'C') {
                        const oppDX = (prevSeg[3] as number) - anchorX;
                        const oppDY = (prevSeg[4] as number) - anchorY;
                        const oppLen = Math.sqrt(oppDX*oppDX + oppDY*oppDY);
                        if (oppLen > 0.01) {
                           prevSeg[3] = anchorX + Math.cos(oppAngle) * oppLen;
                           prevSeg[4] = anchorY + Math.sin(oppAngle) * oppLen;
                        }
                     } else if (activePoint.sIdx === 1 && prevSeg[0] === 'M') {
                        const lastSeg = next[next.length - 1];
                        if (lastSeg && lastSeg[0] === 'Z') {
                           const closeC = next[next.length - 2];
                           if (closeC && closeC[0] === 'C' && Math.hypot((closeC[5] as number) - anchorX, (closeC[6] as number) - anchorY) < 0.1) {
                              const oppDX = (closeC[3] as number) - anchorX;
                              const oppDY = (closeC[4] as number) - anchorY;
                              const oppLen = Math.sqrt(oppDX*oppDX + oppDY*oppDY);
                              if (oppLen > 0.01) {
                                 closeC[3] = anchorX + Math.cos(oppAngle) * oppLen;
                                 closeC[4] = anchorY + Math.sin(oppAngle) * oppLen;
                              }
                           }
                        }
                     }
                  }
               } else if (activePoint.pIdx === 3) { // Incoming handle (belongs to current anchor)
                  const anchorX = currentSeg[5] as number;
                  const anchorY = currentSeg[6] as number;
                  const dx = newX - anchorX;
                  const dy = newY - anchorY;
                  const angleC = Math.atan2(dy, dx);
                  const oppAngle = angleC + Math.PI;

                  const nSeg = next[activePoint.sIdx + 1];
                  if (nSeg && nSeg[0] === 'Z') {
                     const nextOfM = next[1];
                     if (next[0] && next[0][0] === 'M' && nextOfM && nextOfM[0] === 'C') {
                        const startX = next[0][1] as number;
                        const startY = next[0][2] as number;
                        if (Math.hypot(anchorX - startX, anchorY - startY) < 0.1) {
                           const oppDX = (nextOfM[1] as number) - anchorX;
                           const oppDY = (nextOfM[2] as number) - anchorY;
                           const oppLen = Math.sqrt(oppDX*oppDX + oppDY*oppDY);
                           if (oppLen > 0.01) {
                              nextOfM[1] = anchorX + Math.cos(oppAngle) * oppLen;
                              nextOfM[2] = anchorY + Math.sin(oppAngle) * oppLen;
                           }
                        }
                     }
                  } else if (nSeg && nSeg[0] === 'C') {
                     const oppDX = (nSeg[1] as number) - anchorX;
                     const oppDY = (nSeg[2] as number) - anchorY;
                     const oppLen = Math.sqrt(oppDX*oppDX + oppDY*oppDY);
                     if (oppLen > 0.01) {
                        nSeg[1] = anchorX + Math.cos(oppAngle) * oppLen;
                        nSeg[2] = anchorY + Math.sin(oppAngle) * oppLen;
                     }
                  }
               }
            }
          }

          return next;
        });
      } else if (cornerDrag && cursor) {
         // Because we scale the SVG visually using zoom, `cursor` is already in raw SVG 300x300 space!
         const dx = cursor.x - cornerDrag.startX;
         const dy = cursor.y - cornerDrag.startY;
         
         // Project cursor movement onto the vector pointing inwards (dirX, dirY)
         const startRadius = cornerDrag.corner.currentRadius || 0;
         const distChange = dx * cornerDrag.dirX + dy * cornerDrag.dirY;

         // Calculate sine of half the corner angle to map widget drag distance to topological radius perfectly
         const ux = cornerDrag.corner.prevX - cornerDrag.corner.pX;
         const uy = cornerDrag.corner.prevY - cornerDrag.corner.pY;
         const vx = cornerDrag.corner.nextX - cornerDrag.corner.pX;
         const vy = cornerDrag.corner.nextY - cornerDrag.corner.pY;
         const lu = Math.sqrt(ux*ux + uy*uy);
         const lv = Math.sqrt(vx*vx + vy*vy);
         
         const dot = lu > 0.001 && lv > 0.001 ? (ux*vx + uy*vy) / (lu * lv) : 0;
         const alpha = Math.acos(Math.max(-1, Math.min(1, dot)));
         const sinHalf = Math.sin(alpha / 2);

         const radius = Math.max(0, startRadius + distChange * Math.max(0.01, sinHalf));
         
         if (radius > 0.5) {
           let newSegs = [...cornerDrag.originalSegments.map(s => [...s] as PathSegment)];
           const cornersToApply = findCorners(newSegs).filter(c => 
              c.sIdx === cornerDrag.corner.sIdx || 
              (selectedAnchors.includes(cornerDrag.corner.sIdx) && selectedAnchors.includes(c.sIdx))
           );
           // Sort by descending sIdx to prevent shifting index issues
           cornersToApply.sort((a, b) => b.sIdx - a.sIdx);
           
           cornersToApply.forEach(c => {
             // For others in the selection, apply the SAME absolute radius for sync visual matching
             newSegs = applyCornerRadius(newSegs, c, radius, false);
           });
           setSegments(newSegs);
         } else {
           let newSegs = [...cornerDrag.originalSegments.map(s => [...s] as PathSegment)];
           const cornersToApply = findCorners(newSegs).filter(c => 
              c.sIdx === cornerDrag.corner.sIdx || 
              (selectedAnchors.includes(cornerDrag.corner.sIdx) && selectedAnchors.includes(c.sIdx))
           );
           cornersToApply.sort((a, b) => b.sIdx - a.sIdx);
           cornersToApply.forEach(c => {
             newSegs = applyCornerRadius(newSegs, c, 0, false);
           });
           setSegments(newSegs);
         }
      } else if (isPanning) {
        setPan(prev => ({
          x: prev.x + e.movementX,
          y: prev.y + e.movementY
        }));
      }
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (selectionBox) {
        // Calculate bounds of selection box
        const minX = Math.min(selectionBox.startX, selectionBox.currentX);
        const maxX = Math.max(selectionBox.startX, selectionBox.currentX);
        const minY = Math.min(selectionBox.startY, selectionBox.currentY);
        const maxY = Math.max(selectionBox.startY, selectionBox.currentY);

        const newSelection: number[] = [];
        segmentsRef.current.forEach((seg, sIdx) => {
          if (seg[0] === 'M' || seg[0] === 'L') {
            const x = seg[1] as number;
            const y = seg[2] as number;
            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
              newSelection.push(sIdx);
            }
          } else if (seg[0] === 'C') {
            const x = seg[5] as number;
            const y = seg[6] as number;
            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
              newSelection.push(sIdx);
            }
          }
        });

        if (e.shiftKey) {
          // Append mutually exclusive
          setSelectedAnchors(prev => {
            const copy = new Set(prev);
            newSelection.forEach(idx => {
              if (copy.has(idx)) copy.delete(idx);
              else copy.add(idx);
            });
            return Array.from(copy);
          });
        } else {
          setSelectedAnchors(newSelection);
        }
        setSelectionBox(null);
      }

      if (draggingGuide) {
        const PULL_EDGE_THRESHOLD = 20;
        // Delete guide if dragged near the edges of the entire window viewport
        if (e.clientX < PULL_EDGE_THRESHOLD || e.clientX > window.innerWidth - PULL_EDGE_THRESHOLD || 
            e.clientY < PULL_EDGE_THRESHOLD || e.clientY > window.innerHeight - PULL_EDGE_THRESHOLD) {
          setGuides(prev => prev.filter(g => g.id !== draggingGuide));
          setActiveGuide(null);
        }
        setDraggingGuide(null);
      }

      if (activePoint || cornerDrag) {
        // Use a more stable clone for final state
        const finalSegments = [...segmentsRef.current.map(s => [...s] as PathSegment)];
        let pushedKeyframes = [...keyframesRef.current];
        if (cornerDrag && finalSegments.length !== cornerDrag.originalSegments.length) {
          const isAddingCurve = finalSegments.length > cornerDrag.originalSegments.length;
          
          // Apply matching zero-radius topology to ALL OTHER keyframes to keep lerping compatible
          pushedKeyframes = keyframesRef.current.map((kf, i) => {
             if (i === activeKeyIdx) return finalSegments;
             let kfSegs = [...kf.map(s => [...s] as PathSegment)];
             const cornersToApplyk = findCorners(kfSegs, true).filter(c => 
                c.sIdx === cornerDrag.corner.sIdx || 
                (selectedAnchors.includes(cornerDrag.corner.sIdx) && selectedAnchors.includes(c.sIdx))
             );
             cornersToApplyk.sort((a, b) => b.sIdx - a.sIdx);
             cornersToApplyk.forEach(c => {
               kfSegs = applyCornerRadius(kfSegs, c, 0, isAddingCurve);
             });
             return kfSegs;
          });
          setKeyframes(pushedKeyframes);

          // Update selection indices since topology shifted, using our precomputed liveSelectedAnchors state
          setSelectedAnchors(liveSelectedAnchors);
        } else {
          pushedKeyframes[activeKeyIdx] = finalSegments;
          setKeyframes(pushedKeyframes);
        }

        pushHistory({ keyframes: pushedKeyframes, keyframeTimes, activeKeyIdx });
      }
      setActivePoint(null);
      setCornerDrag(null);
      setIsPanning(false);
    };

    if (selectionBox || activePoint || isPanning || cornerDrag || draggingGuide) {
      window.addEventListener('mousemove', handleGlobalMouseMove);
      window.addEventListener('mouseup', handleGlobalMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [selectionBox, activePoint, isPanning, dragOffset, tool, cornerDrag, activeKeyIdx, selectedAnchors, liveSelectedAnchors, draggingGuide]);

  useEffect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      // Middle mouse button or Space + Left click to pan
      if (e.button === 1 || (tool === 'hand' && e.button === 0)) {
        setIsPanning(true);
      }
    };

    window.addEventListener('mousedown', handleGlobalMouseDown);
    return () => window.removeEventListener('mousedown', handleGlobalMouseDown);
  }, [tool]);

  const startRecording = async () => {
    if (!svgRef.current || isRecording) return;
    
    if (typeof VideoEncoder === 'undefined') {
      alert("현재 환경에서 고화질 MP4 렌더링(WebCodecs API)을 지원하지 않습니다. 최신 브라우저를 사용해주세요.");
      return;
    }

    setIsRecording(true);
    setIsAnimating(false);
    setAnimProgress(0);

    const resMap = {
      '720p': { w: 1280, h: 720 },
      '1080p': { w: 1920, h: 1080 },
      '2k': { w: 2560, h: 1440 },
      '4k': { w: 3840, h: 2160 }
    };
    
    const targetW = resMap[exportRes].w;
    const targetH = resMap[exportRes].h;

    let finalScale = 1;
    let finalOffsetX = 0;
    let finalOffsetY = 0;
    let isMatrixMode = false;
    let finalMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

    if (exportFraming === 'auto') {
      // Determine bounding box across all keyframes to perfect-center the video
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      keyframes.forEach(kf => {
        kf.forEach(seg => {
          for(let i=1; i<seg.length; i+=2) {
            const x = seg[i] as number; 
            const y = seg[i+1] as number;
            if(x < minX) minX = x;
            if(x > maxX) maxX = x;
            if(y < minY) minY = y;
            if(y > maxY) maxY = y;
          }
        });
      });

      // Add 20% padding
      const paddingX = Math.max((maxX - minX) * 0.2, 50);
      const paddingY = Math.max((maxY - minY) * 0.2, 50);
      minX -= paddingX; maxX += paddingX;
      minY -= paddingY; maxY += paddingY;
      
      const contentW = maxX - minX;
      const contentH = maxY - minY;
      
      // Scale to fit the target resolution
      finalScale = Math.min(targetW / contentW, targetH / contentH);
      finalOffsetX = (targetW - contentW * finalScale) / 2 - minX * finalScale;
      finalOffsetY = (targetH - contentH * finalScale) / 2 - minY * finalScale;
    } else {
      // Viewport mode: What you see is what you get!
      const guideBox = document.getElementById('camera-guide-box');
      const ctm = contentRef.current?.getScreenCTM();
      if (!guideBox || !ctm) {
        alert("렌더기 초기화 오류: 화면 변환 행렬을 찾을 수 없습니다.");
        setIsRecording(false);
        return;
      }
      
      const guideRect = guideBox.getBoundingClientRect();
      const canvasScaleX = targetW / guideRect.width;
      const canvasScaleY = targetH / guideRect.height;
      
      isMatrixMode = true;
      finalMatrix = {
         a: ctm.a * canvasScaleX,
         b: ctm.b * canvasScaleX,
         c: ctm.c * canvasScaleY,
         d: ctm.d * canvasScaleY,
         e: (ctm.e - guideRect.left) * canvasScaleX,
         f: (ctm.f - guideRect.top) * canvasScaleY
      };
      
      // finalScale estimate for keeping Handle thickness and line width relatively consistent 
      finalScale = Math.sqrt(finalMatrix.a * finalMatrix.a + finalMatrix.b * finalMatrix.b);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    // Create a visible overlay to show progress to user
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.backgroundColor = 'rgba(15, 23, 42, 0.95)';
    overlay.style.zIndex = '99999';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.backdropFilter = 'blur(8px)';
    
    const textInfo = document.createElement('div');
    textInfo.innerText = `🎥 고화질 MP4 렌더링 진행 중... (${targetW}x${targetH})`;
    textInfo.style.color = '#f8fafc';
    textInfo.style.fontFamily = 'sans-serif';
    textInfo.style.fontSize = '18px';
    textInfo.style.fontWeight = 'bold';
    
    const progressText = document.createElement('div');
    progressText.innerText = '0%';
    progressText.style.marginTop = '12px';
    progressText.style.color = '#6366f1';
    progressText.style.fontFamily = 'monospace';
    progressText.style.fontSize = '24px';
    progressText.style.fontWeight = 'bold';

    overlay.appendChild(textInfo);
    overlay.appendChild(progressText);
    document.body.appendChild(overlay);

    const fps = 60;
    const totalFrames = animDuration * fps;
    const durationCount = animDuration * 1000;

    let muxer;
    let videoEncoder: VideoEncoder;

    try {
      const is4k = targetW >= 3840;
      const is2k = targetW >= 2560;
      const codecLevel = is4k ? 'avc1.64003E' : (is2k ? 'avc1.640034' : 'avc1.640028');

      const config: VideoEncoderConfig = {
        codec: codecLevel,
        width: targetW, 
        height: targetH,
        bitrate: is4k ? 60_000_000 : (is2k ? 30_000_000 : 16_000_000),
        framerate: fps,
        hardwareAcceleration: 'prefer-hardware'
      };

      const support = await VideoEncoder.isConfigSupported(config);
      if (!support.supported) {
        alert(`현재 기기/브라우저 조합에서 ${exportRes} 해상도 MP4 하드웨어 인코딩을 지원하지 않습니다. 해상도를 낮춰서 시도해주세요.`);
        setIsRecording(false);
        document.body.removeChild(overlay);
        return;
      }

      muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: {
          codec: is4k ? 'avc' : 'avc',
          width: targetW,
          height: targetH
        },
        fastStart: 'in-memory'
      });
      videoEncoder = new VideoEncoder({
        output: (chunk, meta) => {
          muxer.addVideoChunk(chunk, meta);
        },
        error: (e) => {
          console.error(e);
          alert(`MP4 인코딩 중 오류 렌더 에러가 발생했습니다: ${e.message}`);
        }
      });
      videoEncoder.configure(config);
    } catch (e) {
      alert("MP4 인코딩 초기화에 실패했습니다. 브라우저가 최신인지 확인해주세요.");
      setIsRecording(false);
      document.body.removeChild(overlay);
      return;
    }

    const hexToRgb = (hex: string) => {
      if (!hex || !hex.startsWith('#')) return '99, 102, 241';
      const r = parseInt(hex.slice(1, 3), 16) || 0;
      const g = parseInt(hex.slice(3, 5), 16) || 0;
      const b = parseInt(hex.slice(5, 7), 16) || 0;
      return `${r}, ${g}, ${b}`;
    };

    const EASING_MATH: Record<string, (t: number) => number> = {
      linear: (t) => t,
      easeIn: (t) => t * t, 
      easeOut: (t) => t * (2 - t),
      easeInOut: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
      circIn: (t) => 1 - Math.sqrt(1 - Math.pow(t, 2)),
      circOut: (t) => Math.sqrt(1 - Math.pow(t - 1, 2)),
      backIn: (t) => { const c1 = 1.70158; const c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
      backOut: (t) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
    };

    const processFrames = async () => {
      for (let i = 0; i <= totalFrames; i++) {
        const progress = i / totalFrames;
        setAnimProgress(progress);
        progressText.innerText = `${Math.round(progress * 100)}%`;

        let frameSegments = segments;
        if (keyframes.length >= 2) {
          let globalProgress = progress;
          
          if (easingMode === 'global') {
             const easeFn = EASING_MATH[animEasing] || EASING_MATH.linear;
             globalProgress = easeFn(globalProgress);
          }
          
          const t = globalProgress * 100;
          let stepIdx = 0;
          while (stepIdx < keyframeTimes.length - 1 && t >= keyframeTimes[stepIdx + 1]) {
             stepIdx++;
          }
          if (stepIdx >= keyframeTimes.length - 1) {
             stepIdx = keyframeTimes.length - 2;
          }
          
          const t0 = keyframeTimes[stepIdx];
          const t1 = keyframeTimes[stepIdx + 1];
          let stepProgress = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
          stepProgress = Math.max(0, Math.min(1, stepProgress));
          
          if (easingMode === 'local') {
             const easeFn = EASING_MATH[animEasing] || EASING_MATH.linear;
             stepProgress = easeFn(stepProgress);
          }
          
          frameSegments = lerpSegments(keyframes[stepIdx], keyframes[stepIdx + 1], stepProgress);
        }

        ctx.fillStyle = canvasBg;
        ctx.fillRect(0, 0, targetW, targetH);

        ctx.save();
        if (isMatrixMode) {
          ctx.transform(finalMatrix.a, finalMatrix.b, finalMatrix.c, finalMatrix.d, finalMatrix.e, finalMatrix.f);
        } else {
          ctx.translate(finalOffsetX, finalOffsetY);
          ctx.scale(finalScale, finalScale);
        }

        const drawGuidesForExport = () => {
          ctx.beginPath();
          guides.forEach(g => {
            if (g.type === 'vertical') {
              ctx.moveTo(g.position, -10000);
              ctx.lineTo(g.position, 10000);
            } else {
              ctx.moveTo(-10000, g.position);
              ctx.lineTo(10000, g.position);
            }
          });
          ctx.lineWidth = guideThickness;
          ctx.strokeStyle = guideColor;
          ctx.lineCap = 'butt';
          ctx.lineJoin = 'miter';
          ctx.setLineDash([5, 5]);
          ctx.stroke();
          ctx.setLineDash([]);
        };

        if (guideZIndex === 'back') {
          drawGuidesForExport();
        }

        ctx.beginPath();
        for (const seg of frameSegments) {
          const cmd = seg[0];
          if (cmd === 'M') ctx.moveTo(seg[1], seg[2]);
          else if (cmd === 'C') ctx.bezierCurveTo(seg[1], seg[2], seg[3], seg[4], seg[5], seg[6]);
          else if (cmd === 'L') ctx.lineTo(seg[1], seg[2]);
          else if (cmd === 'Z') ctx.closePath();
        }

        if (fill && fill !== 'none') {
          ctx.fillStyle = `rgba(${hexToRgb(fill)}, ${fillOpacity})`;
          ctx.fill();
        }

        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();

        if (showControlsDuringAnim) {
          // Draw Handle Lines
          ctx.lineWidth = handleLineWidth;
          ctx.strokeStyle = handleLineColor;
          ctx.beginPath();
          frameSegments.forEach((seg, sIdx) => {
            const type = seg[0];
            if (type === 'C') {
              const prevSeg = frameSegments[sIdx - 1];
              const startX = prevSeg?.[prevSeg.length - 2] as number ?? 0;
              const startY = prevSeg?.[prevSeg.length - 1] as number ?? 0;
              if (Math.hypot((seg[1] as number) - startX, (seg[2] as number) - startY) >= 0.1) {
                ctx.moveTo(startX, startY);
                ctx.lineTo(seg[1] as number, seg[2] as number);
              }
              if (Math.hypot((seg[3] as number) - (seg[5] as number), (seg[4] as number) - (seg[6] as number)) >= 0.1) {
                ctx.moveTo(seg[5] as number, seg[6] as number);
                ctx.lineTo(seg[3] as number, seg[4] as number);
              }
            }
          });
          ctx.stroke();

          // Draw Handle Points
          const hSize = handleSize;
          ctx.lineCap = 'butt'; // Reset linecap precisely for UI components to match SVG defaults
          ctx.lineJoin = 'miter';

          let prevPoint = { x: 0, y: 0 };
          frameSegments.forEach((seg) => {
             const type = seg[0];
             if (type === 'C') {
               const pts = [ {x: seg[1] as number, y: seg[2] as number, anchor: prevPoint}, {x: seg[3] as number, y: seg[4] as number, anchor: {x: seg[5] as number, y: seg[6] as number}} ];
               pts.forEach(pt => {
                 if (Math.hypot(pt.x - pt.anchor.x, pt.y - pt.anchor.y) < 0.1) return;
                 ctx.fillStyle = handleColor;
                 ctx.strokeStyle = handleLineColor;
                 ctx.lineWidth = handleLineWidth;
                 ctx.beginPath();
                 if (handleStyle === 'circle') {
                   ctx.arc(pt.x, pt.y, hSize, 0, Math.PI * 2);
                   ctx.fill(); ctx.stroke();
                 } else if (handleStyle === 'square') {
                   ctx.rect(pt.x - hSize, pt.y - hSize, hSize * 2, hSize * 2);
                   ctx.fill(); ctx.stroke();
                 } else if (handleStyle === 'x-shape') {
                   const angle = Math.atan2(pt.y - pt.anchor.y, pt.x - pt.anchor.x);
                   ctx.save();
                   ctx.translate(pt.x, pt.y);
                   ctx.rotate(angle);
                   ctx.beginPath();
                   ctx.moveTo(-hSize, -hSize);
                   ctx.lineTo(hSize, hSize);
                   ctx.moveTo(hSize, -hSize);
                   ctx.lineTo(-hSize, hSize);
                   ctx.stroke();
                   ctx.restore();
                 } else if (handleStyle === 'i-shape') {
                   const angle = Math.atan2(pt.y - pt.anchor.y, pt.x - pt.anchor.x);
                   ctx.save();
                   ctx.translate(pt.x, pt.y);
                   ctx.rotate(angle);
                   ctx.beginPath();
                   ctx.moveTo(0, -hSize);
                   ctx.lineTo(0, hSize);
                   ctx.stroke();
                   ctx.restore();
                 }
               });
             }
             if (seg.length >= 3) {
                 prevPoint = { x: seg[seg.length - 2] as number, y: seg[seg.length - 1] as number };
             }
          });

          // Draw Anchors
          const aSize = anchorSize;
          frameSegments.forEach((seg, sIdx) => {
            if (seg[0] === 'Z') return;
            const px = seg[seg.length - 2] as number;
            const py = seg[seg.length - 1] as number;
            
            ctx.fillStyle = anchorColor;
            ctx.strokeStyle = anchorStrokeColor;
            ctx.lineWidth = handleLineWidth; // Stroke width exactly matches handles in SVG settings
            ctx.beginPath();
            
            if (pointStyle === 'circle') {
              ctx.arc(px, py, aSize, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            } else if (pointStyle === 'i-shape') {
              let angle = 0;
              let showI = true;
              
              let hasInHandle = false;
              let vIn: [number, number] | null = null;
              if (seg[0] === 'C') {
                  const hx = seg[3] as number, hy = seg[4] as number;
                  if (Math.hypot(hx - px, hy - py) > 0.05) { 
                      vIn = [hx - px, hy - py]; 
                      hasInHandle = true; 
                  }
              }
              if (!vIn) {
                  let prevSeg = frameSegments[sIdx - 1];
                  if (!prevSeg && sIdx === 0 && frameSegments[frameSegments.length - 1]?.[0] === 'Z') {
                      prevSeg = frameSegments[frameSegments.length - 2];
                  }
                  if (prevSeg) {
                      const ppx = prevSeg[prevSeg.length - 2] as number, ppy = prevSeg[prevSeg.length - 1] as number;
                      if (Math.hypot(ppx - px, ppy - py) > 0.05) vIn = [ppx - px, ppy - py];
                  }
              }
              
              let hasOutHandle = false;
              let vOut: [number, number] | null = null;
              let nextSeg = frameSegments[sIdx + 1];
              if (nextSeg && nextSeg[0] === 'Z') {
                   nextSeg = frameSegments[1]; 
              }
              if (nextSeg && nextSeg[0] === 'C') {
                  const hx = nextSeg[1] as number, hy = nextSeg[2] as number;
                  if (Math.hypot(hx - px, hy - py) > 0.05) { 
                      vOut = [hx - px, hy - py]; 
                      hasOutHandle = true; 
                  }
              }
              if (!vOut && nextSeg && (nextSeg[0] === 'M' || nextSeg[0] === 'L' || nextSeg[0] === 'C')) {
                  const nx = nextSeg[nextSeg.length - 2] as number, ny = nextSeg[nextSeg.length - 1] as number;
                  if (Math.hypot(nx - px, ny - py) > 0.05) vOut = [nx - px, ny - py];
              }

              if (!hasInHandle && !hasOutHandle) {
                  showI = false;
              } else {
                  let uIn: [number, number] | null = null;
                  if (vIn) {
                       const len = Math.hypot(vIn[0], vIn[1]);
                       uIn = [vIn[0]/len, vIn[1]/len];
                  }
                  let uOut: [number, number] | null = null;
                  if (vOut) {
                       const len = Math.hypot(vOut[0], vOut[1]);
                       uOut = [vOut[0]/len, vOut[1]/len];
                  }
                  let dX = 0, dY = 0;
                  if (uIn && uOut) {
                      dX = uOut[0] - uIn[0];
                      dY = uOut[1] - uIn[1];
                      if (Math.hypot(dX, dY) < 0.001) {
                           dX = -uIn[1]; dY = uIn[0];
                      }
                  } else if (uIn) {
                      dX = -uIn[0]; dY = -uIn[1];
                  } else if (uOut) {
                      dX = uOut[0]; dY = uOut[1];
                  }
                  angle = Math.atan2(dY, dX);
              }

              if (showI) {
                  ctx.save();
                  ctx.translate(px, py);
                  ctx.rotate(angle);
                  ctx.moveTo(0, -aSize);
                  ctx.lineTo(0, aSize);
                  ctx.stroke();
                  ctx.restore();
              }
            } else {
              ctx.rect(px - aSize, py - aSize, aSize * 2, aSize * 2);
              ctx.fill();
              ctx.stroke();
            }
          });
        }

        if (guideZIndex === 'front') {
          drawGuidesForExport();
        }

        ctx.restore();

        // Release the event loop every few frames to update UI
        if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));

        // Generate video frame and encode
        const frameDuration = (1e6 / fps);
        // @ts-ignore
        const frame = new VideoFrame(canvas, { 
          timestamp: (i * 1e6) / fps,
          duration: frameDuration
        });
        videoEncoder.encode(frame);
        frame.close();
      }

      await videoEncoder.flush();
      // @ts-ignore
      muxer.finalize();
      
      // @ts-ignore
      const buffer = muxer.target.buffer;
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vector-animation-${Date.now()}-${exportRes}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setIsRecording(false);
      setAnimProgress(0);
      if (overlay.parentNode) document.body.removeChild(overlay);
    };

    processFrames();
  };

  const handleMouseDown = (e: React.MouseEvent, sIdx: number, pIdx: number) => {
    e.stopPropagation();
    setActiveGuide(null);
    if (!svgRef.current || !contentRef.current) return;

    const content = contentRef.current;
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const cursor = pt.matrixTransform(content.getScreenCTM()?.inverse());

    const seg = segments[sIdx];
    const isAnchor = (seg[0] === 'C' && pIdx === 5) || ((seg[0] === 'M' || seg[0] === 'L') && pIdx === 1);
    
    if (isAnchor) {
      const px = seg[pIdx] as number;
      const py = seg[pIdx + 1] as number;

      const overlappingSIdxs: number[] = [];
      segments.forEach((s, idx) => {
         const type = s[0];
         let ax, ay;
         if (type === 'M' || type === 'L') { ax = s[1]; ay = s[2]; }
         else if (type === 'C') { ax = s[5]; ay = s[6]; }
         
         if (ax !== undefined && Math.abs(ax - px) < 0.001 && Math.abs(ay - py) < 0.001) {
            overlappingSIdxs.push(idx);
         }
      });

      if (e.shiftKey) {
        if (selectedAnchors.includes(sIdx)) {
           setSelectedAnchors(prev => prev.filter(v => !overlappingSIdxs.includes(v)));
        } else {
           setSelectedAnchors(prev => [...new Set([...prev, ...overlappingSIdxs])]);
        }
      } else if (!selectedAnchors.includes(sIdx)) {
        // Clear selection and select all overlapping
        setSelectedAnchors(overlappingSIdxs);
      }
    } else {
      // If treating handles, just clear anchor selection to focus on handle
      if (!e.shiftKey) setSelectedAnchors([]);
    }

    let isSmooth = false;
    if (seg[0] === 'C' && (pIdx === 1 || pIdx === 3)) {
      if (pIdx === 1) {
        const prevSeg = segments[sIdx - 1];
        if (prevSeg) {
           let anchorX = prevSeg[prevSeg.length - 2] as number;
           let anchorY = prevSeg[prevSeg.length - 1] as number;
           let oppDX, oppDY;
           if (prevSeg[0] === 'C') {
              oppDX = (prevSeg[3] as number) - anchorX;
              oppDY = (prevSeg[4] as number) - anchorY;
           } else if (sIdx === 1 && prevSeg[0] === 'M') {
              const lastSeg = segments[segments.length - 1];
              if (lastSeg && lastSeg[0] === 'Z') {
                 const closeC = segments[segments.length - 2];
                 if (closeC && closeC[0] === 'C' && Math.hypot((closeC[5] as number) - anchorX, (closeC[6] as number) - anchorY) < 0.1) {
                    oppDX = (closeC[3] as number) - anchorX;
                    oppDY = (closeC[4] as number) - anchorY;
                 }
              }
           }
           if (oppDX !== undefined && oppDY !== undefined) {
              const curDX = (seg[1] as number) - anchorX;
              const curDY = (seg[2] as number) - anchorY;
              const oppLen = Math.sqrt(oppDX*oppDX + oppDY*oppDY);
              const curLen = Math.sqrt(curDX*curDX + curDY*curDY);
              if (oppLen > 0.05 && curLen > 0.05) {
                  const angleOpp = Math.atan2(oppDY, oppDX);
                  const angleCur = Math.atan2(curDY, curDX);
                  const diff = Math.abs(angleOpp - angleCur);
                  const modDiff = Math.abs(diff - Math.PI) % (2 * Math.PI);
                  // Strict 0.005 rad (~0.28 deg) tolerance for SVG exports
                  if (modDiff < 0.005 || Math.abs(modDiff - 2 * Math.PI) < 0.005) {
                     isSmooth = true;
                  }
              }
           }
        }
      } else if (pIdx === 3) {
         const anchorX = seg[5] as number;
         const anchorY = seg[6] as number;
         let oppDX, oppDY;
         const nSeg = segments[sIdx + 1];
         if (nSeg && nSeg[0] === 'Z') {
             const nextOfM = segments[1];
             if (segments[0] && segments[0][0] === 'M' && nextOfM && nextOfM[0] === 'C') {
                const startX = segments[0][1] as number;
                const startY = segments[0][2] as number;
                if (Math.hypot(anchorX - startX, anchorY - startY) < 0.1) {
                   oppDX = (nextOfM[1] as number) - anchorX;
                   oppDY = (nextOfM[2] as number) - anchorY;
                }
             }
         } else if (nSeg && nSeg[0] === 'C') {
             oppDX = (nSeg[1] as number) - anchorX;
             oppDY = (nSeg[2] as number) - anchorY;
         }
         
         if (oppDX !== undefined && oppDY !== undefined) {
             const curDX = (seg[3] as number) - anchorX;
             const curDY = (seg[4] as number) - anchorY;
             const oppLen = Math.sqrt(oppDX*oppDX + oppDY*oppDY);
             const curLen = Math.sqrt(curDX*curDX + curDY*curDY);
             if (oppLen > 0.05 && curLen > 0.05) {
                 const angleOpp = Math.atan2(oppDY, oppDX);
                 const angleCur = Math.atan2(curDY, curDX);
                 const diff = Math.abs(angleOpp - angleCur);
                 const modDiff = Math.abs(diff - Math.PI) % (2 * Math.PI);
                 // Strict 0.005 rad (~0.28 deg) tolerance for SVG exports
                 if (modDiff < 0.005 || Math.abs(modDiff - 2 * Math.PI) < 0.005) {
                    isSmooth = true;
                 }
             }
         }
      }
    }

    setDragOffset({
      x: cursor.x - (seg[pIdx] as number),
      y: cursor.y - (seg[pIdx + 1] as number)
    });

    setActivePoint({
      sIdx, pIdx, 
      startPos: { x: seg[pIdx] as number, y: seg[pIdx + 1] as number },
      isSmooth
    });
  };

  const handleSvgMouseDown = (e: React.MouseEvent) => {
    // Stop propagation so it doesn't trigger parent clicks erroneously
    e.stopPropagation();
    if (!svgRef.current || !contentRef.current) return;
    
    if (e.button === 1 || (tool === 'hand' && e.button === 0)) {
      setIsPanning(true);
      return;
    }

    // Always clear the active guide when starting a new action on the canvas
    setActiveGuide(null);

    // Ignore clicks that target specifically the path itself, or controls unless they fell through
    if ((e.target as SVGElement).tagName === 'path') {
      // Allow clicking path, but do not deselect immediately
      // This helps with dragging shapes or preventing accidental deselects when aiming for a point
      // If we clicked directly on the canvas background, tag name is likely 'svg'
    }

    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const cursor = pt.matrixTransform(contentRef.current.getScreenCTM()?.inverse());

    if (tool === 'select') {
      // Only clear if clicking on the background (svg element itself, main wrapper, or container div)
      const tagName = (e.target as Element).tagName.toLowerCase();
      const isBackgroundClick = tagName === 'svg' || tagName === 'main' || (e.target as Element).id === 'main-canvas-wrapper';
      
      if (!e.shiftKey && isBackgroundClick) {
        setSelectedAnchors([]);
      }
      setSelectionBox({
        startX: cursor.x, startY: cursor.y,
        currentX: cursor.x, currentY: cursor.y
      });
      return;
    }
    
    // Ignore clicks if animating
    if (isAnimating) return;
  };

  const EASING_MATH: Record<string, (t: number) => number> = {
    linear: (t) => t,
    easeIn: (t) => t * t, 
    easeOut: (t) => t * (2 - t),
    easeInOut: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
    circIn: (t) => 1 - Math.sqrt(1 - Math.pow(t, 2)),
    circOut: (t) => Math.sqrt(1 - Math.pow(t - 1, 2)),
    backIn: (t) => { const c1 = 1.70158; const c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
    backOut: (t) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  };

  useEffect(() => {
    let controls: any;
    if (isAnimating) {
      controls = animate(0, 1, {
        duration: animDuration,
        ease: "linear", // Always animate linearly, we handle custom math locally 
        onUpdate: (latest) => setAnimProgress(latest),
        onComplete: () => setIsAnimating(false)
      });
    } else {
      setAnimProgress(1); // Show current state when not animating
    }
    return () => controls?.stop();
  }, [isAnimating, animDuration]);

  // Interpolated segments for rendering
  const displayedSegments = React.useMemo(() => {
    // If we're not currently PLAYING the animation and not RECORDING, 
    // we should show the current active working state (segments).
    if (!isAnimating && !isRecording) return segments;
    
    if (keyframes.length < 2) return segments;
    
    let globalProgress = animProgress;

    if (easingMode === 'global') {
       const easeFn = EASING_MATH[animEasing] || EASING_MATH.linear;
       globalProgress = easeFn(globalProgress);
    }
    
    const t = globalProgress * 100;
    let stepIdx = 0;
    while (stepIdx < keyframeTimes.length - 1 && t >= keyframeTimes[stepIdx + 1]) {
       stepIdx++;
    }
    if (stepIdx >= keyframeTimes.length - 1) {
       stepIdx = keyframeTimes.length - 2;
    }
    
    const t0 = keyframeTimes[stepIdx];
    const t1 = keyframeTimes[stepIdx + 1];
    let stepProgress = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    stepProgress = Math.max(0, Math.min(1, stepProgress));
    
    if (easingMode === 'local') {
       const easeFn = EASING_MATH[animEasing] || EASING_MATH.linear;
       stepProgress = easeFn(stepProgress);
    }
    
    return lerpSegments(keyframes[stepIdx], keyframes[stepIdx + 1], stepProgress);
  }, [isAnimating, isRecording, keyframes, keyframeTimes, segments, animProgress, easingMode, animEasing]);

  // Memoize strings
  const currentPathString = React.useMemo(() => stringifyPath(displayedSegments), [displayedSegments]);

  // Timeline Controls
  const addKeyframe = () => {
    const newKeyframes = [...keyframes];
    newKeyframes.push(JSON.parse(JSON.stringify(segments)));
    
    let newTimes: number[];
    if (keyframeTimes.length === 1) {
      newTimes = [0, 100];
    } else {
      // Scale down existing to make room for new one at 100
      // e.g. [0, 50, 100] -> [0, 33.3, 66.6, 100] (scaling by len-1 / len)
      const scale = (keyframeTimes.length - 1) / keyframeTimes.length;
      newTimes = keyframeTimes.map(t => t * scale);
      newTimes.push(100);
    }
    
    setKeyframeTimes(newTimes);
    setKeyframes(newKeyframes);
    const nextIdx = newKeyframes.length - 1;
    setActiveKeyIdx(nextIdx);
    pushHistory({ keyframes: newKeyframes, keyframeTimes: newTimes, activeKeyIdx: nextIdx });
  };
  
  useEffect(() => {
    bindRef.current.addKeyframe = addKeyframe;
  }, [addKeyframe]);

  const removeKeyframe = (idx: number) => {
    if (keyframes.length <= 1) return;
    const newKeyframes = keyframes.filter((_, i) => i !== idx);
    let newTimes = keyframeTimes.filter((_, i) => i !== idx);
    
    // Normalize newTimes so the last one is 100, if length > 1
    if (newTimes.length === 1) {
      newTimes = [0];
    } else {
      const maxTime = newTimes[newTimes.length - 1];
      if (maxTime > 0) {
        newTimes = newTimes.map(t => (t / maxTime) * 100);
      }
    }
    
    setKeyframeTimes(newTimes);
    setKeyframes(newKeyframes);
    const nextIdx = Math.max(0, activeKeyIdx - 1);
    setActiveKeyIdx(nextIdx);
    setSegments(JSON.parse(JSON.stringify(newKeyframes[nextIdx])));
    pushHistory({ keyframes: newKeyframes, keyframeTimes: newTimes, activeKeyIdx: nextIdx });
  };

  const selectKeyframe = (idx: number) => {
    setActiveKeyIdx(idx);
    const cloned = JSON.parse(JSON.stringify(keyframes[idx]));
    setSegments(cloned);
  };

  const [draggingTimeIdx, setDraggingTimeIdx] = useState<number | null>(null);

  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleTimelineMouseMove = (e: MouseEvent) => {
      if (draggingTimeIdx !== null && timelineRef.current) {
        let rect = timelineRef.current.getBoundingClientRect();
        let pos = (e.clientX - rect.left) / rect.width * 100;
        
        // Clamp to neighbors
        const minTime = draggingTimeIdx === 0 ? 0 : (keyframeTimes[draggingTimeIdx - 1] + 1);
        const maxTime = draggingTimeIdx === keyframeTimes.length - 1 ? 100 : (keyframeTimes[draggingTimeIdx + 1] - 1);
        
        pos = Math.max(minTime, Math.min(pos, maxTime));
        
        setKeyframeTimes(prev => {
           const next = [...prev];
           next[draggingTimeIdx] = pos;
           return next;
        });
      }
    };

    const handleTimelineMouseUp = () => {
      if (draggingTimeIdx !== null) {
        setDraggingTimeIdx(null);
        const { keyframes, keyframeTimes, activeKeyIdx, pushHistory } = bindRef.current;
        pushHistory({ keyframes, keyframeTimes, activeKeyIdx });
      }
    };

    if (draggingTimeIdx !== null) {
      window.addEventListener('mousemove', handleTimelineMouseMove);
      window.addEventListener('mouseup', handleTimelineMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleTimelineMouseMove);
      window.removeEventListener('mouseup', handleTimelineMouseUp);
    };
  }, [draggingTimeIdx, keyframeTimes]);

  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(true);
  };

  const handleDragLeave = () => {
    setIsDraggingFile(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'image/svg+xml') {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        processUploadedSvgContent(content);
      };
      reader.readAsText(file);
    }
  };

  const handleScalePath = (newWidth: number) => {
     const newKeyframes = keyframes.map(kf => scaleSegments(kf, newWidth));
     setKeyframes(newKeyframes);
     setSegments(newKeyframes[activeKeyIdx]);
     pushHistory({ keyframes: newKeyframes, keyframeTimes, activeKeyIdx });
     centerView();
  };

  return (
    <div className="flex flex-col h-screen bg-bg text-text selection:bg-accent/30 overflow-hidden font-sans">
      {/* Header */}
      <header className="h-12 bg-panel border-b border-border flex items-center justify-between px-4 z-20 shrink-0">
        <div className="flex items-center gap-3">
          <Layers className="w-4 h-4 text-accent" />
          <div className="font-bold text-sm tracking-widest text-accent uppercase">Bezier Animator</div>
          <div className="w-[1px] h-4 bg-border mx-1" />
          <div className="flex items-center gap-1">
            <button 
              onClick={undo}
              disabled={historyPtr <= 0}
              className="p-1.5 rounded hover:bg-border text-text-dim disabled:opacity-30 disabled:hover:bg-transparent transition-all"
              title="Undo (Ctrl+Z)"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button 
              onClick={redo}
              disabled={historyPtr >= history.length - 1}
              className="p-1.5 rounded hover:bg-border text-text-dim disabled:opacity-30 disabled:hover:bg-transparent transition-all"
              title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select 
            value={uiTheme} 
            onChange={(e) => setUiTheme(e.target.value as any)}
            className="bg-bg border border-border text-xs px-2 py-1.5 rounded focus:outline-none focus:border-accent text-text-dim hover:text-text transition-colors cursor-pointer"
            title="UI Theme"
          >
            <option value="dark">🌙 Dark Minimal</option>
            <option value="light">☀️ Light macOS</option>
            <option value="notion">📝 Notion Style</option>
            <option value="retro">🕹️ Synthwave Retro</option>
          </select>

          <select 
            value={exportFraming} 
            onChange={(e) => setExportFraming(e.target.value as any)}
            className="bg-bg border border-border text-xs px-2 py-1.5 rounded focus:outline-none focus:border-accent text-text-dim hover:text-text transition-colors cursor-pointer"
            title="Video Framing Area"
          >
            <option value="auto">🎯 Fit to Objects</option>
            <option value="viewport">🎥 Current Viewport</option>
          </select>

          <select 
            value={exportRes} 
            onChange={(e) => setExportRes(e.target.value as any)}
            className="bg-bg border border-border text-xs px-2 py-1.5 rounded focus:outline-none focus:border-accent text-text-dim hover:text-text transition-colors cursor-pointer"
            title="Video Export Resolution"
          >
            <option value="720p">720p HD</option>
            <option value="1080p">1080p FHD</option>
            <option value="2k">1440p 2K</option>
            <option value="4k">2160p 4K</option>
          </select>

          <button 
            disabled={isRecording}
            onClick={startRecording}
            className={cn(
              "flex items-center gap-2 px-4 py-1.5 rounded text-xs font-bold transition-all uppercase tracking-tight",
              isRecording 
                ? "bg-amber-500/20 text-amber-500 border border-amber-500/30" 
                : "bg-accent hover:bg-accent/80 text-white shadow-md shadow-accent/20"
            )}
          >
            {isRecording ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Video className="w-3.5 h-3.5" />
            )}
            {isRecording ? "Recording..." : "Export Video"}
          </button>
          <button 
            disabled={true}
            onClick={() => {
              const svgData = svgRef.current?.outerHTML;
              if (!svgData) return;
              const blob = new Blob([svgData], { type: 'image/svg+xml' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = 'edited-vector.svg';
              link.click();
            }}
            className="bg-panel border border-border text-text-dim px-4 py-1.5 rounded text-xs font-bold uppercase tracking-tight opacity-50 cursor-not-allowed"
          >
            Export SVG
          </button>
          
          <div className="w-[1px] h-4 bg-border mx-1" />
          
          <div className="flex items-center gap-2 text-text-dim text-sm">
            {user ? (
              <>
                {user.email === 'skywings38@gmail.com' && (
                  <button
                    onClick={() => setShowAdminPanel(true)}
                    className="p-1.5 text-text-dim hover:text-accent hover:bg-accent/10 rounded transition-colors"
                    title="초대 코드 관리 (관리자)"
                  >
                    <ShieldAlert className="w-4 h-4" />
                  </button>
                )}
                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-bg border border-border" title={user.email || 'User'}>
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="Profile" className="w-5 h-5 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <UserCircle className="w-5 h-5 text-accent" />
                  )}
                  <span className="text-xs truncate max-w-[100px]">{user.displayName || user.email?.split('@')[0]}</span>
                </div>
                <button
                  onClick={() => signOut(auth)}
                  className="p-1.5 text-text-dim hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                  title="Logout"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left Toolbar */}
        <aside className="w-12 bg-panel border-r border-border flex flex-col items-center py-4 gap-4 shrink-0 shadow-xl z-30">
          <div className="flex flex-col gap-2">
            <button 
              onClick={() => setTool('select')}
              className={cn(
                "w-8 h-8 flex items-center justify-center rounded-lg transition-all",
                tool === 'select' ? "bg-accent text-white shadow-lg shadow-accent/40" : "text-text-dim hover:bg-border hover:text-text"
              )}
              title="Select Tool (V)"
            >
              <MousePointer2 className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setTool('hand')}
              className={cn(
                "w-8 h-8 flex items-center justify-center rounded-lg transition-all",
                tool === 'hand' ? "bg-accent text-white shadow-lg shadow-accent/40" : "text-text-dim hover:bg-border hover:text-text"
              )}
              title="Hand Tool (H or Space)"
            >
              <Hand className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setTool('zoom')}
              className={cn(
                "w-8 h-8 flex items-center justify-center rounded-lg transition-all",
                tool === 'zoom' ? "bg-accent text-white shadow-lg shadow-accent/40" : "text-text-dim hover:bg-border hover:text-text"
              )}
              title="Zoom Tool (Z)"
            >
              <Search className="w-4 h-4" />
            </button>
          </div>

          <div className="w-6 h-[1px] bg-border my-1" />

          <div className="relative group">
            <input 
              type="file" 
              accept=".svg" 
              onChange={handleFileUpload}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
            />
            <button className="w-8 h-8 flex items-center justify-center rounded-lg text-text-dim hover:bg-border hover:text-text transition-all">
              <Upload className="w-4 h-4" />
            </button>
          </div>
          
          <button 
            onClick={centerView}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-text-dim hover:bg-border hover:text-text transition-all"
            title="Fit to Screen (F)"
          >
            <Maximize2 className="w-4 h-4" />
          </button>

          <button 
            onClick={() => {
              const resetP = JSON.parse(JSON.stringify(initialImportedPath));
              setKeyframes([resetP]);
              setKeyframeTimes([0]);
              setActiveKeyIdx(0);
              setSegments(resetP);
              pushHistory({ keyframes: [resetP], keyframeTimes: [0], activeKeyIdx: 0 });
              setTimeout(centerView, 50);
            }}
            className="w-8 h-8 rounded flex items-center justify-center text-text-dim hover:bg-rose-500/20 hover:text-rose-400 transition-all"
            title="Reset path"
          >
            <RefreshCcw className="w-4 h-4" />
          </button>
        </aside>

        {/* Main Canvas Area */}
        <main 
          className={cn(
            "flex-1 relative overflow-hidden flex items-center justify-center group transition-colors duration-300",
            isDraggingFile && "bg-accent/10 outline-2 outline-dashed outline-accent outline-offset-[-20px]"
          )}
          style={{ backgroundColor: canvasBg }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onMouseDown={(e) => {
             // If we click directly on the main background or wrapper div, trigger down 
             const target = e.target as Element;
             if (target.tagName.toLowerCase() === 'main' || target.id === 'main-canvas-wrapper') {
                 handleSvgMouseDown(e);
             }
          }}
        >
           {isDraggingFile && (
             <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
               <div className="bg-panel/90 backdrop-blur-md border border-accent p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 animate-in zoom-in duration-300">
                 <div className="w-16 h-16 rounded-full bg-accent/20 flex items-center justify-center">
                   <Upload className="w-8 h-8 text-accent animate-bounce" />
                 </div>
                 <div className="text-xl font-bold text-accent uppercase tracking-widest">Drop SVG Here</div>
                 <div className="text-xs text-text-dim">Supports .svg vector path files</div>
               </div>
             </div>
           )}
           
           {/* SVG Canvas Content */}
           
           <div 
             id="main-canvas-wrapper" 
             className="w-full h-full flex items-center justify-center p-8 relative"
           >
            
            {/* Viewport CAMERA 16:9 Guide */}
            {exportFraming === 'viewport' && (
              <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center p-8">
                <div className="w-full h-full flex items-center justify-center">
                  <div id="camera-guide-box" className="w-full aspect-video border-[3px] border-dashed border-red-500/70 rounded flex items-start justify-start overflow-hidden relative shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]">
                    <div className="bg-red-500 text-white font-black text-[10px] px-2 py-0.5 rounded-br uppercase tracking-widest flex items-center gap-1.5 z-10 backdrop-blur shadow-sm">
                      <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                      REC AREA (16:9)
                    </div>
                  </div>
                </div>
              </div>
            )}

            <svg 
              ref={svgRef}
              viewBox="0 0 300 300" 
              xmlns="http://www.w3.org/2000/svg"
              className={cn(
                "w-full h-full overflow-visible touch-none",
                !activePoint && !isAnimating && "transition-transform duration-300",
                tool === 'hand' && "cursor-grab",
                tool === 'hand' && isPanning && "cursor-grabbing",
                tool === 'zoom' && "cursor-zoom-in"
              )}
              onWheel={handleWheel}
              onMouseDown={handleSvgMouseDown}
              onClick={(e) => {
                if (tool === 'zoom') {
                  if (!svgRef.current || !contentRef.current) return;
                  const pt = svgRef.current.createSVGPoint();
                  pt.x = e.clientX;
                  pt.y = e.clientY;
                  const cursor = pt.matrixTransform(contentRef.current.getScreenCTM()?.inverse());
                  
                  const factor = e.altKey ? 0.8 : 1.25;
                  const newZoom = Math.min(Math.max(zoom * factor, 0.1), 10);
                  
                  const newPanX = pan.x + cursor.x * (zoom - newZoom);
                  const newPanY = pan.y + cursor.y * (zoom - newZoom);
                  
                  setZoom(newZoom);
                  setPan({ x: newPanX, y: newPanY });
                }
              }}
            >
              <g 
                ref={contentRef}
                style={{ 
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` 
                }}
              >
                {/* Back Guides */}
                {guideZIndex === 'back' && guides.map(g => (
                  <g key={g.id}>
                    <line
                      x1={g.type === 'vertical' ? g.position : -10000}
                      y1={g.type === 'horizontal' ? g.position : -10000}
                      x2={g.type === 'vertical' ? g.position : 10000}
                      y2={g.type === 'horizontal' ? g.position : 10000}
                      stroke={activeGuide === g.id ? '#3b82f6' : guideColor}
                      strokeWidth={activeGuide === g.id ? guideThickness + 1 : guideThickness}
                      className="pointer-events-none"
                      strokeDasharray={`5, 5`}
                    />
                    {tool === 'select' && (
                      <line
                        x1={g.type === 'vertical' ? g.position : -10000}
                        y1={g.type === 'horizontal' ? g.position : -10000}
                        x2={g.type === 'vertical' ? g.position : 10000}
                        y2={g.type === 'horizontal' ? g.position : 10000}
                        stroke="transparent"
                        strokeWidth={12 / zoom}
                        style={{ cursor: g.type === 'horizontal' ? 'row-resize' : 'col-resize' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setActiveGuide(g.id);
                          setDraggingGuide(g.id);
                        }}
                      />
                    )}
                  </g>
                ))}

                <path 
                  d={currentPathString}
                  fill={fill}
                  fillOpacity={fillOpacity}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {/* Front Guides */}
                {guideZIndex === 'front' && guides.map(g => (
                  <g key={g.id}>
                    <line
                      x1={g.type === 'vertical' ? g.position : -10000}
                      y1={g.type === 'horizontal' ? g.position : -10000}
                      x2={g.type === 'vertical' ? g.position : 10000}
                      y2={g.type === 'horizontal' ? g.position : 10000}
                      stroke={activeGuide === g.id ? '#3b82f6' : guideColor}
                      strokeWidth={activeGuide === g.id ? guideThickness + 1 : guideThickness}
                      className="pointer-events-none"
                      strokeDasharray={`5, 5`}
                    />
                    {tool === 'select' && (
                      <line
                        x1={g.type === 'vertical' ? g.position : -10000}
                        y1={g.type === 'horizontal' ? g.position : -10000}
                        x2={g.type === 'vertical' ? g.position : 10000}
                        y2={g.type === 'horizontal' ? g.position : 10000}
                        stroke="transparent"
                        strokeWidth={12 / zoom}
                        style={{ cursor: g.type === 'horizontal' ? 'row-resize' : 'col-resize' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setActiveGuide(g.id);
                          setDraggingGuide(g.id);
                        }}
                      />
                    )}
                  </g>
                ))}

                {/* Selection Box Overlay */}
                {selectionBox && (() => {
                  const x = Math.min(selectionBox.startX, selectionBox.currentX);
                  const y = Math.min(selectionBox.startY, selectionBox.currentY);
                  const w = Math.abs(selectionBox.startX - selectionBox.currentX);
                  const h = Math.abs(selectionBox.startY - selectionBox.currentY);
                  return (
                    <rect 
                      x={x} y={y} width={w} height={h}
                      fill="rgba(59, 130, 246, 0.1)"
                      stroke="rgba(59, 130, 246, 0.8)"
                      strokeWidth={1 / zoom}
                      strokeDasharray={`${4/zoom} ${4/zoom}`}
                      className="pointer-events-none"
                    />
                  );
                })()}

                {(!isAnimating || showControlsDuringAnim) && (() => {
                  const handleLines: React.ReactNode[] = [];
                  const handles: React.ReactNode[] = [];
                  const anchors: React.ReactNode[] = [];

                  const addHandlePoint = (x: number, y: number, pIdx: number, anchorX: number, anchorY: number, sIdx: number) => {
                    if (Math.hypot(x - anchorX, y - anchorY) < 0.1) return;

                    handleLines.push(
                      <line 
                        key={`HL-${sIdx}-${pIdx}`} 
                        x1={anchorX} y1={anchorY} x2={x} y2={y} 
                        stroke={handleLineColor} 
                        strokeWidth={handleLineWidth} 
                        strokeLinecap="butt"
                        className="opacity-100"
                      />
                    );
                    
                    const commonHandleProps = {
                      fill: handleColor,
                      fillOpacity: handleFillOpacity,
                      stroke: handleLineColor,
                      strokeWidth: handleLineWidth,
                      className: cn(
                        "pointer-events-none",
                        !activePoint && !isAnimating && "transition-transform duration-200"
                      ),
                      style: { transformOrigin: 'center', transformBox: 'fill-box' } as React.CSSProperties,
                    };

                    // Calculate rotation for I-shape (perpendicular to handle line)
                    const angle = Math.atan2(y - anchorY, x - anchorX);
                    const angleDeg = (angle * 180) / Math.PI;

                    handles.push(
                      <g key={`H-${sIdx}-${pIdx}`} className="group/handle">
                        {!isAnimating && tool === 'select' && (
                          <circle 
                            cx={x} cy={y} r={10} 
                            fill="transparent" 
                            className="cursor-move"
                            onMouseDown={(e) => handleMouseDown(e, sIdx, pIdx)}
                          />
                        )}
                        
                        {handleStyle === 'circle' && (
                          <circle cx={x} cy={y} r={handleSize} {...commonHandleProps} className={cn(commonHandleProps.className, "group-hover/handle:scale-150")} />
                        )}
                        {handleStyle === 'square' && (
                          <rect 
                            x={x - handleSize} 
                            y={y - handleSize} 
                            width={(handleSize * 2)} 
                            height={(handleSize * 2)} 
                            {...commonHandleProps} 
                            className={cn(commonHandleProps.className, "group-hover/handle:scale-150")}
                          />
                        )}
                        {handleStyle === 'x-shape' && (
                          <g 
                            {...commonHandleProps} 
                            className={cn(commonHandleProps.className, "group-hover/handle:scale-125")}
                            style={{ ...commonHandleProps.style, transform: `rotate(${angleDeg}deg)` }}
                          >
                            <line x1={x - handleSize} y1={y - handleSize} x2={x + handleSize} y2={y + handleSize} stroke={handleLineColor} strokeWidth={handleLineWidth} />
                            <line x1={x + handleSize} y1={y - handleSize} x2={x - handleSize} y2={y + handleSize} stroke={handleLineColor} strokeWidth={handleLineWidth} />
                          </g>
                        )}
                        {handleStyle === 'i-shape' && (
                          <line 
                            x1={x} 
                            y1={y - handleSize} 
                            x2={x} 
                            y2={y + handleSize} 
                            stroke={handleLineColor}
                            strokeWidth={handleLineWidth}
                            {...commonHandleProps} 
                            fill="none"
                            className={cn(commonHandleProps.className, "group-hover/handle:scale-150")}
                            style={{ ...commonHandleProps.style, transform: `rotate(${angleDeg}deg)` }}
                          />
                        )}
                      </g>
                    );
                  };

                  const addAnchorPoint = (x: number, y: number, pIdx: number, sIdx: number) => {
                    const isActive = (activePoint?.sIdx === sIdx && activePoint?.pIdx === pIdx) || liveSelectedAnchors.includes(sIdx);
                    
                    let angleDeg = 0;
                    let showIShape = true;

                    if (pointStyle === 'i-shape') {
                        const seg = displayedSegments[sIdx];
                        const nextSeg = displayedSegments[sIdx + 1];
                        
                        let hasInHandle = false;
                        let vIn: [number, number] | null = null;
                    
                        if (seg && seg[0] === 'C') {
                            const hx = seg[3] as number, hy = seg[4] as number;
                            if (Math.hypot(hx - x, hy - y) > 0.05) { 
                                vIn = [hx - x, hy - y]; 
                                hasInHandle = true; 
                            }
                        }
                        if (!vIn) {
                            let prevSeg = displayedSegments[sIdx - 1];
                            if (!prevSeg && sIdx === 0 && displayedSegments[displayedSegments.length - 1]?.[0] === 'Z') {
                                prevSeg = displayedSegments[displayedSegments.length - 2];
                            }
                            if (prevSeg) {
                                const px = prevSeg[prevSeg.length - 2] as number, py = prevSeg[prevSeg.length - 1] as number;
                                if (Math.hypot(px - x, py - y) > 0.05) vIn = [px - x, py - y];
                            }
                        }
                        
                        let hasOutHandle = false;
                        let vOut: [number, number] | null = null;
                        let testNextSeg = nextSeg;
                        if (testNextSeg && testNextSeg[0] === 'Z') {
                             testNextSeg = displayedSegments[1]; 
                        }
                        if (testNextSeg && testNextSeg[0] === 'C') {
                            const hx = testNextSeg[1] as number, hy = testNextSeg[2] as number;
                            if (Math.hypot(hx - x, hy - y) > 0.05) { 
                                vOut = [hx - x, hy - y]; 
                                hasOutHandle = true; 
                            }
                        }
                        if (!vOut && testNextSeg && (testNextSeg[0] === 'M' || testNextSeg[0] === 'L' || testNextSeg[0] === 'C')) {
                            const nx = testNextSeg[testNextSeg.length - 2] as number, ny = testNextSeg[testNextSeg.length - 1] as number;
                            if (Math.hypot(nx - x, ny - y) > 0.05) vOut = [nx - x, ny - y];
                        }
                        
                        if (!hasInHandle && !hasOutHandle) {
                            showIShape = false;
                        } else {
                            let uIn: [number, number] | null = null;
                            if (vIn) {
                                 const len = Math.hypot(vIn[0], vIn[1]);
                                 uIn = [vIn[0]/len, vIn[1]/len];
                            }
                            let uOut: [number, number] | null = null;
                            if (vOut) {
                                 const len = Math.hypot(vOut[0], vOut[1]);
                                 uOut = [vOut[0]/len, vOut[1]/len];
                            }
                    
                            let dX = 0, dY = 0;
                            if (uIn && uOut) {
                                dX = uOut[0] - uIn[0];
                                dY = uOut[1] - uIn[1];
                                if (Math.hypot(dX, dY) < 0.001) {
                                     dX = -uIn[1];
                                     dY = uIn[0];
                                }
                            } else if (uIn) {
                                dX = -uIn[0];
                                dY = -uIn[1];
                            } else if (uOut) {
                                dX = uOut[0];
                                dY = uOut[1];
                            }
                            angleDeg = (Math.atan2(dY, dX) * 180) / Math.PI;
                        }
                    }
                    
                    const commonProps = {
                      className: cn(
                        "pointer-events-none shadow-md",
                        !activePoint && !isAnimating && "transition-all duration-200",
                        isActive ? "fill-accent stroke-accent scale-125" : ""
                      ),
                      style: { transformOrigin: 'center', transformBox: 'fill-box', ...(pointStyle === 'i-shape' ? { transform: `rotate(${angleDeg}deg)` } : {}) } as React.CSSProperties,
                      fill: isActive ? undefined : anchorColor,
                      fillOpacity: isActive ? undefined : anchorFillOpacity,
                      stroke: isActive ? undefined : anchorStrokeColor,
                      strokeWidth: handleLineWidth
                    };

                    anchors.push(
                      <g key={`A-${sIdx}-${pIdx}`} className="group/anchor">
                        {!isAnimating && tool === 'select' && (
                          <circle 
                            cx={x} cy={y} r={12} 
                            fill="transparent" 
                            className="cursor-move"
                            onMouseDown={(e) => handleMouseDown(e, sIdx, pIdx)}
                          />
                        )}
                        {pointStyle === 'square' && <rect x={x - anchorSize} y={y - anchorSize} width={(anchorSize * 2)} height={(anchorSize * 2)} rx="0" {...commonProps} />}
                        {pointStyle === 'circle' && <circle cx={x} cy={y} r={anchorSize} {...commonProps} />}
                        {pointStyle === 'i-shape' && showIShape && (
                          <line 
                            x1={x} 
                            y1={y - anchorSize} 
                            x2={x} 
                            y2={y + anchorSize} 
                            stroke={anchorStrokeColor}
                            strokeWidth={handleLineWidth}
                            {...commonProps} 
                            fill="none" 
                          />
                        )}
                      </g>
                    );
                  };

                  displayedSegments.forEach((seg, sIdx) => {
                    const type = seg[0];
                    if (type === 'M' || type === 'L') {
                      addAnchorPoint(seg[1], seg[2], 1, sIdx);
                    } else if (type === 'C') {
                      const prevSeg = displayedSegments[sIdx - 1];
                      const startX = prevSeg?.[prevSeg.length - 2] ?? 0;
                      const startY = prevSeg?.[prevSeg.length - 1] ?? 0;
                      addHandlePoint(seg[1], seg[2], 1, startX, startY, sIdx);
                      addHandlePoint(seg[3], seg[4], 3, seg[5], seg[6], sIdx);
                      addAnchorPoint(seg[5], seg[6], 5, sIdx);
                    }
                  });

                  // Draw corner widgets!
                  const cornerWidgets: React.ReactNode[] = [];
                  if (!isAnimating && tool === 'select') {
                    const corners = findCorners(displayedSegments);
                    corners.forEach((corner, idx) => {
                       // Only show corner widget if its corresponding anchor is selected, OR if we are currently dragging a corner 
                       // (since during a corner drag we might want to see widgets on all actively selected/dragged corners)
                       const isCornerActive = liveSelectedAnchors.includes(corner.sIdx) || 
                          (corner.curveIdx !== undefined && liveSelectedAnchors.includes(corner.curveIdx)) ||
                          (cornerDrag?.corner.sIdx === corner.sIdx);
                          
                       if (!isCornerActive) return;

                       const u = { x: corner.prevX - corner.pX, y: corner.prevY - corner.pY };
                       const lu = Math.sqrt(u.x*u.x + u.y*u.y);
                       u.x /= lu; u.y /= lu;

                       const v = { x: corner.nextX - corner.pX, y: corner.nextY - corner.pY };
                       const lv = Math.sqrt(v.x*v.x + v.y*v.y);
                       v.x /= lv; v.y /= lv;
                       
                       let dirX = u.x + v.x;
                       let dirY = u.y + v.y;
                       const ld = Math.sqrt(dirX*dirX + dirY*dirY);
                       if (ld > 0.001) {
                         dirX /= ld; dirY /= ld;
                         const widgetBase = 14 / zoom;
                         const currentRadiusOffset = corner.currentRadius ? (corner.currentRadius / Math.sin(Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y))) / 2)) : 0;
                         const widgetDist = widgetBase + currentRadiusOffset;
                         
                         const wx = corner.pX + dirX * widgetDist;
                         const wy = corner.pY + dirY * widgetDist;
                         
                         cornerWidgets.push(
                           <g key={`corner-${idx}`} className="group/corner">
                             <circle 
                               cx={wx} cy={wy} r={10 / zoom} 
                               fill="transparent" 
                               className="cursor-pointer"
                               onMouseDown={(e) => {
                                 e.stopPropagation();
                                 if (!svgRef.current || !contentRef.current) return;
                                 const pt = svgRef.current.createSVGPoint();
                                 pt.x = e.clientX;
                                 pt.y = e.clientY;
                                 const cursor = pt.matrixTransform(contentRef.current.getScreenCTM()?.inverse());
                                 
                                 setCornerDrag({
                                   originalSegments: JSON.parse(JSON.stringify(segments)),
                                   originalKeyframes: JSON.parse(JSON.stringify(keyframes)),
                                   keyframeIdx: activeKeyIdx,
                                   corner,
                                   dirX, dirY,
                                   startX: cursor.x,
                                   startY: cursor.y
                                 });
                               }}
                             />
                             <circle 
                               cx={wx} cy={wy} r={2.5 / zoom} 
                               fill="white" 
                               stroke="#3b82f6"
                               strokeWidth={1.5 / zoom}
                               className={cn(
                                 "pointer-events-none transition-transform origin-center",
                                 (cornerDrag?.corner.sIdx === corner.sIdx) ? "scale-150" : "group-hover/corner:scale-150"
                               )}
                               style={{ transformOrigin: `${wx}px ${wy}px` }}
                             />
                           </g>
                         );
                       }
                    });
                  }

                  return (
                    <g className="controls" style={{ pointerEvents: 'auto' }}>
                      <g className="handle-lines">{handleLines}</g>
                      <g className="handles">{handles}</g>
                      <g className="anchors">{anchors}</g>
                      <g className="corners">{cornerWidgets}</g>
                    </g>
                  );
                })()}
              </g>
            </svg>
          </div>
        </main>

        {/* Right Inspector */}
        <aside className="w-[280px] bg-panel border-l border-border p-5 flex flex-col gap-6 overflow-y-auto shrink-0 shadow-lg">
          <div className="flex flex-col gap-5">
            <div>
              <div className="text-[11px] font-bold text-text-dim uppercase tracking-widest border-b border-border pb-1.5 mb-4">Project</div>
              
              <div className="space-y-4">
                <button 
                  onClick={() => {
                    setSegments([]);
                    setKeyframes([[]]);
                    setKeyframeTimes([0]);
                    setActiveKeyIdx(0);
                    pushHistory({ keyframes: [[]], keyframeTimes: [0], activeKeyIdx: 0 });
                  }}
                  className="w-full h-8 flex items-center justify-center gap-2 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-bold transition-all border border-rose-500/20 uppercase tracking-tight"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear Current Path
                </button>

                <ColorInput label="Canvas Color" value={canvasBg} onChange={setCanvasBg} />
                
                <PathWidthModifier segments={segments} onApply={handleScalePath} />
              </div>

              <div className="relative group mt-4">
                <input 
                  type="file" 
                  accept=".svg" 
                  onChange={handleFileUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                <button className="w-full bg-border hover:bg-border/80 text-text py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-colors border border-border/50">
                  <Upload className="w-4 h-4" />
                  IMPORT NEW SVG
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between border-b border-border pb-1.5 mb-4">
                <div className="text-[11px] font-bold text-text-dim uppercase tracking-widest">Style Presets</div>
                {user && !isSavingPreset && (
                  <button 
                    onClick={handleSavePresetClick}
                    disabled={presets.length >= 10}
                    className="text-[10px] bg-accent/20 text-accent px-2 py-0.5 rounded font-bold hover:bg-accent/30 transition-colors disabled:opacity-50"
                  >
                    SAVE
                  </button>
                )}
              </div>
              {isSavingPreset ? (
                <div className="mb-4 bg-surface p-2 rounded border border-border flex flex-col gap-2">
                  <input 
                    type="text" 
                    value={presetInputName}
                    onChange={e => setPresetInputName(e.target.value)}
                    className="w-full text-xs bg-background border border-border rounded px-2 py-1 outline-none focus:border-accent text-text"
                    placeholder="프리셋 이름"
                    autoFocus
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        confirmSavePreset();
                      }
                      if (e.key === 'Escape') setIsSavingPreset(false);
                    }}
                  />
                  {presetError && <div className="text-[10px] text-red-500 font-medium leading-tight">{presetError}</div>}
                  <div className="flex gap-1 justify-end">
                    <button 
                      onClick={() => setIsSavingPreset(false)}
                      className="text-[10px] px-2 py-1 text-text-dim hover:text-text"
                    >
                      취소
                    </button>
                    <button 
                      onClick={confirmSavePreset}
                      disabled={isPresetsLoading}
                      className="text-[10px] bg-accent text-background px-2 py-1 rounded font-bold hover:opacity-90 disabled:opacity-50"
                    >
                      {isPresetsLoading ? '저장 중...' : '확인'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {presetLoadError && (
                    <div className="text-xs text-red-400 text-center py-2 bg-background border border-border rounded opacity-70">
                      <p>로드 실패: {presetLoadError}</p>
                    </div>
                  )}

                  {!user && (
                    <div className="text-xs text-text-dim text-center py-2 bg-background border border-border rounded opacity-70">
                      <p>로그인하여 내 프리셋 저장</p>
                    </div>
                  )}

                  {(isPresetsLoading ? BUILTIN_PRESETS : [...BUILTIN_PRESETS, ...presets]).map(p => (
                    <div 
                      key={p.id} 
                      onClick={() => applyPreset(p.settings)}
                      className="group flex flex-col p-2 bg-background border border-border rounded cursor-pointer hover:border-accent hover:bg-accent/5 transition-all"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-text truncate pr-2 max-w-[140px]">{p.name} {p.id.startsWith('builtin-') && <span className="text-[10px] bg-border px-1 ml-1 rounded text-text-dim font-normal">공용</span>}</span>
                        {!p.id.startsWith('builtin-') && (
                          <button 
                            onClick={(e) => deletePreset(p.id, e)}
                            className="text-text-dim hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="flex gap-1.5 flex-wrap">
                        {/* Preview dots for key colors */}
                        <div className="w-4 h-4 rounded-full border border-border shadow-sm" style={{ backgroundColor: p.settings.fill }} title="Fill" />
                        <div className="w-4 h-4 rounded-full border border-border shadow-sm flex items-center justify-center" style={{ backgroundColor: p.settings.stroke }} title="Stroke">
                           <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.settings.canvasBg }} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {user && (
                    <div className="text-[10px] text-text-dim text-right mt-1">{presets.length} / 10</div>
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="text-[11px] font-bold text-text-dim uppercase tracking-widest border-b border-border pb-1.5 mb-4">Fill & Stroke</div>
              <div className="space-y-4">
                <ColorInput label="Fill Color" value={fill} onChange={setFill} />
                
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Fill Opacity</span>
                    <span>{Math.round(fillOpacity * 100)}%</span>
                  </div>
                  <input 
                    type="range" min="0" max="1" step="0.01" 
                    value={fillOpacity}
                    onChange={(e) => setFillOpacity(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>

                <ColorInput label="Stroke Color" value={stroke} onChange={setStroke} />

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Stroke Width</span>
                    <span>{strokeWidth}px</span>
                  </div>
                  <input 
                    type="range" 
                    min="0.1" max="20" step="0.1"
                    value={strokeWidth}
                    onChange={(e) => setStrokeWidth(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            <div>
              <div className="text-[11px] font-bold text-text-dim uppercase tracking-widest border-b border-border pb-1.5 mb-4">Anchor Options</div>
              
              <div className="mb-4 p-2 bg-accent/5 rounded border border-accent/10">
                <p className="text-[10px] text-accent font-medium leading-tight">
                  <kbd className="bg-panel px-1 rounded border border-border shadow-sm">Alt</kbd> 키를 누른 채 핸들을 드래그하면 연결을 끊고 각진 모서리를 만들 수 있습니다.
                </p>
              </div>

              <div className="space-y-4">
                <ColorInput label="Anchor Color" value={anchorColor} onChange={setAnchorColor} />
                <ColorInput label="Anchor Stroke" value={anchorStrokeColor} onChange={setAnchorStrokeColor} />

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Anchor Size</span>
                    <span>{anchorSize}px</span>
                  </div>
                  <input 
                    type="range" min="1" max="12" step="0.1" 
                    value={anchorSize}
                    onChange={(e) => setAnchorSize(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Anchor Fill Opacity</span>
                    <span>{Math.round(anchorFillOpacity * 100)}%</span>
                  </div>
                  <input 
                    type="range" min="0" max="1" step="0.01" 
                    value={anchorFillOpacity}
                    onChange={(e) => setAnchorFillOpacity(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Anchor Shape</span>
                  <div className="flex gap-2">
                    {(['circle', 'square', 'i-shape'] as const).map(style => (
                      <button
                        key={style}
                        onClick={() => setPointStyle(style)}
                        className={cn(
                          "w-7 h-7 flex items-center justify-center rounded border transition-all duration-200 text-sm",
                          pointStyle === style 
                            ? "bg-accent/10 border-accent text-accent shadow-sm" 
                            : "bg-transparent border-border text-text-dim hover:border-text-dim/50"
                        )}
                      >
                        {style === 'circle' && "○"}
                        {style === 'square' && "□"}
                        {style === 'i-shape' && "I"}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="w-full h-px bg-border/50 my-2" />

                <ColorInput label="Handle Color" value={handleColor} onChange={setHandleColor} />

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Handle Size</span>
                    <span>{handleSize}px</span>
                  </div>
                  <input 
                    type="range" min="1" max="10" step="0.1" 
                    value={handleSize}
                    onChange={(e) => setHandleSize(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Handle Fill Opacity</span>
                    <span>{Math.round(handleFillOpacity * 100)}%</span>
                  </div>
                  <input 
                    type="range" min="0" max="1" step="0.01" 
                    value={handleFillOpacity}
                    onChange={(e) => setHandleFillOpacity(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Handle Shape</span>
                  <div className="flex gap-2">
                    {(['circle', 'square', 'x-shape', 'i-shape'] as const).map(style => (
                      <button
                        key={style}
                        onClick={() => setHandleStyle(style)}
                        className={cn(
                          "w-7 h-7 flex items-center justify-center rounded border transition-all duration-200 text-sm",
                          handleStyle === style 
                            ? "bg-accent/10 border-accent text-accent shadow-sm" 
                            : "bg-transparent border-border text-text-dim hover:border-text-dim/50"
                        )}
                      >
                        {style === 'circle' && "○"}
                        {style === 'square' && "□"}
                        {style === 'x-shape' && "╳"}
                        {style === 'i-shape' && "I"}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="w-full h-px bg-border/50 my-2" />

                <ColorInput label="Line Color" value={handleLineColor} onChange={setHandleLineColor} />

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Line Width</span>
                    <span>{handleLineWidth}px</span>
                  </div>
                  <input 
                    type="range" min="0" max="5" step="0.1" 
                    value={handleLineWidth}
                    onChange={(e) => setHandleLineWidth(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            {/* Guides Panel */}
            <div>
              <div className="text-[11px] font-bold text-text-dim uppercase tracking-widest border-b border-border pb-1.5 mb-4">Guides</div>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Snap to Guides</span>
                  <div 
                    onClick={() => setSnapToGuides(!snapToGuides)}
                    className={cn(
                      "w-8 h-4 rounded-full relative transition-colors duration-200 cursor-pointer",
                      snapToGuides ? "bg-accent" : "bg-border"
                    )}
                  >
                    <div className={cn(
                      "absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200",
                      snapToGuides ? "left-[18px]" : "left-0.5"
                    )} />
                  </div>
                </div>

                <ColorInput label="Guide Color" value={guideColor} onChange={setGuideColor} />
                
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Thickness</span>
                    <span>{guideThickness}px</span>
                  </div>
                  <input 
                    type="range" min="0.1" max="5" step="0.1" 
                    value={guideThickness}
                    onChange={(e) => setGuideThickness(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-text-dim">Z-Index</span>
                  <select 
                    value={guideZIndex}
                    onChange={(e) => setGuideZIndex(e.target.value as 'front' | 'back')}
                    className="bg-bg border border-border text-[11px] rounded px-2 py-1 outline-none text-text-dim focus:text-text focus:border-accent cursor-pointer"
                  >
                    <option value="front">Front</option>
                    <option value="back">Back</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button
                    onClick={() => {
                      const newGuide: GuideLine = { id: Date.now().toString(), type: 'horizontal', position: pan.y ? -pan.y / zoom : 150 };
                      setGuides([...guides, newGuide]);
                    }}
                    className="text-xs py-1.5 px-2 rounded border border-border bg-panel hover:bg-border/50 transition-colors"
                  >
                    + H Guide
                  </button>
                  <button
                    onClick={() => {
                      const newGuide: GuideLine = { id: Date.now().toString(), type: 'vertical', position: pan.x ? -pan.x / zoom : 150 };
                      setGuides([...guides, newGuide]);
                    }}
                    className="text-xs py-1.5 px-2 rounded border border-border bg-panel hover:bg-border/50 transition-colors"
                  >
                    + V Guide
                  </button>
                </div>
                
                {guides.length > 0 && (
                  <div className="space-y-2 mt-2 max-h-32 overflow-y-auto">
                    {guides.map(g => (
                      <div key={g.id} className="flex items-center gap-2 group">
                        <span className="text-[10px] font-mono text-text-dim uppercase w-4">{g.type === 'horizontal' ? 'H' : 'V'}</span>
                        <input 
                          type="number"
                          value={Math.round(g.position)}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setGuides(guides.map(guide => guide.id === g.id ? { ...guide, position: val } : guide));
                          }}
                          className="flex-1 bg-bg border border-border rounded px-1.5 h-6 text-xs outline-none focus:border-accent"
                        />
                        <button
                          onClick={() => setGuides(guides.filter(guide => guide.id !== g.id))}
                          className="text-rose-500/50 hover:text-rose-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-bold text-text-dim uppercase tracking-widest border-b border-border pb-1.5 mb-4">Animation Settings</div>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] uppercase font-bold text-text-dim">
                    <span>Duration</span>
                    <span>{animDuration.toFixed(1)}s</span>
                  </div>
                  <input 
                    type="range" min="0.1" max="10" step="0.1" 
                    value={animDuration}
                    onChange={(e) => setAnimDuration(Number(e.target.value))}
                    className="w-full h-1 accent-accent rounded-full appearance-none bg-border mt-1 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Easing Curve</span>
                  <select 
                    value={animEasing}
                    onChange={(e) => setAnimEasing(e.target.value)}
                    className="bg-bg border border-border text-[11px] rounded px-2 py-1 outline-none text-text-dim focus:text-text focus:border-accent"
                  >
                    <option value="linear">Linear</option>
                    <option value="easeInOut">Ease In Out</option>
                    <option value="easeIn">Ease In</option>
                    <option value="easeOut">Ease Out</option>
                    <option value="circIn">Circ In</option>
                    <option value="circOut">Circ Out</option>
                    <option value="backIn">Back In</option>
                    <option value="backOut">Back Out</option>
                  </select>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-text-dim truncate">Easing Targeting</span>
                  <select 
                    value={easingMode}
                    onChange={(e) => setEasingMode(e.target.value as 'global' | 'local')}
                    className="bg-bg border border-border text-[11px] rounded px-2 py-1 outline-none text-text-dim focus:text-text focus:border-accent"
                  >
                    <option value="local">Per-Keyframe (Local)</option>
                    <option value="global">Entire Video (Global)</option>
                  </select>
                </div>

                <label className="flex items-center justify-between cursor-pointer group">
                  <span className="text-xs font-medium">Show Points</span>
                  <div 
                    onClick={() => setShowControlsDuringAnim(!showControlsDuringAnim)}
                    className={cn(
                      "w-8 h-4 rounded-full relative transition-colors duration-200",
                      showControlsDuringAnim ? "bg-accent" : "bg-border"
                    )}
                  >
                    <div className={cn(
                      "absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200",
                      showControlsDuringAnim ? "left-[18px]" : "left-0.5"
                    )} />
                  </div>
                </label>
              </div>
            </div>

            <div className="mt-4 p-3 bg-bg rounded border border-border space-y-2">
              <div className="text-[10px] font-bold text-text-dim uppercase tracking-widest mb-1">Active Point Info</div>
              <div className="flex items-center justify-between font-mono text-[10px] text-text-dim">
                <span>SEGMENT: #{activePoint?.sIdx ?? 'None'}</span>
                <span>INDEX: #{activePoint?.pIdx ?? 'None'}</span>
              </div>
              {activePoint && (
                <div className="flex items-center justify-between font-mono text-[10px] text-accent font-bold">
                  <span>X: {segments[activePoint.sIdx][activePoint.pIdx].toFixed(2)}</span>
                  <span>Y: {segments[activePoint.sIdx][activePoint.pIdx+1].toFixed(2)}</span>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Bottom Animation Bar */}
      <footer className="h-[140px] bg-panel border-t border-border p-4 flex flex-col gap-4 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="text-[11px] font-bold text-text-dim uppercase tracking-widest">Animation Timeline</div>
            <button 
              onClick={addKeyframe}
              className="bg-accent/10 hover:bg-accent/20 text-accent px-3 py-1 rounded text-[10px] font-bold transition-colors uppercase border border-accent/20"
              title="Capture current canvas state as a new keyframe"
            >
              + Add Keyframe
            </button>
          </div>
          
          <button 
            onClick={() => setIsAnimating(!isAnimating)}
            className={cn(
              "px-5 py-2 rounded text-xs font-bold transition-all duration-300 flex items-center gap-2",
              isAnimating 
                ? "bg-rose-500 text-white shadow-[0_0_20px_rgba(244,63,94,0.3)]" 
                : "bg-emerald-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.3)]"
            )}
          >
            {isAnimating ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
            {isAnimating ? "STOP" : "PLAY TIMELINE"}
          </button>
        </div>
        
        <div className="flex-1 border border-border rounded-lg bg-bg relative flex items-center px-12 group/timeline overflow-hidden">
          {/* Keyframe Track */}
          <div className="flex-1 h-0.5 bg-border mx-4 relative" ref={timelineRef}>
             <div 
               style={{ width: `${animProgress * 100}%` }}
               className="h-full bg-accent shadow-[0_0_10px_var(--color-accent)] opacity-30"
             />

             {/* Keyframes */}
             {keyframes.map((_, idx) => {
               const pos = keyframeTimes[idx] ?? 0;
               return (
                 <div 
                   key={`kf-${idx}`}
                   style={{ left: `${pos}%` }}
                   className={cn(
                     "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 transition cursor-pointer z-10 flex items-center justify-center group/kf focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-panel focus-visible:ring-accent",
                     idx === activeKeyIdx ? "border-accent bg-panel scale-125 shadow-[0_0_8px_var(--color-accent)]" : "border-text-dim bg-panel hover:border-accent",
                     draggingTimeIdx === idx && "z-20 scale-125 shadow-lg"
                   )}
                   tabIndex={0}
                   onMouseDown={(e) => {
                     e.stopPropagation();
                     selectKeyframe(idx);
                     setDraggingTimeIdx(idx);
                   }}
                   onKeyDown={(e) => {
                     if (e.key === 'Delete' || e.key === 'Backspace') {
                       e.stopPropagation();
                       removeKeyframe(idx);
                     }
                   }}
                 >
                   <div className={cn(
                     "w-1.5 h-1.5 rounded-full transition-colors",
                     idx === activeKeyIdx ? "bg-accent" : "bg-text-dim group-hover/kf:bg-accent"
                   )} />
                   <div className="absolute -top-6 text-[9px] font-bold text-text-dim whitespace-nowrap uppercase group-hover/kf:text-accent">
                     {idx === 0 ? "START" : `STEP ${idx}`}
                   </div>
                   
                   {/* Delete button on hover */}
                   {keyframes.length > 1 && (
                     <button 
                       onClick={(e) => {
                         e.stopPropagation();
                         removeKeyframe(idx);
                       }}
                       className="absolute -bottom-6 opacity-0 group-hover/kf:opacity-100 text-rose-400 hover:text-rose-500 transition-opacity"
                     >
                       <Trash2 className="w-2.5 h-2.5" />
                     </button>
                   )}
                 </div>
               );
             })}
          </div>
          
          {/* Animated Playback Scrubber */}
          <div 
            style={{ left: `calc(${animProgress * 100}% + (40px - ${animProgress * 80}px))` }}
            className="absolute top-0 w-0.5 h-full bg-white shadow-[0_0_15px_white] z-20 pointer-events-none"
          />
        </div>

        <div className="flex justify-between text-[10px] text-text-dim px-2 tracking-tight">
          <div className="flex gap-4">
            <span>{isAnimating ? `Animating ${keyframes.length} steps...` : `${keyframes.length} keyframes defined.`}</span>
          </div>
          <span className="font-mono uppercase">DURATION: {animDuration.toFixed(1)}s • EASE: {animEasing} • {keyframes.length - 1} TRANSITIONS</span>
        </div>
      </footer>

      {/* Status Bar */}
      <div className="h-6 bg-panel border-t border-border flex items-center justify-between px-3 text-[10px] text-text-dim shrink-0">
        <div className="flex items-center gap-4">
          <span>Selection: {segments.length > 0 ? `Path [${segments.length} segments]` : 'None'}</span>
          <div className="w-px h-3 bg-border" />
          <span>Status: {isAnimating ? 'Animating...' : 'Editing'}</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono uppercase">Zoom: {Math.round(zoom * 100)}%</span>
          <div className="w-px h-3 bg-border" />
          <span className="font-mono uppercase uppercase">Viewport: {svgRef.current ? `${Math.round(svgRef.current.clientWidth)}x${Math.round(svgRef.current.clientHeight)}` : 'Responsive'}</span>
        </div>
      </div>

      {showAdminPanel && (
        <AdminPanel onClose={() => setShowAdminPanel(false)} />
      )}
    </div>
  );
}
