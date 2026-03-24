// ─── Voice Assistant ──────────────────────────────────────────────────────────
// Uses browser built-in Text-to-Speech (no API needed)
// Falls back silently if TTS not supported

let currentLang = 'en';
let isSpeaking = false;
let speechQueue = [];
let processingQueue = false;

export function setVoiceLang(lang) {
  currentLang = lang;
}

// All messages in both languages
const MESSAGES = {
  en: {
    welcome:        "Welcome to TailorBee. I will guide you through your measurements.",
    selectGarment:  "Please select the garment you want to measure for.",
    enterHeight:    "Please enter your height for accurate calibration.",
    startScan:      "Let's begin. I will capture 4 angles automatically. No need to touch the phone.",
    front_start:    "Stand straight, facing the camera. Keep your arms slightly away from your body.",
    front_good:     "Good. Hold still.",
    front_done:     "Front captured. Now slowly turn to your right side.",
    right_start:    "Stand sideways with your right side facing the camera.",
    right_good:     "Good. Hold still.",
    right_done:     "Right side captured. Now turn to face away from the camera.",
    back_start:     "Stand with your back facing the camera. Stand straight.",
    back_good:      "Good. Hold still.",
    back_done:      "Back captured. Now turn to your left side.",
    left_start:     "Stand sideways with your left side facing the camera.",
    left_good:      "Good. Hold still.",
    left_done:      "All angles captured. Calculating your measurements.",
    complete:       "Your measurements are ready. Share these with your tailor.",
    move_closer:    "Please move a little closer.",
    move_back:      "Please step back a little.",
    move_left:      "Please move slightly to the left.",
    move_right:     "Please move slightly to the right.",
    stand_straight: "Please stand straight.",
    full_body:      "Make sure your full body from head to feet is visible.",
    hold_still:     "Almost there. Please hold still.",
    processing:     "Capturing this angle. Please hold still.",
  },
  ml: {
    welcome:        "ടെയ്‌ലർബി-ലേക്ക് സ്വാഗതം. ഞാൻ നിങ്ങളുടെ അളവുകൾ എടുക്കാൻ സഹായിക്കും.",
    selectGarment:  "ദയവായി വസ്ത്രം തിരഞ്ഞെടുക്കൂ.",
    enterHeight:    "കൃത്യമായ അളവുകൾക്ക് നിങ്ങളുടെ ഉയരം നൽകൂ.",
    startScan:      "ആരംഭിക്കുന്നു. 4 ദിശകളിൽ നിന്ന് ഞാൻ സ്വയം പകർത്തും. ഫോൺ തൊടേണ്ട ആവശ്യമില്ല.",
    front_start:    "നേരെ നിൽക്കൂ, ക്യാമറയ്ക്ക് അഭിമുഖമായി. കൈകൾ ശരീരത്തിൽ നിന്ന് അൽപ്പം അകത്തി പിടിക്കൂ.",
    front_good:     "നല്ലത്. അനങ്ങാതെ നിൽക്കൂ.",
    front_done:     "മുൻഭാഗം ശേഖരിച്ചു. ഇപ്പോൾ വലത്തോട്ട് തിരിയൂ.",
    right_start:    "വലത് വശം ക്യാമറയ്ക്ക് നേരെ ആക്കി നിൽക്കൂ.",
    right_good:     "നല്ലത്. അനങ്ങാതെ നിൽക്കൂ.",
    right_done:     "വലത് വശം ശേഖരിച്ചു. ഇനി പുറകോട്ട് തിരിയൂ.",
    back_start:     "പുറം ക്യാമറയ്ക്ക് നേരെ ആക്കി നേരെ നിൽക്കൂ.",
    back_good:      "നല്ലത്. അനങ്ങാതെ നിൽക്കൂ.",
    back_done:      "പുറഭാഗം ശേഖരിച്ചു. ഇപ്പോൾ ഇടത്തോട്ട് തിരിയൂ.",
    left_start:     "ഇടത് വശം ക്യാമറയ്ക്ക് നേരെ ആക്കി നിൽക്കൂ.",
    left_good:      "നല്ലത്. അനങ്ങാതെ നിൽക്കൂ.",
    left_done:      "എല്ലാ ദിശകളും ശേഖരിച്ചു. അളവുകൾ കണക്കാക്കുന്നു.",
    complete:       "നിങ്ങളുടെ അളവുകൾ തയ്യാർ. ഇവ നിങ്ങളുടെ തയ്യൽക്കാരനുമായി പങ്കിടൂ.",
    move_closer:    "അൽപ്പം അടുത്തേക്ക് വരൂ.",
    move_back:      "അൽപ്പം പിറകോട്ട് നിൽക്കൂ.",
    move_left:      "അൽപ്പം ഇടത്തോട്ട് നീങ്ങൂ.",
    move_right:     "അൽപ്പം വലത്തോട്ട് നീങ്ങൂ.",
    stand_straight: "നേരെ നിൽക്കൂ.",
    full_body:      "തല മുതൽ കാൽ വരെ ക്യാമറയിൽ കാണണം.",
    hold_still:     "ഏതാണ്ട് ആയി. അനങ്ങാതെ നിൽക്കൂ.",
    processing:     "ഈ ദിശ പകർത്തുന്നു. അനങ്ങാതെ നിൽക്കൂ.",
  }
};

export function speak(key, force = false) {
  if (!window.speechSynthesis) return;
  const msg = MESSAGES[currentLang]?.[key] || MESSAGES['en']?.[key];
  if (!msg) return;
  speakText(msg, force);
}

export function speakText(text, force = false) {
  if (!window.speechSynthesis) return;
  if (force) {
    window.speechSynthesis.cancel();
    speechQueue = [];
    processingQueue = false;
  }
  speechQueue.push(text);
  if (!processingQueue) processQueue();
}

function processQueue() {
  if (!speechQueue.length) { processingQueue = false; return; }
  processingQueue = true;
  const text = speechQueue.shift();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = currentLang === 'ml' ? 'ml-IN' : 'en-IN';
  utt.rate = 0.92;
  utt.pitch = 1.0;
  utt.volume = 1.0;

  // Pick best available voice
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    currentLang === 'ml'
      ? v.lang.startsWith('ml')
      : v.lang.startsWith('en-IN') || v.lang.startsWith('en-GB')
  ) || voices.find(v => v.lang.startsWith('en'));
  if (preferred) utt.voice = preferred;

  utt.onend = () => setTimeout(processQueue, 120);
  utt.onerror = () => setTimeout(processQueue, 120);
  window.speechSynthesis.speak(utt);
}

export function stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  speechQueue = [];
  processingQueue = false;
}
