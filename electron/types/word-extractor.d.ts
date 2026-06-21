// 第三方库 word-extractor 无官方类型声明，这里给出最小化声明以满足类型检查。
declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string
    getFootnotes(): string
    getHeaders(): string
  }
  class WordExtractor {
    extract(filePath: string): Promise<WordDocument>
  }
  export = WordExtractor
}
