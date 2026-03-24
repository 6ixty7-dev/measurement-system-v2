import { useState, useRef, useEffect, useCallback } from "react";
import { GARMENTS, MEASUREMENT_LABELS } from "./garments.js";
import { LM, evaluatePose, computeAllMeasurements, averageLandmarks } from "./poseEngine.js";
import { speak, speakText, stopSpeaking, setVoiceLang } from "./voice.js";
import { analyzeMeasurements, isGeminiEnabled } from "./geminiClient.js";

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
  bg:"#0a0a0a", surface:"#141414", card:"#1c1c1c", border:"#252525",
  gold:"#FFD700", amber:"#FFA726", green:"#66BB6A", red:"#EF5350",
  text:"#f0f0f0", muted:"#6a6a6a",
};

// ─── Scan angles in order ─────────────────────────────────────────────────────
const ANGLES = [
  { key:"front", label:"Front",      emoji:"🧍",  icon:"↕",  startKey:"front_start",  doneKey:"front_done"  },
  { key:"right", label:"Right Side", emoji:"🧍‍♂️", icon:"→",  startKey:"right_start",  doneKey:"right_done"  },
  { key:"back",  label:"Back",       emoji:"🧍",  icon:"↕",  startKey:"back_start",   doneKey:"back_done"   },
  { key:"left",  label:"Left Side",  emoji:"🧍‍♀️", icon:"←",  startKey:"left_start",  doneKey:"left_done"   },
];

// How many consecutive high-quality frames before auto-capturing
const FRAMES_NEEDED    = 45;   // ~1.5 seconds of good pose
const MIN_SCORE        = 78;   // minimum pose quality to count
const FRAMES_PER_ANGLE = 20;   // frames averaged for final measurement

// ─── Shared styles ────────────────────────────────────────────────────────────
const S = {
  page:  { maxWidth:480, margin:"0 auto", padding:"20px 16px 48px", display:"flex", flexDirection:"column", gap:14, minHeight:"100vh", animation:"fadeUp 0.3s ease" },
  card:  { background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:16 },
  btn:   { background:C.gold, color:"#111", border:"none", borderRadius:12, padding:"15px 20px", fontSize:16, fontWeight:700, cursor:"pointer", width:"100%", transition:"opacity 0.2s" },
  btn2:  { background:C.card, color:C.text, border:`1px solid ${C.border}`, borderRadius:12, padding:"13px 20px", fontSize:15, fontWeight:600, cursor:"pointer" },
  back:  { background:"none", border:"none", color:C.muted, fontSize:14, cursor:"pointer", alignSelf:"flex-start" },
  label: { fontSize:11, fontWeight:700, color:C.muted, letterSpacing:"0.1em", textTransform:"uppercase", display:"block", marginBottom:8 },
  hint:  { fontSize:12, color:C.muted, marginTop:6, lineHeight:1.5 },
};

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const poseRef     = useRef(null);
  const cameraRef   = useRef(null);
  const streamRef   = useRef(null);
  const goodFrames  = useRef(0);
  const capFrames   = useRef([]);
  const captures    = useRef({});

  const [screen,       setScreen]       = useState("home");
  const [lang,         setLang]         = useState("en");
  const [garment,      setGarment]      = useState(null);
  const [height,       setHeight]       = useState("");
  const [facingMode,   setFacingMode]   = useState("user"); // user=front, environment=back
  const [mpLoaded,     setMpLoaded]     = useState(false);
  const [camLoading,   setCamLoading]   = useState(false);
  const [angleIdx,     setAngleIdx]     = useState(0);
  const [poseScore,    setPoseScore]    = useState(0);
  const [guidance,     setGuidance]     = useState("");
  const [fillPct,      setFillPct]      = useState(0); // 0-100 progress ring for auto-capture
  const [capturing,    setCapturing]    = useState(false);
  const [measurements, setMeasurements] = useState(null);
  const [aiText,       setAiText]       = useState("");
  const [lastVoice,    setLastVoice]    = useState("");

  // ── Poll for MediaPipe ────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => { if (window.Pose) { setMpLoaded(true); clearInterval(t); } }, 300);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { setVoiceLang(lang); }, [lang]);

  // ── Camera start ──────────────────────────────────────────────────────────
  const startCamera = useCallback(async (facing = facingMode) => {
    if (!window.Pose) return;
    setCamLoading(true);

    // Stop existing stream
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    cameraRef.current?.stop?.();
    poseRef.current?.close?.();

    const pose = new window.Pose({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`,
    });
    pose.setOptions({
      modelComplexity: 1, smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.6, minTrackingConfidence: 0.6,
    });

    pose.onResults(results => {
      const canvas = canvasRef.current;
      const video  = videoRef.current;
      if (!canvas || !video) return;
      const ctx = canvas.getContext("2d");
      const W   = canvas.width  = video.videoWidth  || 640;
      const H   = canvas.height = video.videoHeight || 480;

      // Draw mirrored if front camera
      ctx.save();
      if (facing === "user") { ctx.scale(-1,1); ctx.drawImage(results.image, -W, 0, W, H); }
      else ctx.drawImage(results.image, 0, 0, W, H);
      ctx.restore();

      const lm = results.poseLandmarks;
      if (!lm) {
        goodFrames.current = 0;
        setPoseScore(0);
        setFillPct(0);
        setGuidance("📷 Stand in front of the camera");
        return;
      }

      const currentAngle = ANGLES[angleIdx]?.key || "front";
      const { score, issue, message } = evaluatePose(lm, W, H, currentAngle);
      setPoseScore(score);

      // Draw skeleton
      drawSkeleton(ctx, lm, W, H, facing === "user");

      if (score >= MIN_SCORE && !capturing) {
        goodFrames.current++;
        capFrames.current.push(lm);
        if (capFrames.current.length > FRAMES_PER_ANGLE * 2) capFrames.current.shift();

        const pct = Math.min(100, Math.round(goodFrames.current / FRAMES_NEEDED * 100));
        setFillPct(pct);

        if (goodFrames.current === 5) {
          setGuidance(message);
          if (issue === null) { voiceOnce("hold_still"); }
        }
        if (goodFrames.current === Math.floor(FRAMES_NEEDED * 0.5)) {
          setGuidance("✅ Almost there — hold still...");
          voiceOnce("processing");
        }
        if (goodFrames.current >= FRAMES_NEEDED) {
          // AUTO CAPTURE
          triggerCapture(lm, W, H, currentAngle);
        }
      } else {
        goodFrames.current = Math.max(0, goodFrames.current - 2);
        setFillPct(Math.max(0, Math.round(goodFrames.current / FRAMES_NEEDED * 100)));
        setGuidance(message);
        if (issue) voiceOnce(issue);
      }
    });

    poseRef.current = pose;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facing,
          width: { ideal: 640 }, height: { ideal: 480 },
        },
      });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await new Promise(res => { videoRef.current.onloadedmetadata = res; });
      videoRef.current.play();

      const camera = new window.Camera(videoRef.current, {
        onFrame: async () => { await pose.send({ image: videoRef.current }); },
        width: 640, height: 480,
      });
      camera.start();
      cameraRef.current = camera;
      setCamLoading(false);
    } catch (e) {
      setGuidance("⚠️ Camera access denied. Please allow camera and refresh.");
      setCamLoading(false);
    }
  }, [facingMode, angleIdx, capturing]);

  const stopCamera = useCallback(() => {
    cameraRef.current?.stop?.();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    poseRef.current?.close?.();
    goodFrames.current = 0;
    capFrames.current  = [];
  }, []);

  // ── Swap camera ───────────────────────────────────────────────────────────
  const swapCamera = () => {
    const newFacing = facingMode === "user" ? "environment" : "user";
    setFacingMode(newFacing);
    goodFrames.current = 0;
    setFillPct(0);
    startCamera(newFacing);
  };

  // ── Auto-capture trigger ──────────────────────────────────────────────────
  const triggerCapture = useCallback((lm, W, H, angleKey) => {
    if (capturing) return;
    setCapturing(true);
    goodFrames.current = 0;

    // Store averaged landmarks for this angle
    const averaged = averageLandmarks(capFrames.current.slice(-FRAMES_PER_ANGLE));
    captures.current[angleKey] = { lm: averaged, w: W, h: H };
    capFrames.current = [];

    const doneKey = ANGLES.find(a => a.key === angleKey)?.doneKey;
    speak(doneKey, true);

    const nextIdx = ANGLES.findIndex(a => a.key === angleKey) + 1;

    setTimeout(() => {
      setCapturing(false);
      setFillPct(0);

      if (nextIdx < ANGLES.length) {
        setAngleIdx(nextIdx);
        const nextAngle = ANGLES[nextIdx];
        speak(nextAngle.startKey, false);
        setGuidance(`Turn to face your ${nextAngle.label}`);
      } else {
        // All 4 angles done — compute
        finalizeMeasurements();
      }
    }, 1800);
  }, [capturing]);

  const finalizeMeasurements = useCallback(async () => {
    speak("complete", true);
    stopCamera();
    const heightCm = parseFloat(height) || 165;
    const result   = computeAllMeasurements(captures.current, heightCm);
    setMeasurements(result);
    setScreen("results");

    if (isGeminiEnabled() && garment && result) {
      const g = GARMENTS[garment];
      const relevant = {};
      g.measurements.forEach(k => { if (result[k]) relevant[k] = result[k]; });
      const ai = await analyzeMeasurements(g.label, relevant, lang);
      if (ai) {
        setAiText(ai);
        speakText(ai);
      }
    }
  }, [height, garment, lang, stopCamera]);

  // ── Voice dedup (don't repeat same line) ─────────────────────────────────
  const voiceOnce = (key) => {
    if (lastVoice === key) return;
    setLastVoice(key);
    speak(key);
    setTimeout(() => setLastVoice(""), 4000);
  };

  // ── Skeleton draw ─────────────────────────────────────────────────────────
  function drawSkeleton(ctx, lm, W, H, mirrored) {
    const connections = [
      [11,12],[11,13],[13,15],[12,14],[14,16],
      [11,23],[12,24],[23,24],
      [23,25],[25,27],[24,26],[26,28],
    ];
    const pt = i => ({
      x: (mirrored ? 1-lm[i].x : lm[i].x) * W,
      y: lm[i].y * H,
    });
    ctx.strokeStyle = "#FFD70088"; ctx.lineWidth = 2.5;
    connections.forEach(([a,b]) => {
      if ((lm[a]?.visibility||0) > 0.4 && (lm[b]?.visibility||0) > 0.4) {
        ctx.beginPath(); ctx.moveTo(pt(a).x, pt(a).y); ctx.lineTo(pt(b).x, pt(b).y); ctx.stroke();
      }
    });
    ctx.fillStyle = "#FF6B35";
    Object.values(LM).forEach(i => {
      if ((lm[i]?.visibility||0) > 0.4) {
        ctx.beginPath(); ctx.arc(pt(i).x, pt(i).y, 4, 0, 2*Math.PI); ctx.fill();
      }
    });
  }

  // ─── Screen router ────────────────────────────────────────────────────────
  return (
    <div style={{ background:C.bg, minHeight:"100vh" }}>
      {screen === "home"    && <HomeScreen    lang={lang} setLang={setLang} setScreen={setScreen} />}
      {screen === "garment" && <GarmentScreen setScreen={setScreen} setGarment={setGarment} />}
      {screen === "setup"   && (
        <SetupScreen
          setScreen={setScreen} garment={garment} height={height} setHeight={setHeight}
          mpLoaded={mpLoaded} lang={lang}
          onStart={() => {
            captures.current = {};
            setAngleIdx(0);
            setMeasurements(null);
            setAiText("");
            goodFrames.current = 0;
            setFillPct(0);
            setScreen("scan");
            setTimeout(() => {
              startCamera(facingMode);
              speak("startScan", true);
              setTimeout(() => speak("front_start"), 2200);
            }, 300);
          }}
        />
      )}
      {screen === "scan" && (
        <ScanScreen
          videoRef={videoRef} canvasRef={canvasRef}
          angleIdx={angleIdx} poseScore={poseScore}
          guidance={guidance} fillPct={fillPct}
          capturing={capturing} camLoading={camLoading}
          facingMode={facingMode} swapCamera={swapCamera}
          onBack={() => { stopCamera(); stopSpeaking(); setScreen("setup"); }}
        />
      )}
      {screen === "results" && (
        <ResultsScreen
          measurements={measurements} garment={garment}
          aiText={aiText} lang={lang}
          onRemeasure={() => { setScreen("garment"); setMeasurements(null); captures.current = {}; }}
        />
      )}
    </div>
  );
}

// ─── HOME ─────────────────────────────────────────────────────────────────────
function HomeScreen({ lang, setLang, setScreen }) {
  return (
    <div style={S.page}>
      <div style={{ textAlign:"center", paddingTop:40 }}>
        <div style={{ fontSize:58 }}>🐝</div>
        <h1 style={{ fontSize:38, fontWeight:800, letterSpacing:"-1.5px", color:C.gold, margin:"10px 0 4px" }}>
          TailorBee
        </h1>
        <p style={{ fontSize:12, fontWeight:700, letterSpacing:"0.18em", textTransform:"uppercase", color:C.amber }}>
          AI Body Measurement
        </p>
        <p style={{ fontSize:14, color:C.muted, marginTop:10, lineHeight:1.6 }}>
          Stand in front of your camera.<br/>We'll guide you through 4 angles automatically.
        </p>
      </div>

      {/* Language selector */}
      <div style={S.card}>
        <span style={S.label}>🌐 Voice Language / ഭാഷ</span>
        <div style={{ display:"flex", gap:10 }}>
          {[["en","English"],["ml","മലയാളം"]].map(([l,label]) => (
            <button key={l}
              style={{ flex:1, padding:"12px 8px", borderRadius:10, border:`2px solid ${lang===l ? C.gold : C.border}`,
                background: lang===l ? "#1a1400" : C.surface, color: lang===l ? C.gold : C.muted,
                fontWeight:700, fontSize:14, cursor:"pointer", transition:"all 0.2s" }}
              onClick={() => { setLang(l); setVoiceLang(l); }}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* How it works */}
      <div style={S.card}>
        <span style={S.label}>How it works</span>
        {[
          ["1","Select your garment"],
          ["2","Enter your height"],
          ["3","Follow voice instructions — turn 4 ways"],
          ["4","Get your measurements automatically"],
        ].map(([n,t]) => (
          <div key={n} style={{ display:"flex", gap:12, alignItems:"center", marginBottom:10 }}>
            <span style={{ width:26, height:26, borderRadius:"50%", background:"#1a1400",
              border:`1px solid ${C.gold}44`, display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:12, fontWeight:800, color:C.gold, flexShrink:0 }}>{n}</span>
            <span style={{ fontSize:14, color:C.muted }}>{t}</span>
          </div>
        ))}
      </div>

      <div style={{ display:"flex", flexWrap:"wrap", gap:8, justifyContent:"center" }}>
        {["📐 3D-approximate","🔄 4 angles","🔇 No button needed","📷 Camera swap","🎙️ Voice guide"].map(f => (
          <span key={f} style={{ background:C.surface, border:`1px solid ${C.border}`,
            borderRadius:20, padding:"5px 12px", fontSize:12, color:C.muted }}>{f}</span>
        ))}
      </div>

      <button style={S.btn} onClick={() => setScreen("garment")}>Start Measuring →</button>
    </div>
  );
}

// ─── GARMENT SELECTION ────────────────────────────────────────────────────────
function GarmentScreen({ setScreen, setGarment }) {
  return (
    <div style={S.page}>
      <button style={S.back} onClick={() => setScreen("home")}>← Back</button>
      <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px" }}>Select Garment</h2>
      <p style={{ ...S.hint, margin:0 }}>We measure exactly what each garment needs.</p>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
        {Object.entries(GARMENTS).map(([key, g]) => (
          <button key={key}
            style={{ ...S.card, display:"flex", flexDirection:"column", alignItems:"center",
              gap:6, cursor:"pointer", padding:"20px 12px", transition:"border-color 0.2s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor=C.gold}
            onMouseLeave={e => e.currentTarget.style.borderColor=C.border}
            onClick={() => { setGarment(key); setScreen("setup"); }}
          >
            <span style={{ fontSize:32 }}>{g.emoji}</span>
            <span style={{ fontSize:14, fontWeight:700, color:C.text }}>{g.label}</span>
            <span style={{ fontSize:11, color:C.muted }}>{g.measurements.length} measurements</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── SETUP ────────────────────────────────────────────────────────────────────
function SetupScreen({ setScreen, garment, height, setHeight, mpLoaded, lang, onStart }) {
  const g = GARMENTS[garment];
  return (
    <div style={S.page}>
      <button style={S.back} onClick={() => setScreen("garment")}>← Back</button>
      <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px" }}>Setup</h2>

      <div style={S.card}>
        <span style={S.label}>📏 Your height in cm</span>
        <input style={{ ...S.card, background:"#111", color:C.text, fontSize:18, fontWeight:700,
          width:"100%", border:`1px solid ${C.border}`, outline:"none", padding:"12px 14px" }}
          type="number" placeholder="e.g. 162" value={height}
          onChange={e => setHeight(e.target.value)}
          onFocus={e => e.target.style.borderColor=C.gold}
          onBlur={e  => e.target.style.borderColor=C.border}
        />
        <p style={S.hint}>The more accurate your height, the more accurate your measurements.</p>
      </div>

      <div style={S.card}>
        <span style={S.label}>What we'll measure for {g?.label}</span>
        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
          {g?.measurements.map(m => (
            <span key={m} style={{ background:"#111", border:`1px solid ${C.border}`,
              borderRadius:6, padding:"4px 10px", fontSize:12, color:C.muted }}>
              {MEASUREMENT_LABELS[m]}
            </span>
          ))}
        </div>
      </div>

      <div style={{ ...S.card, background:"#0d1a0d", border:`1px solid #2a4a2a` }}>
        <span style={S.label}>🔄 How the 4-angle scan works</span>
        <div style={{ display:"flex", justifyContent:"space-between" }}>
          {ANGLES.map((a,i) => (
            <div key={a.key} style={{ textAlign:"center", flex:1 }}>
              <div style={{ fontSize:22 }}>{a.emoji}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>{a.label}</div>
              {i < 3 && <div style={{ position:"absolute" }}>→</div>}
            </div>
          ))}
        </div>
        <p style={{ ...S.hint, marginTop:12 }}>
          No touching the phone. Voice will guide you to turn after each angle is captured automatically.
        </p>
      </div>

      <div style={{ ...S.card, background:"#1a1400", border:`1px solid ${C.amber}33` }}>
        <span style={S.label}>💡 Tips for accuracy</span>
        {["Stand 1.5–2 m from camera","Wear fitted clothing — not baggy","Good lighting, no backlight","Keep arms slightly away from body"].map(t => (
          <p key={t} style={{ ...S.hint, margin:"4px 0" }}>• {t}</p>
        ))}
      </div>

      {!mpLoaded && <p style={{ textAlign:"center", color:C.muted, fontSize:13 }}>⏳ Loading AI pose engine...</p>}

      <button style={{ ...S.btn, opacity: mpLoaded ? 1 : 0.5 }} disabled={!mpLoaded} onClick={onStart}>
        {mpLoaded ? "Start 4-Angle Scan →" : "Loading..."}
      </button>
    </div>
  );
}

// ─── SCAN SCREEN ──────────────────────────────────────────────────────────────
function ScanScreen({ videoRef, canvasRef, angleIdx, poseScore, guidance, fillPct,
  capturing, camLoading, facingMode, swapCamera, onBack }) {

  const angle = ANGLES[angleIdx] || ANGLES[0];
  const scoreColor = poseScore >= MIN_SCORE ? C.green : poseScore >= 50 ? C.amber : C.red;
  const circumference = 2 * Math.PI * 44;
  const dash = circumference * fillPct / 100;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", background:"#000", position:"relative" }}>

      {/* Top bar */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 14px", background:"rgba(0,0,0,0.9)", backdropFilter:"blur(10px)", zIndex:10 }}>
        <button style={{ ...S.back, fontSize:20, color:"#fff" }} onClick={onBack}>✕</button>

        {/* Angle progress dots */}
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {ANGLES.map((a,i) => (
            <div key={a.key} style={{ display:"flex", alignItems:"center", gap:4 }}>
              <div style={{
                width: i === angleIdx ? 28 : 8,
                height: 8, borderRadius:4,
                background: i < angleIdx ? C.green : i === angleIdx ? C.gold : C.border,
                transition:"all 0.4s ease",
              }} />
            </div>
          ))}
        </div>

        {/* Camera swap button */}
        <button
          style={{ background:"rgba(255,255,255,0.1)", border:`1px solid ${C.border}`,
            borderRadius:20, padding:"6px 12px", color:"#fff", fontSize:13, fontWeight:600, cursor:"pointer" }}
          onClick={swapCamera}
        >
          {facingMode === "user" ? "🔄 Rear" : "🔄 Front"}
        </button>
      </div>

      {/* Camera */}
      <div style={{ flex:1, position:"relative", overflow:"hidden", background:"#111" }}>
        <video ref={videoRef} style={{ position:"absolute", opacity:0, width:1, height:1, pointerEvents:"none" }} />
        <canvas ref={canvasRef} style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />

        {/* Scan line */}
        {!camLoading && !capturing && (
          <div style={{ position:"absolute", left:0, right:0, height:2, pointerEvents:"none",
            background:"linear-gradient(90deg, transparent, rgba(255,215,0,0.4), transparent)",
            animation:"scanDown 2.5s linear infinite" }} />
        )}

        {/* Body outline guide */}
        <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", opacity:0.12 }}
          viewBox="0 0 100 160" preserveAspectRatio="xMidYMid meet">
          <ellipse cx="50" cy="10" rx="7" ry="8" fill="none" stroke={C.gold} strokeWidth="1"/>
          <line x1="50" y1="18" x2="50" y2="75" stroke={C.gold} strokeWidth="1"/>
          <line x1="28" y1="30" x2="72" y2="30" stroke={C.gold} strokeWidth="1"/>
          <line x1="50" y1="75" x2="38" y2="130" stroke={C.gold} strokeWidth="1"/>
          <line x1="50" y1="75" x2="62" y2="130" stroke={C.gold} strokeWidth="1"/>
        </svg>

        {/* Loading */}
        {camLoading && (
          <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column",
            alignItems:"center", justifyContent:"center", background:"rgba(0,0,0,0.85)", gap:16 }}>
            <div style={{ width:44, height:44, border:`3px solid ${C.gold}33`,
              borderTop:`3px solid ${C.gold}`, borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
            <p style={{ color:"#fff", fontSize:15 }}>Starting camera...</p>
          </div>
        )}

        {/* Capture flash */}
        {capturing && (
          <div style={{ position:"absolute", inset:0, background:"rgba(255,215,0,0.15)",
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
            animation:"popIn 0.4s ease", zIndex:5 }}>
            <div style={{ fontSize:56 }}>✅</div>
            <p style={{ color:C.gold, fontSize:18, fontWeight:800, marginTop:8 }}>
              {angle.label} captured!
            </p>
          </div>
        )}
      </div>

      {/* Auto-capture ring progress */}
      <div style={{ position:"absolute", bottom:160, right:16, zIndex:20 }}>
        <svg width={100} height={100} viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="44" fill="rgba(0,0,0,0.7)"
            stroke="rgba(255,255,255,0.1)" strokeWidth="8"/>
          <circle cx="50" cy="50" r="44" fill="none"
            stroke={fillPct >= 100 ? C.green : C.gold} strokeWidth="8"
            strokeDasharray={`${dash} ${circumference}`}
            strokeLinecap="round" transform="rotate(-90 50 50)"
            style={{ transition:"stroke-dasharray 0.15s ease" }}/>
          <text x="50" y="46" textAnchor="middle" fill={C.gold}
            fontSize="13" fontWeight="800" fontFamily="DM Sans, sans-serif">
            {fillPct < 100 ? `${fillPct}%` : "✓"}
          </text>
          <text x="50" y="62" textAnchor="middle" fill={C.muted}
            fontSize="9" fontFamily="DM Sans, sans-serif">auto</text>
        </svg>
      </div>

      {/* Pose score bar */}
      <div style={{ height:3, background:"#222" }}>
        <div style={{ height:"100%", width:`${poseScore}%`, background:scoreColor,
          transition:"width 0.2s ease, background 0.3s ease" }}/>
      </div>

      {/* Angle label + guidance */}
      <div style={{ background:"#0d0d0d", padding:"12px 16px 16px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
          <span style={{ background:"#1a1400", border:`1px solid ${C.gold}44`,
            borderRadius:20, padding:"4px 14px", fontSize:13, fontWeight:700, color:C.gold }}>
            {angleIdx+1}/4 — {angle.label}
          </span>
          <span style={{ fontSize:12, color:C.muted }}>
            Score: <span style={{ color:scoreColor, fontWeight:700 }}>{poseScore}%</span>
          </span>
        </div>
        <p style={{ fontSize:15, color:C.text, lineHeight:1.5 }}>{guidance}</p>
        <p style={{ ...S.hint, marginTop:6 }}>
          {fillPct < 100
            ? "Hold position — auto-capturing when pose is steady"
            : "Captured! Turn for next angle..."}
        </p>
      </div>
    </div>
  );
}

// ─── RESULTS ──────────────────────────────────────────────────────────────────
function ResultsScreen({ measurements, garment, aiText, lang, onRemeasure }) {
  const g = GARMENTS[garment];
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const lines = g.measurements.map(k => `${MEASUREMENT_LABELS[k]}: ${measurements?.[k]} cm`).join("\n");
    navigator.clipboard.writeText(`TailorBee — ${g.label}\n${"─".repeat(28)}\n${lines}`);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={S.page}>
      <div style={{ textAlign:"center", paddingTop:16 }}>
        <div style={{ fontSize:48 }}>🐝</div>
        <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px", margin:"8px 0 4px" }}>
          Your Measurements
        </h2>
        <p style={{ color:C.amber, fontSize:15, fontWeight:600 }}>{g?.emoji} {g?.label}</p>
      </div>

      {/* Angle coverage badges */}
      <div style={{ display:"flex", gap:8, justifyContent:"center", flexWrap:"wrap" }}>
        {ANGLES.map(a => (
          <span key={a.key} style={{ background:"#0d1a0d", border:`1px solid #2a4a2a`,
            borderRadius:20, padding:"4px 12px", fontSize:12, color:C.green }}>
            ✓ {a.label}
          </span>
        ))}
      </div>

      {aiText && (
        <div style={{ ...S.card, background:"#1a1400", border:`1px solid ${C.amber}44` }}>
          <span style={{ fontSize:11, fontWeight:700, letterSpacing:"0.1em",
            textTransform:"uppercase", color:C.amber }}>✨ AI Analysis</span>
          <p style={{ fontSize:14, color:C.text, marginTop:8, lineHeight:1.65 }}>{aiText}</p>
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
        {g?.measurements.map((key, i) => (
          <div key={key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"13px 16px", background: i%2===0 ? C.card : C.surface, borderRadius:8 }}>
            <span style={{ fontSize:14, color:C.muted, fontWeight:500 }}>{MEASUREMENT_LABELS[key]}</span>
            <span style={{ fontSize:22, fontWeight:800, color:C.gold }}>
              {measurements?.[key]}
              <span style={{ fontSize:12, fontWeight:400, color:C.muted }}> cm</span>
            </span>
          </div>
        ))}
      </div>

      <div style={{ display:"flex", gap:10 }}>
        <button style={{ ...S.btn2, flex:1 }} onClick={copy}>
          {copied ? "✅ Copied!" : "📋 Copy"}
        </button>
        <button style={{ ...S.btn, flex:2 }} onClick={onRemeasure}>Measure Again →</button>
      </div>

      <p style={{ ...S.hint, textAlign:"center", fontSize:11 }}>
        ⚡ 3D-approximate AI estimates — verify with a tape measure before final tailoring.
      </p>
    </div>
  );
}
