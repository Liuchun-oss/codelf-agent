export const GENERATE_IMAGE_NAME = 'GenerateImage'

export const GENERATE_IMAGE_DESCRIPTION = `Generate one or more images from a text prompt using the user's configured image-generation endpoint (OpenAI Images API compatible), and display them inline in the conversation.

Use this when the user asks you to create, draw, design, or illustrate an image, icon, logo, mockup, or any visual. Works regardless of the main chat model (the image endpoint is configured separately).

Behavior:
- Calls the configured image endpoint (e.g. gpt-image-1 / dall-e-3 or a compatible gateway) and saves the result locally.
- Returns markdown image references that render inline in the chat.
- If image generation is not enabled/configured, returns an error explaining the user must configure it in settings.

Usage:
- "prompt": a detailed description of the image to generate. Be specific about subject, style, composition, colors.
- "size" (optional): e.g. "1024x1024", "1024x1536", "1536x1024", or "auto". Defaults to the configured size.
- "n" (optional): number of images (1-4, default 1).`

export const EDIT_IMAGE_NAME = 'EditImage'

export const EDIT_IMAGE_DESCRIPTION = `Edit or refine an EXISTING image based on a text instruction, using the user's configured image endpoint (OpenAI Images Edit API). Use this for iterative tweaks to a previously generated image — e.g. "make the bottle half-empty", "change the label text", "make it warmer" — so the result stays close to the original instead of redrawing from scratch.

When to use vs GenerateImage:
- Use GenerateImage to create a brand-new image from scratch.
- Use EditImage when the user wants to adjust/modify an image that already exists (e.g. the one you just generated). This preserves the original composition.

Behavior:
- Sends the source image(s) plus your instruction to the edit endpoint and returns the edited image inline.
- Requires a model that supports image editing (e.g. gpt-image-1). dall-e-3 does NOT support editing.

Usage:
- "imageRefs": one or more references to the source image(s). Use the codelf-artifact:// URL of a previously generated image (from a GenerateImage/EditImage result), an absolute file path, or a workspace-relative path. To tweak the image you just made, pass its markdown URL.
- "prompt": the edit instruction describing what to change.
- "size"/"n": optional, same as GenerateImage.`
