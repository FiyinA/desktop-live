const { ipcRenderer, shell } = require('electron')

// Forward console output to terminal
const _origLog = console.log.bind(console)
const _origError = console.error.bind(console)
console.log = (...args) => { _origLog(...args); ipcRenderer.send('log', 'log', ...args) }
console.error = (...args) => { _origError(...args); ipcRenderer.send('log', 'error', ...args) }

// Catch unhandled promise rejections so they don't crash the renderer
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason)
  e.preventDefault()
})

// Keep the GPU compositor alive with a 1×1 off-screen canvas that draws every
// animation frame. Canvas draw calls go directly through the GPU pipeline —
// Chromium cannot drop the backing store while the GPU is actively compositing.
// This works in both dev and packaged exe (unlike offsetHeight which is CPU-only).
;(function keepGPUAlive() {
  const canvas = document.createElement('canvas')
  canvas.width = 1; canvas.height = 1
  canvas.style.cssText = 'position:fixed;top:-2px;left:-2px;opacity:0;pointer-events:none'
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  let tick = 0
  function draw() {
    ctx.fillStyle = (tick++ & 1) ? '#ffffff' : '#fffffe'
    ctx.fillRect(0, 0, 1, 1)
  }
  // rAF keeps GPU alive at vsync rate
  ;(function raf() { draw(); requestAnimationFrame(raf) })()
  // setInterval backup: fires even if rAF is blocked by the audio thread
  setInterval(draw, 32)
})()

// ─── State ────────────────────────────────────────────────────────────────────
let isLive = false
let isMuted = false
let settingsOpen = false
let selectedSourceId = null

let geminiSession = null
let screenStream = null
let micStream = null
let frameInterval = null
let audioContext = null
let micProcessor = null

let sourceDisplayMap = {}   // sourceId -> displayIndex
let currentUserMsg = null   // active user transcript bubble
let currentAiMsg = null     // active AI transcript bubble

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const startBtn = document.getElementById('startBtn')
const btnIcon = document.getElementById('btnIcon')
const btnText = document.getElementById('btnText')
const transcriptBox = document.getElementById('transcriptBox')
const emptyState = document.getElementById('emptyState')
const apiKeyInput = document.getElementById('apiKeyInput')
const errorToast = document.getElementById('errorToast')
const gearBtn = document.getElementById('gearBtn')
const settingsPanel = document.getElementById('settingsPanel')
const micBtn = document.getElementById('micBtn')
const screenBtn = document.getElementById('screenBtn')
const fileBtn = document.getElementById('fileBtn')
const textInput = document.getElementById('textInput')
const screenPicker = document.getElementById('screenPicker')
const chatPanel = document.getElementById('chatPanel')
const chatToggleBtn = document.getElementById('chatToggleBtn')
const chatToggleText = document.getElementById('chatToggleText')
const chatToggleIcon = document.getElementById('chatToggleIcon')

// Load saved API key
const savedKey = localStorage.getItem('gemini_api_key')
if (savedKey) apiKeyInput.value = savedKey

apiKeyInput.addEventListener('change', () => {
  localStorage.setItem('gemini_api_key', apiKeyInput.value)
})

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  if (settingsOpen && !settingsPanel.contains(e.target) && e.target !== gearBtn) {
    settingsOpen = false
    settingsPanel.classList.remove('open')
    gearBtn.classList.remove('open')
  }
  if (screenPicker.classList.contains('open') &&
      !screenPicker.contains(e.target) && e.target !== screenBtn) {
    screenPicker.classList.remove('open')
  }
})

// ─── Settings Toggle ──────────────────────────────────────────────────────────
function toggleSettings() {
  settingsOpen = !settingsOpen
  settingsPanel.classList.toggle('open', settingsOpen)
  gearBtn.classList.toggle('open', settingsOpen)
  if (settingsOpen) setTimeout(() => apiKeyInput.focus(), 260)
}

// ─── Chat Panel Toggle ────────────────────────────────────────────────────────
const COMPACT_HEIGHT = 200   // titlebar + start btn + toggle row + toolbar
const EXPANDED_HEIGHT = 620

let chatVisible = false

// Start in compact mode
ipcRenderer.send('resize-window', COMPACT_HEIGHT)

function toggleChat() {
  chatVisible = !chatVisible
  chatPanel.classList.toggle('hidden', !chatVisible)
  chatToggleText.textContent = chatVisible ? 'Hide Chat' : 'Show Chat'
  chatToggleIcon.textContent = chatVisible ? '▴' : '▾'
  ipcRenderer.send('resize-window', chatVisible ? EXPANDED_HEIGHT : COMPACT_HEIGHT)
}

// ─── UI State Machine ─────────────────────────────────────────────────────────
function setState(state) {
  switch (state) {
    case 'idle':
      startBtn.className = 'start-btn'
      btnIcon.textContent = '▶'
      btnText.textContent = 'Start Live'
      micBtn.classList.remove('active', 'muted')
      ipcRenderer.send('hide-overlay')
      ipcRenderer.send('overlay-pulse', '')
      break

    case 'active':
    case 'listening':
      startBtn.className = 'start-btn live'
      btnIcon.textContent = '■'
      btnText.textContent = 'Stop Live'
      if (!isMuted) micBtn.classList.add('active')
      ipcRenderer.send('show-overlay')
      ipcRenderer.send('overlay-pulse', 'active listening')
      break

    case 'speaking':
      startBtn.className = 'start-btn live'
      btnIcon.textContent = '■'
      btnText.textContent = 'Stop Live'
      ipcRenderer.send('overlay-pulse', 'active speaking')
      break
  }
}

// ─── Transcript ───────────────────────────────────────────────────────────────
function addMessage(type, text) {
  if (emptyState && emptyState.parentNode) emptyState.remove()

  const msg = document.createElement('div')
  msg.className = `msg ${type}`
  msg.textContent = text
  transcriptBox.appendChild(msg)
  transcriptBox.scrollTop = transcriptBox.scrollHeight
  return msg
}

// Append transcript chunk to running bubble.
// A new bubble is only created when the speaker changes — not on turnComplete —
// so background-noise micro-turns don't fragment Gemini's text into separate bubbles.
function appendTranscript(type, text) {
  // Speaker switched: seal the other side's bubble
  if (type === 'user' && currentAiMsg) currentAiMsg = null
  if (type === 'ai' && currentUserMsg) currentUserMsg = null

  const current = type === 'user' ? currentUserMsg : currentAiMsg
  if (current) {
    current.textContent += ' ' + text.trim()
  } else {
    const msg = addMessage(type, text)
    if (type === 'user') currentUserMsg = msg
    else currentAiMsg = msg
  }
  transcriptBox.scrollTop = transcriptBox.scrollHeight
}

function resetTranscriptBubbles() {
  currentUserMsg = null
  currentAiMsg = null
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
    if (!settingsOpen) toggleSettings()
    showError('Please enter your Gemini API key first')
    return
  }

  try {
    addMessage('system', '— Starting session —')
    setState('active')
    isLive = true
    isMuted = false

    await startScreenCapture()
    await startMicrophone()
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
  isMuted = false
  setState('idle')

  if (frameInterval) { clearInterval(frameInterval); frameInterval = null }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null }
  if (micProcessor) { micProcessor.disconnect(); micProcessor = null }
  if (audioContext) { audioContext.close(); audioContext = null }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }

  if (playCtx) {
    try { playCtx.close() } catch (e) {}
    playCtx = null
    nextPlayTime = 0
  }

  if (geminiSession) {
    try { geminiSession.close() } catch (e) {}
    geminiSession = null
  }

  resetTranscriptBubbles()
  addMessage('system', '— Session ended —')
}

// ─── Mic Mute ─────────────────────────────────────────────────────────────────
function toggleMute() {
  if (!isLive) return
  isMuted = !isMuted
  if (isMuted) {
    micBtn.classList.remove('active')
    micBtn.classList.add('muted')
  } else {
    micBtn.classList.remove('muted')
    micBtn.classList.add('active')
  }
}

// ─── Screen Picker ────────────────────────────────────────────────────────────
async function pickScreen() {
  const sources = await ipcRenderer.invoke('get-screen-source')

  sourceDisplayMap = {}
  sources.forEach(s => { sourceDisplayMap[s.id] = s.bounds })

  const items = sources.map(s =>
    `<div class="screen-picker-item${selectedSourceId === s.id ? ' selected' : ''}"
          onclick="selectSource('${s.id}')">${s.name}</div>`
  ).join('')

  screenPicker.innerHTML = `<div class="screen-picker-title">Select Screen</div>${items}`
  screenPicker.classList.toggle('open')
}

async function selectSource(sourceId) {
  selectedSourceId = sourceId
  screenPicker.classList.remove('open')

  const bounds = sourceDisplayMap[sourceId]
  if (bounds) ipcRenderer.send('set-overlay-screen', bounds)

  if (isLive && screenStream) {
    screenStream.getTracks().forEach(t => t.stop())
    if (frameInterval) { clearInterval(frameInterval); frameInterval = null }
    screenStream = null
    await startScreenCapture()
    startSendingScreenFrames()
  }
}

// ─── File Upload ──────────────────────────────────────────────────────────────
async function uploadFile() {
  const file = await ipcRenderer.invoke('open-file-dialog')
  if (!file) return

  if (!geminiSession) {
    showError('Start a Live session first to send files')
    return
  }

  geminiSession.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: `Here is the content of "${file.name}":\n\n${file.content}` }] }],
    turnComplete: true
  })
  addMessage('system', `— File sent: ${file.name} —`)
}

// ─── Text Message ─────────────────────────────────────────────────────────────
function sendTextMessage() {
  const text = textInput.value.trim()
  if (!text) return

  if (!geminiSession) {
    showError('Start a Live session first')
    return
  }

  geminiSession.sendClientContent({
    turns: [{ role: 'user', parts: [{ text }] }],
    turnComplete: true
  })
  addMessage('user', text)
  textInput.value = ''
}

function handleTextKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendTextMessage()
  }
}

// ─── Screen Capture ───────────────────────────────────────────────────────────
async function startScreenCapture() {
  const sources = await ipcRenderer.invoke('get-screen-source')

  if (!sources || sources.length === 0) {
    throw new Error('No screen sources found')
  }

  // Always refresh display map so overlay positioning is always accurate
  sources.forEach(s => { sourceDisplayMap[s.id] = s.bounds })

  const sourceId = selectedSourceId || sources[0].id
  if (!selectedSourceId) selectedSourceId = sources[0].id

  // Move overlay to the selected screen
  const bounds = sourceDisplayMap[sourceId]
  if (bounds) ipcRenderer.send('set-overlay-screen', bounds)

  screenStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 1280,
        maxHeight: 720,
        maxFrameRate: 1
      }
    }
  })

  console.log('Screen capture started')
}

// ─── Microphone ───────────────────────────────────────────────────────────────
async function startMicrophone() {
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
  micProcessor = audioContext.createScriptProcessor(4096, 1, 1)

  micProcessor.onaudioprocess = (event) => {
    if (!isLive || !geminiSession || isMuted) return

    const inputData = event.inputBuffer.getChannelData(0)
    const pcm16 = float32ToInt16(inputData)

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
}

// ─── Gemini Live API Connection ───────────────────────────────────────────────
async function connectGemini(apiKey) {
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
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {}
  }

  geminiSession = await ai.live.connect({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    config,
    callbacks: {
      onopen: () => {
        console.log('Gemini session opened')
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

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const video = document.createElement('video')

  video.srcObject = screenStream
  video.play().catch(e => console.error('Screen video play failed:', e))

  frameInterval = setInterval(async () => {
    if (!isLive || !geminiSession) return

    try {
      canvas.width = video.videoWidth || 1280
      canvas.height = video.videoHeight || 720
      ctx.drawImage(video, 0, 0)

      const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
      const base64 = dataUrl.split(',')[1]

      geminiSession.sendRealtimeInput({
        video: { data: base64, mimeType: 'image/jpeg' }
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

  if (message.data) {
    setState('speaking')
    playAudioChunk(message.data)
  }

  if (message.serverContent) {
    const content = message.serverContent

    if (content.inputTranscription) {
      appendTranscript('user', content.inputTranscription.text)
    }
    if (content.outputTranscription) {
      appendTranscript('ai', content.outputTranscription.text)
    }
    if (content.turnComplete) {
      setState('listening')
    }
  }
}

// ─── Audio Playback ───────────────────────────────────────────────────────────
let playCtx = null
let nextPlayTime = 0

function playAudioChunk(base64Audio) {
  if (!playCtx || playCtx.state === 'closed') {
    playCtx = new AudioContext({ sampleRate: 24000 })
    nextPlayTime = 0
  }

  const binary = atob(base64Audio)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

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

  const startAt = Math.max(nextPlayTime, playCtx.currentTime + 0.02)
  source.start(startAt)
  nextPlayTime = startAt + audioBuffer.duration

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
