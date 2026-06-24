export const GENERATE_VIDEO_NAME = 'GenerateVideo'

export const GENERATE_VIDEO_DESCRIPTION = `Generate a short video from a text prompt (optionally guided by reference images) using the user's configured video-generation endpoint (volcengine Ark / Seedance, async task API), then display it inline in the conversation as a playable video.

Use this when the user asks you to create, make, or generate a VIDEO / 短视频 / 动画片段 / 动态画面. Works regardless of the main chat model (the video endpoint is configured separately in settings).

IMPORTANT: Video generation is SLOW and asynchronous — it submits a task and polls until done, which can take from tens of seconds to several minutes. The tool reports progress while waiting. Do not call it repeatedly for the same request; one call handles the whole submit→poll→download flow.

Modes (decide automatically from the user's request):
- Text-to-video: provide only "prompt".
- Image-to-video (first frame): set "firstFrame" to an image to animate from. Use when the user says "让这张图动起来" / "make this image move" / "用这张图生成视频".
- First + last frame: set both "firstFrame" and "lastFrame" to interpolate a motion between two key images (model-dependent).
- Reference-guided: put extra style/subject reference images in "referenceImages".

Usage:
- "prompt": detailed description of the video. Describe subject, motion, camera movement, mood, lighting.
- "firstFrame" (optional): reference image for the first frame. http(s) URL, codelf-artifact:// URL of a prior generated image, absolute path, or workspace-relative path.
- "lastFrame" (optional): reference image for the last frame (first+last frame mode).
- "referenceImages" (optional): additional reference image(s).
- "resolution" (optional): "480p", "720p", or "1080p". Defaults to the configured value.
- "duration" (optional): length in seconds (e.g. 5). Defaults to the configured value.
- "ratio" (optional): aspect ratio like "16:9", "9:16", "1:1". Defaults to the configured value.
- "generateAudio" (optional): set true to also generate audio (model-dependent; usually costs more).

Behavior:
- Returns a markdown video reference that renders inline as a playable <video> player.
- If video generation is not enabled/configured, returns an error explaining the user must configure it in settings.`
