export const GENERATE_VIDEO_NAME = 'GenerateVideo'

export const GENERATE_VIDEO_DESCRIPTION = `Generate a short video from a text prompt (optionally guided by reference images) using the user's configured video endpoint (volcengine Ark / Seedance). Works regardless of the main chat model.

Use this when the user asks to create/make a VIDEO / 短视频 / 动画片段 / 动态画面.

This tool is ASYNC and non-blocking: it queues the task and returns IMMEDIATELY with a task ID (it does NOT wait). Generation runs in the background and can take minutes; progress and the final playable video appear in the right-side "产物预览 → 视频队列" (Artifact Preview → Video Queue) panel. After calling, tell the user it was queued and where to watch it — do NOT claim it is finished, and do NOT call again for the same request while it generates. Multiple tasks run concurrently. If not configured, returns an error.

Parameters:
- "prompt": detailed description — subject, motion, camera movement, mood, lighting.
- "firstFrame" (optional): first-frame image to animate from (image-to-video, e.g. "让这张图动起来").
- "lastFrame" (optional): last-frame image; set with firstFrame to interpolate motion between two key frames (model-dependent).
- "referenceImages" (optional): extra style/subject reference images.
  (image inputs accept http(s) URL, codelf-artifact:// URL, absolute or workspace-relative path)
- "resolution" (optional): "480p" | "720p" | "1080p". Defaults to configured.
- "duration" (optional): length in seconds (e.g. 5). Defaults to configured.
- "ratio" (optional): aspect ratio like "16:9", "9:16", "1:1". Defaults to configured.
- "generateAudio" (optional): also generate audio (model-dependent; usually costs more).`
