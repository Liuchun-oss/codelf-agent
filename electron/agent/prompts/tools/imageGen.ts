export const GENERATE_IMAGE_NAME = 'GenerateImage'

export const GENERATE_IMAGE_DESCRIPTION = `Generate one or more images from a text prompt using the user's configured image-generation endpoint (OpenAI Images API compatible), and display them inline in the conversation.

Use this when the user asks you to create, draw, design, or illustrate an image, icon, logo, mockup, or any visual. Works regardless of the main chat model (the image endpoint is configured separately).

Behavior:
- Calls the configured image endpoint (e.g. gpt-image-1 / dall-e-3 or a compatible gateway) and saves the result locally.
- Returns markdown image references that render inline in the chat.
- If image generation is not enabled/configured, returns an error explaining the user must configure it in settings.

Usage:
- "prompt": a detailed description of the image to generate. Be specific about subject, style, composition, colors.
- "size" (optional): use "2K" (recommended default) or "4K", or an explicit large WIDTHxHEIGHT (e.g. "2048x2048", "2304x1728"). NOTE: many endpoints (e.g. Seedream) reject small sizes like 1024x1024 — prefer "2K". Defaults to the configured size.
- "n" (optional): number of images (1-4, default 1). For a coherent SET, prefer "series" instead of "n".
- "referenceImages" (optional): one or more reference images to guide generation. Provide them when the user wants image-to-image ("make a close-up of this dog"), multi-image reference / fusion ("put the outfit from image 2 onto image 1"), or design derived from a reference (e.g. a logo). Accepts http(s) URLs, codelf-artifact:// URLs of prior generated images, absolute paths, or workspace-relative paths.
- "series" (optional): set true WHENEVER the user asks for MULTIPLE related/consistent images in one request — e.g. "生成一组4张...", four seasons of the same courtyard, a brand visual kit, or one scene at morning/noon/night. This makes the model output SEPARATE images; without it a multi-image request usually returns a single collage/grid, which is wrong.
- "maxImages" (optional): with series=true, the cap on how many images to produce (1-15). Set it to the number the user asked for (e.g. 4 for "一组4张").
- "outputPath" (REQUIRED): the full output file path INCLUDING a file name and an image extension (.png/.jpg/.webp), absolute or workspace-relative, e.g. "images/icon.png". A directory-only path is rejected — you MUST give the file name. When multiple images are produced (n>1 or series), each file is auto-numbered before the extension (icon.png → icon-1.png, icon-2.png …).

Deciding automatically:
- Prompt mentions a specific count or "一组/a set/series/multiple/各一张/分别" → set series=true and maxImages to that count.
- No reference + single image → plain text-to-image.
- User gives/refers to an existing image to base the result on → put it in referenceImages.
- User asks for several related/consistent images → set series=true and a suitable maxImages.
- You can combine referenceImages + series (e.g. "using this logo, design a 5-piece brand kit").`

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
- "size"/"n": optional, same as GenerateImage.
- "outputPath" (REQUIRED): the full output file path INCLUDING a file name and an image extension (.png/.jpg/.webp), absolute or workspace-relative, e.g. "images/icon-edited.png". A directory-only path is rejected. When n>1, files are auto-numbered before the extension.`
