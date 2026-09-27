/**
 * Кольцо-прогресс озвучивателя манги.
 *
 * Повторяет процесс-анимацию из дизайн-примера: конический градиент показывает
 * процент, вокруг него вращаются иконки этапов (страница, диалог, озвучка,
 * искра), рядом мерцают точки. Всё на токенах темы приложения, поэтому в светлой
 * теме выглядит так же уместно, как в тёмной.
 */

import { AudioLines, BookOpen, Image as ImageIcon, Sparkles } from "lucide-react";
import type { MangaPhase } from "@/hooks/useMangaVoice";

interface MangaProgressRingProps {
  /** 0..100. */
  percent: number;
  /** Подпись этапа: «Этап 3 из 5 · Анализ диалога». */
  label: string;
  /** Детали: «Батч 2 из 3 · обработано 5 из 12 страниц». */
  detail?: string;
  /** Крутить ли орбиту и показывать ли «живое» состояние. */
  active?: boolean;
  phase?: MangaPhase;
}

const ORBIT_ICONS = [
  { Icon: ImageIcon, className: "manga-orb one", title: "Страница" },
  { Icon: BookOpen, className: "manga-orb two", title: "Диалог" },
  { Icon: AudioLines, className: "manga-orb three", title: "Озвучка" },
  { Icon: Sparkles, className: "manga-orb four", title: "Голоса" },
] as const;

export function MangaProgressRing({ percent, label, detail, active = false, phase = "idle" }: MangaProgressRingProps) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));

  return (
    <div className="manga-progress" data-testid="manga-progress" data-phase={phase} data-active={active ? "true" : "false"}>
      <div className={`manga-orbit${active ? " is-active" : ""}`} aria-hidden="true">
        <div className="manga-ring" />
        <div className="manga-orbiting">
          {ORBIT_ICONS.map(({ Icon, className, title }) => (
            <span key={title} className={className} title={title}>
              <Icon className="h-4 w-4" />
            </span>
          ))}
        </div>
        <Sparkles className="manga-sparkle a h-3 w-3" aria-hidden="true" />
        <Sparkles className="manga-sparkle b h-3 w-3" aria-hidden="true" />
      </div>

      <div className="manga-progress-ring" style={{ ["--manga-progress" as string]: `${value}%` }}>
        <div className="manga-progress-inner">
          <span className="manga-percent" data-testid="manga-percent">
            {value}%
          </span>
          <span className="manga-progress-label">{active ? "в работе" : phase === "idle" ? "готово" : "ожидание"}</span>
        </div>
      </div>

      <div className="manga-progress-text">
        <p className="manga-progress-title" data-testid="manga-progress-label">
          {label}
        </p>
        {detail && <p className="manga-progress-detail">{detail}</p>}
      </div>
    </div>
  );
}
