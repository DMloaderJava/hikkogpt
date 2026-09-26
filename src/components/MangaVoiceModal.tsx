import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { blobToDataURL } from '@/lib/imageAttachments';
import { getEdgeAuthHeaders } from '@/lib/edgeAuth';
import { AudioPlayer } from '@/components/AudioPlayer';

const endpoint = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
type Page = { file: File; url: string; description?: string; transcript?: string; audio?: string };

export function MangaVoiceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => () => { pagesRef.current.forEach(p => { URL.revokeObjectURL(p.url); if (p.audio) URL.revokeObjectURL(p.audio); }); }, []);
  if (!open) return null;

  const add = (files: FileList | null) => {
    const selected = Array.from(files || []).filter(f => ['image/png', 'image/jpeg', 'image/webp'].includes(f.type) && f.size <= 10 * 1024 * 1024);
    if (selected.length !== files?.length) setError('Поддерживаются PNG, JPEG и WebP до 10 МБ');
    setPages(prev => [...prev, ...selected.map(file => ({ file, url: URL.createObjectURL(file) }))]);
  };
  const request = async (path: string, body: unknown) => {
    const res = await fetch(`${endpoint}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await getEdgeAuthHeaders()) }, body: JSON.stringify(body) });
    if (!res.ok) { const info = await res.json().catch(() => ({})); throw new Error(info.error || `Ошибка ${res.status}`); }
    return res;
  };
  const analyze = async () => {
    const start = pages.findIndex(p => p.description === undefined);
    if (start < 0) return;
    setBusy(true); setError('');
    try {
      const batch = pages.slice(start, start + 5);
      const res = await request('manga-analyze', { images: await Promise.all(batch.map(p => blobToDataURL(p.file))) });
      const data = await res.json();
      setPages(prev => prev.map((p, i) => i >= start && i < start + batch.length ? { ...p, ...data.pages[i - start] } : p));
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка анализа'); }
    finally { setBusy(false); }
  };
  const speak = async (index: number) => {
    setBusy(true); setError('');
    try {
      const res = await request('dialog-tts', { transcript: pages[index].transcript });
      const url = URL.createObjectURL(await res.blob());
      setPages(prev => prev.map((p, i) => { if (i !== index) return p; if (p.audio) URL.revokeObjectURL(p.audio); return { ...p, audio: url }; }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка озвучки'); }
    finally { setBusy(false); }
  };
  const next = pages.findIndex(p => p.description === undefined);
  return <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-background/70 backdrop-blur-sm">
    <div className="w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border bg-background p-4 shadow-xl">
      <div className="flex justify-between items-center"><h2 className="font-semibold">Озвучиватель манги</h2><button onClick={onClose} aria-label="Закрыть"><X /></button></div>
      <p className="text-xs text-muted-foreground my-2">Загрузите страницы по порядку. Анализируйте по 5 изображений, затем добавляйте следующие. Каждая страница получит описание, реплики и отдельную озвучку.</p>
      <input aria-label="Страницы манги" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { add(e.target.files); e.target.value = ''; }} className="w-full text-sm" />
      {pages.length > 0 && <button disabled={busy || next < 0} onClick={analyze} className="my-3 rounded-lg bg-interactive text-interactive-foreground px-4 py-2 text-sm disabled:opacity-50">{busy ? <Loader2 className="animate-spin" /> : next < 0 ? 'Все страницы обработаны' : `Анализировать страницы ${next + 1}–${Math.min(next + 5, pages.length)}`}</button>}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="space-y-4">{pages.map((p, i) => <div key={p.url} className="rounded-xl border p-3"><p className="text-sm font-medium mb-2">Страница {i + 1}</p><img src={p.url} alt={`Страница манги ${i + 1}`} className="max-h-96 w-full object-contain" />{p.description !== undefined && <><p className="text-sm my-2">{p.description}</p><textarea aria-label={`Реплики страницы ${i + 1}`} value={p.transcript} onChange={e => setPages(prev => prev.map((item, n) => n === i ? { ...item, transcript: e.target.value } : item))} rows={4} className="w-full rounded-lg bg-secondary p-2 text-sm" /><button disabled={busy || !p.transcript?.trim()} onClick={() => speak(i)} className="rounded-lg bg-interactive text-interactive-foreground px-3 py-2 text-sm disabled:opacity-50">Озвучить кадр</button>{p.audio && <AudioPlayer src={p.audio} fileName={`manga-page-${i + 1}.wav`} />}</>}</div>)}</div>
    </div>
  </div>;
}
