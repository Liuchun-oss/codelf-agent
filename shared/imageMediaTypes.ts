// Provider（OpenAI / Anthropic 系）服务端只接受这四种图片 MIME。
// 其它格式（bmp / ico / avif / tiff…）会在请求入口被整条拒绝：
//   400 "You have uploaded an unsupported image. Please make sure your image is valid
//        and has one of the following formats: webp, png, jpeg, and gif."
// 而历史里的坏图会每轮重发、每轮被拒，用户点重试永远撞同一堵墙。
// 因此这份白名单是「谁能直接外发图片」的唯一真相：读图时用它决定是否转码，
// 发送前用它做最后兜底，渲染端用它校验用户附件。
export const PROVIDER_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export function isProviderImageMime(mime: string): boolean {
  return (PROVIDER_IMAGE_MIME_TYPES as readonly string[]).includes(mime.trim().toLowerCase())
}
