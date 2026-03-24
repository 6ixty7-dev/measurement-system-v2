// ─── MediaPipe Landmark Indices ───────────────────────────────────────────────
export const LM = {
  NOSE:0, LEFT_EAR:7, RIGHT_EAR:8,
  LEFT_SHOULDER:11, RIGHT_SHOULDER:12,
  LEFT_ELBOW:13, RIGHT_ELBOW:14,
  LEFT_WRIST:15, RIGHT_WRIST:16,
  LEFT_HIP:23, RIGHT_HIP:24,
  LEFT_KNEE:25, RIGHT_KNEE:26,
  LEFT_ANKLE:27, RIGHT_ANKLE:28,
};

function dist2D(a, b) {
  return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
}
function mid(a, b) { return {x:(a.x+b.x)/2, y:(a.y+b.y)/2}; }
function px(lm, w, h) { return {x: lm.x*w, y: lm.y*h}; }

// ─── Pose Quality Evaluator ───────────────────────────────────────────────────
// Returns { score: 0-100, issue: key for voice, message: display string }
export function evaluatePose(lm, w, h, angle) {
  const keyPoints = angle === 'front' || angle === 'back'
    ? [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_ANKLE, LM.RIGHT_ANKLE]
    : [LM.LEFT_SHOULDER, LM.RIGHT_HIP, LM.LEFT_ANKLE];

  const allVisible = keyPoints.every(i => (lm[i]?.visibility || 0) > 0.45);
  if (!allVisible) return { score: 0, issue: 'full_body', message: '📷 Full body not visible' };

  let score = 30;

  // Check body fills frame vertically (head to ankle)
  const nose = lm[LM.NOSE];
  const la = lm[LM.LEFT_ANKLE], ra = lm[LM.RIGHT_ANKLE];
  const footY = ((la?.y||0) + (ra?.y||0)) / 2;
  const bodyH = Math.abs(footY - (nose?.y||0));

  if (bodyH > 0.78) score += 20;
  else if (bodyH > 0.60) { score += 10; }
  else if (bodyH < 0.45) return { score: 5, issue: 'move_closer', message: '🔍 Move closer' };
  else return { score: 15, issue: 'full_body', message: '🔍 Step back — show full body' };

  // Check centering
  const ls = lm[LM.LEFT_SHOULDER], rs = lm[LM.RIGHT_SHOULDER];
  const lh = lm[LM.LEFT_HIP], rh = lm[LM.RIGHT_HIP];
  const midX = ((ls?.x||0.5) + (rs?.x||0.5) + (lh?.x||0.5) + (rh?.x||0.5)) / 4;
  if (Math.abs(midX - 0.5) < 0.09) score += 25;
  else if (Math.abs(midX - 0.5) < 0.16) score += 12;
  else return {
    score: 20,
    issue: midX < 0.5 ? 'move_right' : 'move_left',
    message: midX < 0.5 ? '➡️ Move right' : '⬅️ Move left'
  };

  // For front/back: check shoulder level
  if (angle === 'front' || angle === 'back') {
    const tilt = Math.abs((ls?.y||0) - (rs?.y||0));
    if (tilt < 0.03) score += 25;
    else if (tilt < 0.07) score += 12;
    else return { score: 35, issue: 'stand_straight', message: '⚖️ Level your shoulders' };
  } else {
    score += 25; // side views don't need symmetry check
  }

  if (score >= 90) return { score, issue: null, message: '✅ Perfect — analysing...' };
  if (score >= 70) return { score, issue: 'hold_still', message: '👍 Hold still...' };
  return { score, issue: 'stand_straight', message: '🧍 Stand straight' };
}

// ─── Measurement Computer ─────────────────────────────────────────────────────
// Takes captured landmark sets from each angle and computes real measurements
// Uses front + side data together for 3D-approximate circumferences
export function computeAllMeasurements(captures, heightCm) {
  const front = captures.front;
  const right = captures.right;
  const back  = captures.back;
  const left  = captures.left;

  if (!front) return null;

  // Calibration: pixels per cm using height from front view
  const calibPxCm = getCalibration(front.lm, heightCm, front.h);
  if (calibPxCm <= 0) return null;

  const c = calibPxCm;

  // Helper to get pixel landmark from a capture
  const p = (cap, id) => cap ? px(cap.lm[id], cap.w, cap.h) : null;

  // ── Front view landmarks ──
  const fLS = p(front, LM.LEFT_SHOULDER);
  const fRS = p(front, LM.RIGHT_SHOULDER);
  const fLH = p(front, LM.LEFT_HIP);
  const fRH = p(front, LM.RIGHT_HIP);
  const fLK = p(front, LM.LEFT_KNEE);
  const fRK = p(front, LM.RIGHT_KNEE);
  const fLA = p(front, LM.LEFT_ANKLE);
  const fRA = p(front, LM.RIGHT_ANKLE);
  const fLE = p(front, LM.LEFT_ELBOW);
  const fLW = p(front, LM.LEFT_WRIST);
  const fLS2= p(front, LM.RIGHT_ELBOW);

  // ── Side view landmarks (use right if available, else left) ──
  const side = right || left;
  const sLS  = side ? p(side, LM.LEFT_SHOULDER)  : null;
  const sRS  = side ? p(side, LM.RIGHT_SHOULDER) : null;
  const sLH  = side ? p(side, LM.LEFT_HIP)       : null;
  const sRH  = side ? p(side, LM.RIGHT_HIP)       : null;

  // ── Width measurements (front view) ──
  const frontChestW   = fLS && fRS ? dist2D(fLS, fRS) / c : 0;
  const frontWaistW   = (fLS && fRS && fLH && fRH)
    ? dist2D(mid(fLS,fRS), mid(fLH,fRH)) * 0.38 / c + frontChestW * 0.6
    : frontChestW * 0.85;
  const frontHipW     = fLH && fRH ? dist2D(fLH, fRH) / c : 0;

  // ── Depth measurements (side view) — this is the 3D improvement ──
  // On side view, the "width" between shoulders gives us the body depth
  const sideDepthChest = (sLS && sRS) ? dist2D(sLS, sRS) / c : frontChestW * 0.62;
  const sideDepthHip   = (sLH && sRH) ? dist2D(sLH, sRH) / c : frontHipW  * 0.68;
  const sideDepthWaist = sideDepthChest * 0.82;

  // ── 3D Circumference using ellipse perimeter approximation ──
  // C ≈ π * (3(a+b) - sqrt((3a+b)(a+3b)))  — Ramanujan approximation
  const ellipse = (a, b) => {
    const h = ((a-b)**2) / ((a+b)**2);
    return Math.PI * (a+b) * (1 + (3*h)/(10 + Math.sqrt(4-3*h)));
  };

  const bust  = ellipse(frontChestW/2,  sideDepthChest/2).toFixed(1);
  const waist = ellipse(frontWaistW/2,  sideDepthWaist/2).toFixed(1);
  const hip   = ellipse(frontHipW/2,    sideDepthHip/2).toFixed(1);
  const under_bust = (parseFloat(bust) * 0.88).toFixed(1);

  // ── Linear measurements (front view) ──
  const shoulder_width = fLS && fRS ? (dist2D(fLS, fRS) / c).toFixed(1) : '0';
  const sleeve_length  = (fLS && fLE && fLW)
    ? ((dist2D(fLS, fLE) + dist2D(fLE, fLW)) / c * 1.04).toFixed(1) : '0';
  const garment_length = (fLS && fRS && fLA && fRA)
    ? (dist2D(mid(fLS,fRS), mid(fLA,fRA)) / c * 0.73).toFixed(1) : '0';
  const back_length    = (fLS && fRS && fLH && fRH)
    ? (dist2D(mid(fLS,fRS), mid(fLH,fRH)) / c * 0.64).toFixed(1) : '0';

  // ── Lower body ──
  const inseam = (fLH && fLA)
    ? (dist2D(mid(fLH,fRH||fLH), mid(fLA,fRA||fLA)) / c * 0.91).toFixed(1) : '0';
  const thigh  = (fLH && fLK)
    ? (dist2D(fLH, fLK) / c * 1.72).toFixed(1) : '0';
  const knee   = (fLK && fLA)
    ? (dist2D(fLK, fLA) / c * 0.42).toFixed(1) : '0';
  const calf   = (fLK && fLA)
    ? (dist2D(fLK, fLA) / c * 0.38).toFixed(1) : '0';
  const ankle  = fLA && fRA
    ? (dist2D(fLA, fRA) / c * 2.3).toFixed(1) : '0';
  const rise   = (fLH && fLK)
    ? (dist2D(mid(fLH,fRH||fLH), mid(fLK,fRK||fLK)) / c * 0.46).toFixed(1) : '0';
  const collar = fLS && fRS
    ? (dist2D(fLS, fRS) / c * 0.54).toFixed(1) : '0';

  return {
    bust, waist, hip, under_bust,
    shoulder_width, sleeve_length, garment_length, back_length,
    inseam, thigh, knee, calf, ankle, rise, collar,
  };
}

function getCalibration(lm, heightCm, canvasH) {
  const nose = lm[LM.NOSE];
  const la   = lm[LM.LEFT_ANKLE];
  const ra   = lm[LM.RIGHT_ANKLE];
  if (!nose || !la || !ra) return 0;
  const footY  = (la.y + ra.y) / 2;
  const bodyPx = Math.abs(footY - nose.y) * canvasH;
  // 92% of height is nose-to-floor typically
  return bodyPx / (heightCm * 0.92);
}

// ─── Average frames within one angle's capture ───────────────────────────────
export function averageLandmarks(frames) {
  if (!frames.length) return null;
  const n = frames.length;
  const avg = frames[0].map((lm, i) => ({
    x: frames.reduce((s,f) => s + f[i].x, 0) / n,
    y: frames.reduce((s,f) => s + f[i].y, 0) / n,
    z: frames.reduce((s,f) => s + (f[i].z||0), 0) / n,
    visibility: frames.reduce((s,f) => s + (f[i].visibility||0), 0) / n,
  }));
  return avg;
}
