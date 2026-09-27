/**
 * Кольцо-прогресс озвучивателя манги.
 *
 * Тонкая обёртка над общим `OrbitProgress`: анимация орбиты, искры и конический
 * градиент теперь одни на приложение (их же использует студия видео-историй), а
 * здесь сохранены прежние testid и иконки этапов — страница, диалог, озвучка,
 * голоса, — поэтому вид и тесты озвучивателя не изменились.
 */

import { AudioLines, BookOpen, Image as ImageIcon, Sparkles } from "lucide-react";
import { OrbitProgress, type OrbitNode } from "@/components/OrbitProgress";
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

const ORBIT_NODES: readonly OrbitNode[] = [
  { Icon: ImageIcon, title: "Страница" },
  { Icon: BookOpen, title: "Диалог" },
  { Icon: AudioLines, title: "Озвучка" },
  { Icon: Sparkles, title: "Голоса" },
];

export function MangaProgressRing({ percent, label, detail, active = false, phase = "idle" }: MangaProgressRingProps) {
  return (
    <OrbitProgress
      percent={percent}
      label={label}
      detail={detail}
      active={active}
      phase={phase}
      nodes={ORBIT_NODES}
      className="manga-progress"
      testId="manga-progress"
      percentTestId="manga-percent"
      labelTestId="manga-progress-label"
      stateText={active ? "в работе" : phase === "idle" ? "готово" : "ожидание"}
    />
  );
}
