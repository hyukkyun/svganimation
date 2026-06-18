const assert = require('assert');

function isSmooth(oppDX, oppDY, curDX, curDY) {
  const oppLen = Math.sqrt(oppDX*oppDX + oppDY*oppDY);
  const curLen = Math.sqrt(curDX*curDX + curDY*curDY);
  if (oppLen > 0.05 && curLen > 0.05) {
      const angleOpp = Math.atan2(oppDY, oppDX);
      const angleCur = Math.atan2(curDY, curDX);
      const diff = Math.abs(angleOpp - angleCur);
      const modDiff = Math.abs(diff - Math.PI) % (2 * Math.PI);
      if (modDiff < 0.005 || Math.abs(modDiff - 2 * Math.PI) < 0.005) {
         return true;
      }
  }
  return false;
}

// 90 degrees
console.log("90 deg: ", isSmooth(0, -1, 1, 0)); // false
console.log("180 deg: ", isSmooth(-1, 0, 1, 0)); // true
console.log("-90 deg: ", isSmooth(0, -1, -1, 0)); // false
console.log("same dir: ", isSmooth(1, 0, 1, 0)); // false

// exactly what the user might have: vertical UP vs down-right
console.log("vertical up vs down-right: ", isSmooth(0, -1, 1, 1)); // false
