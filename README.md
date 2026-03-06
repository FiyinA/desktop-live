# Desktop Live 🎙️

A Windows desktop app that lets you talk to Gemini AI with live screen sharing.
Blue border glows around your screen when Live is active.

## Features
- 🔵 Blue glowing border around screen when Live is on
- 🎙️ Real-time voice conversation with Gemini
- 🖥️ Screen sharing — Gemini sees what you see
- 🔊 Gemini responds with voice
- 💬 Live transcript of conversation

## Setup

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Install dependencies
```
cd desktop-live
npm install
```

### 3. Get a Gemini API Key
Go to https://aistudio.google.com/apikey and create a free key

### 4. Run the app
```
npm start
```

### 5. Build as single .exe
```
npm run build
```
Output will be in `dist/` folder

## How to use
1. Paste your Gemini API key in the input box
2. Click **Start Live**
3. Blue border appears around your screen
4. Talk naturally — Gemini hears you and sees your screen
5. Gemini responds with voice
6. Click **Stop Live** to end the session

## Project Structure
```
desktop-live/
  src/
    main/
      main.js        — Electron main process, window management
    renderer/
      index.html     — Main UI
      renderer.js    — All live logic (screen capture, mic, Gemini API)
      overlay.html   — Blue border overlay window
  package.json
```

## How it works
- **Screen capture**: Electron's `desktopCapturer` API grabs screen frames
- **Microphone**: Web Audio API captures mic as 16kHz PCM audio
- **Gemini Live API**: WebSocket connection streams audio + screen frames
- **Blue border**: Transparent always-on-top Electron window with CSS border
- **Voice output**: 24kHz PCM audio from Gemini played via Web Audio API
