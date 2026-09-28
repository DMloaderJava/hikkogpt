import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const TEXT_EXT = /\.(md|markdown|txt|csv|json|xml|html|css|js|ts|tsx|jsx|py|log|yaml|yml)$/i;
export const DOCUMENT_ACCEPT = '.pdf,.md,.markdown,.txt,.csv,.json,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.log,.yaml,.yml';
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 40000;

export function isSupportedDocument(file: File): boolean {
  return file.size <= MAX_DOCUMENT_BYTES && (TEXT_EXT.test(file.name) || /\.pdf$/i.test(file.name));
}

export async function readDocument(file: File): Promise<string> {
  if (!isSupportedDocument(file)) throw new Error('Неподдерживаемый файл или размер больше 10 МБ');
  let text: string;
  if (/\.pdf$/i.test(file.name)) {
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' '));
      if (pages.join('\n').length >= MAX_DOCUMENT_CHARS) break;
    }
    text = pages.join('\n');
    await pdf.destroy();
  } else text = await file.text();
  if (!text.trim()) throw new Error('В файле нет извлекаемого текста (скан PDF не поддерживается)');
  return `[Файл: ${file.name.replace(/\[/g, "_").replace(/\]/g, "_").replace(/[\n\r]/g, '_')}]\n${text.slice(0, MAX_DOCUMENT_CHARS)}${text.length > MAX_DOCUMENT_CHARS ? '\n[Текст обрезан]' : ''}\n[/Файл]`;
}
