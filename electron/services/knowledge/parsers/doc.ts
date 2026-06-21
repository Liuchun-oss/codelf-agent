// 老式二进制 .doc 解析：word-extractor 只能可靠提取正文纯文本，
// 表格结构基本丢失。建议用户尽量转存为 .docx 以保留表格。
import WordExtractor from 'word-extractor'

export async function parseDoc(path: string): Promise<string> {
  const extractor = new WordExtractor()
  const doc = await extractor.extract(path)
  return doc.getBody() ?? ''
}
