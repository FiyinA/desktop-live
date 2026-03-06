const { ipcRenderer, shell } = require('electron')

// Forward console output to terminal
const _origLog = console.log.bind(console)
const _origError = console.error.bind(console)
console.log = (...args) => { _origLog(...args); ipcRenderer.send('log', 'log', ...args) }
console.error = (...args) => { _origError(...args); ipcRenderer.send('log', 'error', ...args) }

// ─── State ────────────────────────────────────────────────────────────────────
let isLive = false
let geminiSession = null
let screenStream = null
let micStream = null
let frameInterval = null
let audioContext = null
let micProcessor = null

// ─── DOM refs ────────────────────────────────────────────────────────────────
const startBtn = document.getElementById('startBtn')
const btnIcon = document.getElementById('btnIcon')
const btnText = document.getElementById('btnText')
const statusCard = document.getElementById('statusCard')
const orbContainer = document.getElementById('orbContainer')
const orbIcon = document.getElementById('orbIcon')
const statusLabel = document.getElementById('statusLabel')
const waveBars = document.getElementById('waveBars')
const transcriptBox = document.getElementById('transcriptBox')
const emptyState = document.getElementById('emptyState')
const apiKeyInput = document.getElementById('apiKeyInput')
const errorToast = document.getElementById('errorToast')
const chipMic = document.getElementById('chipMic')
const chipScreen = document.getElementById('chipScreen')
const chipAI = document.getElementById('chipAI')

// Load saved API key
const savedKey = localStorage.getItem('gemini_api_key')
if (savedKey) apiKeyInput.value = savedKey

apiKeyInput.addEventListener('change', () => {
  localStorage.setItem('gemini_api_key', apiKeyInput.value)
})

// ─── UI State Machine ─────────────────────────────────────────────────────────
function setState(state) {
  // states: idle | active | listening | speaking
  statusCard.className = 'status-card'
  orbContainer.className = 'orb-container'
  statusLabel.className = 'status-label'
  waveBars.className = 'wave-bars'

  chipMic.className = 'chip'
  chipScreen.className = 'chip'
  chipAI.className = 'chip'

  switch (state) {
    case 'idle':
      orbIcon.textContent = '🎙️'
      statusLabel.textContent = 'Ready'
      startBtn.className = 'start-btn'
      btnIcon.textContent = '▶'
      btnText.textContent = 'Start Live'
      ipcRenderer.send('hide-overlay')
      ipcRenderer.send('overlay-pulse', '')
      break

    case 'active':
      statusCard.classList.add('active')
      orbContainer.classList.add('listening')
      statusLabel.classList.add('active')
      orbIcon.textContent = '🎙️'
      statusLabel.textContent = 'Listening...'
      waveBars.className = 'wave-bars'
      startBtn.className = 'start-btn active'
      btnIcon.textContent = '■'
      btnText.textContent = 'Stop Live'
      chipMic.classList.add('on')
      chipScreen.classList.add('on')
      chipAI.classList.add('on')
      ipcRenderer.send('show-overlay')
      ipcRenderer.send('overlay-pulse', 'active listening')
      break

    case 'listening':
      statusCard.classList.add('active')
      orbContainer.classList.add('listening')
      statusLabel.classList.add('active')
      orbIcon.textContent = '🎙️'
      statusLabel.textContent = 'Listening...'
      chipMic.classList.add('on')
      chipScreen.classList.add('on')
      chipAI.classList.add('on')
      ipcRenderer.send('overlay-pulse', 'active listening')
      break

    case 'speaking':
      statusCard.classList.add('speaking')
      orbContainer.classList.add('speaking')
      statusLabel.classList.add('speaking')
      orbIcon.textContent = '🔊'
      statusLabel.textContent = 'Gemini speaking...'
      waveBars.className = 'wave-bars visible'
      chipMic.classList.add('on')
      chipScreen.classList.add('on')
      chipAI.classList.add('on')
      ipcRenderer.send('overlay-pulse', 'active speaking')
      break
  }
}

// ─── Transcript ───────────────────────────────────────────────────────────────
function addMessage(type, text) {
  if (emptyState) emptyState.remove()

  const msg = document.createElement('div')
  msg.className = `msg ${type}`
  msg.textContent = text
  transcriptBox.appendChild(msg)
  transcriptBox.scrollTop = transcriptBox.scrollHeight
}

function showError(msg) {
  errorToast.textContent = msg
  errorToast.classList.add('show')
  setTimeout(() => errorToast.classList.remove('show'), 4000)
}

// ─── Toggle Live ──────────────────────────────────────────────────────────────
async function toggleLive() {
  if (isLive) {
    await stopLive()
  } else {
    await startLive()
  }
}

// ─── Start Live ───────────────────────────────────────────────────────────────
async function startLive() {
  const apiKey = apiKeyInput.value.trim()
  if (!apiKey) {
    showError('Please enter your Gemini API key first')
    apiKeyInput.focus()
    return
  }

  try {
    addMessage('system', '— Starting session —')
    setState('active')
    isLive = true

    // 1. Get screen capture
    await startScreenCapture()

    // 2. Get microphone
    await startMicrophone()

    // 3. Connect to Gemini Live API
    await connectGemini(apiKey)

    addMessage('system', '— Connected to Gemini —')

  } catch (err) {
    console.error('Failed to start:', err)
    showError(`Failed to start: ${err.message}`)
    await stopLive()
  }
}

// ─── Stop Live ────────────────────────────────────────────────────────────────
async function stopLive() {
  isLive = false
  setState('idle')

  // Stop screen capture
  if (frameInterval) {
    clearInterval(frameInterval)
    frameInterval = null
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop())
    screenStream = null
  }

  // Stop microphone
  if (micProcessor) {
    micProcessor.disconnect()
    micProcessor = null
  }
  if (audioContext) {
    audioContext.close()
    audioContext = null
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop())
    micStream = null
  }

  // Close playback audio context
  if (playCtx) {
    try { playCtx.close() } catch (e) {}
    playCtx = null
    nextPlayTime = 0
  }

  // Close Gemini session
  if (geminiSession) {
    try { geminiSession.close() } catch (e) {}
    geminiSession = null
  }

  addMessage('system', '— Session ended —')
}

// ─── Screen Capture ───────────────────────────────────────────────────────────
async function startScreenCapture() {
  const { ipcRenderer } = require('electron')

  // Get available screens via main process (desktopCapturer not available in renderer in Electron 28+)
  const sources = await ipcRenderer.invoke('get-screen-source')

  if (!sources || sources.length === 0) {
    throw new Error('No screen sources found')
  }

  // Capture the primary screen
  screenStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sources[0].id,
        maxWidth: 1280,
        maxHeight: 720,
        maxFrameRate: 1  // 1 FPS is enough for screen context
      }
    }
  })

  console.log('Screen capture started')
  chipScreen.classList.add('on')
}

// ─── Microphone ───────────────────────────────────────────────────────────────
async function startMicrophone() {
  // Create two audio contexts - one for capture (16kHz), one for playback (24kHz)
  audioContext = new AudioContext({ sampleRate: 16000 })

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const source = audioContext.createMediaStreamSource(micStream)

  // Script processor to get raw PCM chunks
  micProcessor = audioContext.createScriptProcessor(4096, 1, 1)

  micProcessor.onaudioprocess = (event) => {
    if (!isLive || !geminiSession) return

    const inputData = event.inputBuffer.getChannelData(0)

    // Convert Float32 to Int16 PCM (Gemini requires 16-bit PCM)
    const pcm16 = float32ToInt16(inputData)

    // Send audio to Gemini
    try {
      geminiSession.sendRealtimeInput({
        audio: {
          data: arrayBufferToBase64(pcm16.buffer),
          mimeType: 'audio/pcm;rate=16000'
        }
      })
    } catch (e) {
      // Session may have closed
    }
  }

  source.connect(micProcessor)
  micProcessor.connect(audioContext.destination)

  console.log('Microphone started')
  chipMic.classList.add('on')
}

// ─── Gemini Live API Connection ───────────────────────────────────────────────
async function connectGemini(apiKey) {
  // Dynamically load the Google GenAI SDK
  const { GoogleGenAI, Modality } = require('@google/genai')

  const ai = new GoogleGenAI({ apiKey })

  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: `You are a helpful desktop AI assistant with access to the user's screen.
      You can see what they're looking at and help them with tasks, answer questions,
      and provide real-time assistance. Be concise and conversational.`,
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Aoede' }
      }
    }
  }

  geminiSession = await ai.live.connect({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    config,
    callbacks: {
      onopen: () => {
        console.log('Gemini session opened')
        chipAI.classList.add('on')
        startSendingScreenFrames()
      },
      onmessage: (message) => {
        handleGeminiMessage(message)
      },
      onerror: (e) => {
        console.error('Gemini error:', e)
        showError(`Gemini error: ${e.message || 'Connection error'}`)
        stopLive()
      },
      onclose: (e) => {
        console.log('Gemini session closed:', e.code, e.reason)
        if (isLive) {
          const reason = e.reason ? `: ${e.reason}` : ` (code ${e.code})`
          showError(`Gemini session closed unexpectedly${reason}`)
          stopLive()
        }
      }
    }
  })
}

// ─── Send Screen Frames to Gemini ─────────────────────────────────────────────
function startSendingScreenFrames() {
  if (!screenStream) return

  const videoTrack = screenStream.getVideoTracks()[0]
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const video = document.createElement('video')

  video.srcObject = screenStream
  video.play()

  // Send a frame every 2 seconds (enough for context without flooding)
  frameInterval = setInterval(async () => {
    if (!isLive || !geminiSession) return

    try {
      canvas.width = video.videoWidth || 1280
      canvas.height = video.videoHeight || 720
      ctx.drawImage(video, 0, 0)

      // Get as JPEG base64
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
      const base64 = dataUrl.split(',')[1]

      // Send frame to Gemini as realtime input
      geminiSession.sendRealtimeInput({
        video: {
          data: base64,
          mimeType: 'image/jpeg'
        }
      })
    } catch (e) {
      console.error('Frame send error:', e)
    }
  }, 2000)
}

// ─── Handle Gemini Responses ──────────────────────────────────────────────────
let _debuggedFirstMessage = false
function handleGeminiMessage(message) {
  if (!_debuggedFirstMessage) {
    console.log('First Gemini message keys:', Object.keys(message))
    console.log('serverContent:', JSON.stringify(message.serverContent)?.slice(0, 300))
    _debuggedFirstMessage = true
  }

  // Audio response from Gemini
  if (message.data) {
    setState('speaking')
    playAudioChunk(message.data)
  }

  // Text transcript of what Gemini is saying
  if (message.serverContent) {
    const content = message.serverContent

    // Input transcript (what user said)
    if (content.inputTranscription) {
      addMessage('user', content.inputTranscription.text)
    }

    // Output transcript (what Gemini is saying)
    if (content.outputTranscription) {
      addMessage('ai', content.outputTranscription.text)
    }

    // Turn complete - back to listening
    if (content.turnComplete) {
      setState('listening')
    }
  }
}

// ─── Audio Playback ───────────────────────────────────────────────────────────
// Gemini returns 24kHz 16-bit PCM audio
// Uses a single persistent AudioContext with scheduled playback to avoid gaps
let playCtx = null
let nextPlayTime = 0

function playAudioChunk(base64Audio) {
  // Lazily create one AudioContext for the whole session
  if (!playCtx || playCtx.state === 'closed') {
    playCtx = new AudioContext({ sampleRate: 24000 })
    nextPlayTime = 0
  }

  // Decode base64 → bytes
  const binary = atob(base64Audio)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  // Convert Int16 PCM → Float32
  const int16 = new Int16Array(bytes.buffer)
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768
  }

  const audioBuffer = playCtx.createBuffer(1, float32.length, 24000)
  audioBuffer.copyToChannel(float32, 0)

  const source = playCtx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(playCtx.destination)

  // Schedule this chunk to start exactly when the previous one ends
  const startAt = Math.max(nextPlayTime, playCtx.currentTime + 0.02)
  source.start(startAt)
  nextPlayTime = startAt + audioBuffer.duration

  // When the last scheduled chunk ends, flip back to listening
  source.onended = () => {
    if (nextPlayTime <= playCtx.currentTime + 0.05 && isLive) {
      setState('listening')
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// ─── Window Controls ──────────────────────────────────────────────────────────
function minimize() {
  ipcRenderer.send('minimize-window')
}

function closeApp() {
  if (isLive) stopLive()
  ipcRenderer.send('close-window')
}

function openDocs() {
  ipcRenderer.send('open-external', 'https://aistudio.google.com/apikey')
}
