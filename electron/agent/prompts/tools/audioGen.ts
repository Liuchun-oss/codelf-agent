export const GENERATE_SPEECH_NAME = 'GenerateSpeech'

export const GENERATE_SPEECH_DESCRIPTION = `Synthesize speech audio from text (text-to-speech) using the user's configured speech endpoint (volcengine / Doubao TTS). Works regardless of the main chat model.

Use this when the user asks to read text aloud / 配音 / 文字转语音 / 生成语音 / 朗读 / TTS / 旁白.

This tool is synchronous: it calls the endpoint and returns once the audio is saved (usually a few seconds). The result is a playable audio artifact shown in the UI; do NOT paste the long artifact URL back in your reply.

Parameters:
- "text": the text to speak (required). Keep a single request reasonably short (roughly under ~300 Chinese characters) for best quality.
- "voice" (optional): preset voice id (voice_type), e.g. "zh_female_qingxin". Defaults to the configured voice.
- "speed" (optional): speech rate, 0.5–2.0 (1.0 = normal). Defaults to configured.
- "format" (optional): output format "mp3" | "wav" | "ogg_opus" | "pcm". Defaults to configured.

Note: voice cloning from a reference audio is NOT supported by this tool yet — only preset voices. If the endpoint is not configured, this returns an error.`
